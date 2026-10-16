import type { ModelSelection, SDKCustomTool, SDKCustomToolResult, SDKJsonValue, SDKMessage } from "@cursor/sdk";
import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import {
  type AgentRunEvent,
  type AgentRunOptions,
  type AgentRunResult,
  buildSubagentPrompt,
  type WorkflowAgentOptions,
} from "./agent.js";

// ── SDK seam ───────────────────────────────────────────────

/** The slice of `@cursor/sdk` this backend uses. The real module satisfies it; tests inject a fake. */
export interface CursorSdkModule {
  readonly Agent: { create(options: CursorAgentOptions): Promise<CursorAgent> };
  readonly Cursor: { readonly models: { list(): Promise<readonly { readonly id: string }[]> } };
  readonly AuthenticationError: new (message: string) => Error;
}

export interface CursorAgentOptions {
  readonly model: ModelSelection;
  readonly local: { readonly cwd: string; readonly customTools: Record<string, SDKCustomTool> };
}

export interface CursorAgent {
  send(message: string): Promise<CursorRun>;
  close(): void | Promise<void>;
}

export interface CursorRun {
  stream(): AsyncIterable<SDKMessage>;
  wait(): Promise<{
    readonly status: string;
    readonly result?: unknown;
    readonly error?: { readonly message: string };
  }>;
  cancel(): void | Promise<void>;
}

let sdkModule: Promise<CursorSdkModule> | undefined;

/** Load `@cursor/sdk` once per process, on the first cursor agent. Host runs never reach this. */
function loadCursorSdk(): Promise<CursorSdkModule> {
  sdkModule ??= import("@cursor/sdk");
  return sdkModule;
}

// ── Options ────────────────────────────────────────────────

export interface CursorSdkAgentOptions extends Pick<WorkflowAgentOptions, "cwd" | "instructions"> {
  /** Loads the SDK. Defaults to a lazy `import("@cursor/sdk")`; tests inject a fake here. */
  loadSdk?: () => Promise<CursorSdkModule>;
}

const STRUCTURED_OUTPUT = "structured_output";
const CURSOR_PREFIX = "cursor/";
const MAX_LISTED_MODELS = 60;

// ── Model resolution ───────────────────────────────────────

/**
 * Resolve the first selector Cursor offers. Omitted means Cursor's `default` model.
 * A `cursor/` prefix is accepted and stripped.
 */
async function resolveCursorModel(
  sdk: CursorSdkModule,
  selectors: string | readonly string[] | undefined,
): Promise<string> {
  if (selectors === undefined) return "default";
  const candidates = (typeof selectors === "string" ? [selectors] : selectors).map((selector) =>
    selector.startsWith(CURSOR_PREFIX) ? selector.slice(CURSOR_PREFIX.length) : selector,
  );
  const available = (await sdk.Cursor.models.list()).map((model) => model.id);
  const match = candidates.find((id) => available.includes(id));
  if (match !== undefined) return match;
  const listed = available.slice(0, MAX_LISTED_MODELS).join(", ");
  const more = available.length > MAX_LISTED_MODELS ? ` (+${available.length - MAX_LISTED_MODELS} more)` : "";
  throw new Error(`No usable Cursor model: ${candidates.join(", ")}. Available: ${listed}${more}`);
}

function modelSelection(id: string, params: Record<string, string> | undefined): ModelSelection {
  if (params === undefined) return { id };
  return { id, params: Object.entries(params).map(([name, value]) => ({ id: name, value })) };
}

// ── Structured output ──────────────────────────────────────

interface StructuredCapture {
  called: boolean;
  value: unknown;
}

function isJsonValue(value: unknown): value is SDKJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

/** The schema as the JSON object Cursor's custom tools accept. */
function toJsonSchema(schema: TSchema): Record<string, SDKJsonValue> {
  const json: unknown = JSON.parse(JSON.stringify(schema));
  if (isJsonValue(json) && typeof json === "object" && json !== null && !Array.isArray(json)) return json;
  throw new TypeError("structured output schema must be a JSON object");
}

/**
 * The `structured_output` tool. Cursor does not validate custom-tool arguments, so the schema check
 * runs here with the same validator the host uses. Invalid arguments return an error result so the
 * model can call the tool again.
 */
function structuredOutputTool(schema: TSchema, capture: StructuredCapture): SDKCustomTool {
  const tool: Tool = {
    name: STRUCTURED_OUTPUT,
    description: "Return the final machine-readable result for this subagent task.",
    parameters: schema,
  };
  return {
    description: tool.description,
    inputSchema: toJsonSchema(schema),
    execute(args, context): SDKCustomToolResult {
      let value: unknown;
      try {
        value = validateToolArguments(tool, {
          type: "toolCall",
          id: context.toolCallId ?? STRUCTURED_OUTPUT,
          name: STRUCTURED_OUTPUT,
          arguments: args,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text }], isError: true };
      }
      capture.value = value;
      capture.called = true;
      return "Recorded.";
    },
  };
}

// ── Event mapping ──────────────────────────────────────────

function resultText(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? "";
}

/**
 * Map Cursor SDK messages to the run events the workflow store reads. Assistant messages are text deltas,
 * so `text` carries the accumulated text so far. A tool gets `tool_start` once, then `tool_end` when it completes.
 */
export function createCursorEventMapper(model: string): (message: SDKMessage) => AgentRunEvent[] {
  const started = new Set<string>();
  let accumulated = "";

  return (message: SDKMessage): AgentRunEvent[] => {
    switch (message.type) {
      case "assistant": {
        const delta = message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
        if (!delta) return [];
        accumulated += delta;
        return [{ type: "text", text: accumulated }];
      }
      case "tool_call": {
        const events: AgentRunEvent[] = [];
        if (!started.has(message.call_id)) {
          started.add(message.call_id);
          events.push({ type: "tool_start", id: message.call_id, name: message.name, args: message.args ?? {} });
        }
        if (message.status === "running") return events;
        events.push({
          type: "tool_end",
          id: message.call_id,
          name: message.name,
          result: resultText(message.result),
          isError: message.status === "error",
        });
        return events;
      }
      case "usage": {
        const tokens = message.usage.totalTokens;
        return tokens > 0 ? [{ type: "usage", tokens, model }] : [];
      }
      default:
        return [];
    }
  };
}

// ── Runner ─────────────────────────────────────────────────

/** Adds the `(set CURSOR_API_KEY)` hint to authentication failures; other errors pass through. */
function cursorError(sdk: CursorSdkModule, error: unknown): unknown {
  if (error instanceof sdk.AuthenticationError) return new Error(`${error.message} (set CURSOR_API_KEY)`);
  return error;
}

interface DriveInput {
  readonly sdk: CursorSdkModule;
  readonly agent: CursorAgent;
  readonly prompt: string;
  readonly model: string;
  readonly schema: TSchema | undefined;
  readonly capture: StructuredCapture;
  readonly options: AgentRunOptions<TSchema | undefined>;
}

/** Send the prompt, stream its events, and return the run's result. */
async function drive({ agent, prompt, model, schema, capture, options }: DriveInput): Promise<unknown> {
  const run = await agent.send(prompt);
  const signal = options.signal;
  const onAbort = () => {
    Promise.resolve(run.cancel()).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const mapEvents = createCursorEventMapper(model);
  let lastText = "";
  try {
    for await (const message of run.stream()) {
      for (const event of mapEvents(message)) {
        if (event.type === "text") lastText = event.text;
        options.onEvent?.(event);
      }
    }
    const outcome = await run.wait();
    if (signal?.aborted) throw new Error("Subagent was aborted");
    if (outcome.status !== "finished") {
      throw new Error(outcome.error?.message || "Cursor run failed");
    }
    if (schema) {
      if (!capture.called) throw new Error("Subagent finished without calling structured_output");
      return capture.value;
    }
    return typeof outcome.result === "string" ? outcome.result : lastText;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs a subagent as a Cursor SDK local agent. Events, abort, and the structured output contract
 * match `WorkflowAgent`, so the workflow treats both backends the same.
 */
export class CursorSdkAgent {
  private readonly cwd: string;
  private readonly instructions?: string;
  private readonly loadSdk: () => Promise<CursorSdkModule>;

  constructor(options: CursorSdkAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.instructions = options.instructions;
    this.loadSdk = options.loadSdk ?? loadCursorSdk;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const sdk = await this.loadSdk();
    const schema = options.schema;
    const capture: StructuredCapture = { called: false, value: undefined };
    const customTools: Record<string, SDKCustomTool> = {};
    if (schema) customTools[STRUCTURED_OUTPUT] = structuredOutputTool(schema, capture);

    const fullPrompt = buildSubagentPrompt(prompt, {
      instructions: [this.instructions, options.instructions],
      label: options.label,
      structured: schema !== undefined,
    });

    try {
      const model = await resolveCursorModel(sdk, options.model);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      options.onEvent?.({ type: "start", prompt: fullPrompt, model: `cursor-sdk/${model}` });

      const agent = await sdk.Agent.create({
        model: modelSelection(model, options.modelParams),
        local: { cwd: this.cwd, customTools },
      });
      try {
        const result = await drive({
          sdk,
          agent,
          prompt: fullPrompt,
          model: `cursor-sdk/${model}`,
          schema,
          capture,
          options,
        });
        return result as AgentRunResult<TSchemaDef>;
      } finally {
        await agent.close();
      }
    } catch (error) {
      throw cursorError(sdk, error);
    }
  }
}
