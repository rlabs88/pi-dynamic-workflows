import { randomUUID } from "node:crypto";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { isOmpHost, resolveAgentModel } from "./model-selector.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

// ── Event types ────────────────────────────────────────────

export type AgentRunEvent =
  | { type: "start"; prompt: string; model?: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; tokens: number; model?: string };

// ── Options ────────────────────────────────────────────────

/** Which host runs the agent. omp resolves selectors itself (`modelPattern`); pi resolves exact selectors here. */
export type AgentHost = "omp" | "pi";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /** Run id for omp subagent identity. */
  runId?: string;
  /** Session factory; defaults to `createAgentSession`. */
  createSession?: WorkflowSessionFactory;
  /** Model selection path. Defaults to the detected host; tests set it explicitly. */
  host?: AgentHost;
}

/** The subset of an agent session the runner uses. */
export interface WorkflowSession {
  readonly messages: readonly unknown[];
  /** The model the session runs on. omp sets it after resolving `modelPattern`; undefined means no match. */
  readonly model?: { readonly id: string };
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
}

/** Session options plus omp-only keys (pi ignores them): subagent identity and the pattern omp resolves. */
export type WorkflowSessionOptions = CreateAgentSessionOptions & {
  agentId?: string;
  taskDepth?: number;
  modelPattern?: string | string[];
};

export type WorkflowSessionFactory = (
  options: WorkflowSessionOptions,
) => Promise<{ session: WorkflowSession; modelFallbackMessage?: string }>;

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  agentId?: string;
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  /** Subagent model: a `provider/modelId[:thinking]` selector, a model name, or an omp role. Arrays are fallbacks. */
  model?: string | readonly string[];
  signal?: AbortSignal;
  /** Event subscription for the agent's lifecycle. */
  onEvent?: (event: AgentRunEvent) => void;
  /** Receives host notices, such as omp reporting that it fell back to another model. */
  onNotice?: (message: string) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

// ── Session event mapper ───────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const total = num(usage.totalTokens);
  if (total !== undefined) return total;
  return (num(usage.input) ?? 0) + (num(usage.output) ?? 0);
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text") {
      const text = str(block.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Create a stateful mapper from raw session events (`session.subscribe`) to AgentRunEvents.
 * Text deltas accumulate per assistant message; each `text` event carries the full text so far.
 */
export function createSessionEventMapper(): (event: unknown) => AgentRunEvent[] {
  let text = "";

  return (event: unknown): AgentRunEvent[] => {
    if (!isRecord(event)) return [];

    switch (event.type) {
      case "message_start": {
        if (isRecord(event.message) && event.message.role === "assistant") text = "";
        return [];
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (!isRecord(update) || update.type !== "text_delta") return [];
        const delta = str(update.delta);
        if (!delta) return [];
        text += delta;
        return [{ type: "text", text }];
      }
      case "message_end": {
        const message = event.message;
        if (!isRecord(message) || message.role !== "assistant") return [];
        const tokens = usageTokens(message.usage);
        if (tokens <= 0) return [];
        const model = str(message.model);
        return [model === undefined ? { type: "usage", tokens } : { type: "usage", tokens, model }];
      }
      case "tool_execution_start": {
        const id = str(event.toolCallId);
        const name = str(event.toolName);
        if (id === undefined || name === undefined) return [];
        return [{ type: "tool_start", id, name, args: event.args ?? {} }];
      }
      case "tool_execution_end": {
        const id = str(event.toolCallId);
        const name = str(event.toolName);
        if (id === undefined || name === undefined) return [];
        return [{ type: "tool_end", id, name, result: resultText(event.result), isError: event.isError === true }];
      }
      default:
        return [];
    }
  };
}

/** How an assistant turn ended: its stop reason and the provider's error text, read through type guards. */
interface TurnEnd {
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/** The last assistant message in a session transcript, read through type guards. */
function lastAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") return message;
  }
  return undefined;
}

function turnEndOf(message: Record<string, unknown> | undefined): TurnEnd | undefined {
  if (message === undefined) return undefined;
  return { stopReason: str(message.stopReason), errorMessage: str(message.errorMessage) };
}

/** The turn end carried by an assistant `message_end` event, if the event is one. */
function assistantTurnEnd(event: unknown): TurnEnd | undefined {
  if (!isRecord(event) || event.type !== "message_end") return undefined;
  const message = event.message;
  return isRecord(message) && message.role === "assistant" ? turnEndOf(message) : undefined;
}

/** A turn that ended in a provider error has no reply; throw the provider's message instead of an empty result. */
function throwIfTurnFailed(turn: TurnEnd | undefined): void {
  if (turn?.stopReason !== "error") return;
  throw new Error(turn.errorMessage?.trim() ? turn.errorMessage : "Model request failed");
}

// ── WorkflowAgent ──────────────────────────────────────────

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly runId?: string;
  private readonly createSession: WorkflowSessionFactory;
  private readonly host: AgentHost;
  private readonly instanceId = randomUUID();
  private agentCounter = 0;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.runId = options.runId;
    this.createSession = options.createSession ?? createAgentSession;
    this.host = options.host ?? (isOmpHost() ? "omp" : "pi");
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentId = options.agentId ?? `a${++this.agentCounter}`;

    const fullPrompt = this.buildPrompt(prompt, options, Boolean(options.schema));
    const agentDir = getAgentDir();
    const sessionOpts = this.sessionOptionsFor(options.model, {
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      // omp identity fix: pass agentId and taskDepth so concurrent sessions don't collide
      // pi ignores extra keys, omp uses them for subagent identity
      agentId: `wf-${this.runId ?? this.instanceId}-${agentId}`,
      taskDepth: 1,
    });

    const created = await this.createSession(sessionOpts);
    const { session } = created;
    if (this.host === "omp" && options.model !== undefined) {
      if (session.model === undefined) {
        session.dispose();
        throw new Error(created.modelFallbackMessage ?? "Host created a session without a model");
      }
      if (created.modelFallbackMessage) options.onNotice?.(created.modelFallbackMessage);
    }

    options.onEvent?.({ type: "start", prompt: fullPrompt, model: session.model?.id });

    let removeAbortListener: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const mapFn = createSessionEventMapper();
    // omp drops failed assistant turns from `session.messages`, so the last observed assistant `message_end` is the source of truth too.
    let observedTurn: TurnEnd | undefined;

    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      unsubscribe = session.subscribe((raw: unknown) => {
        const turn = assistantTurnEnd(raw);
        if (turn) observedTurn = turn;
        for (const e of mapFn(raw)) options.onEvent?.(e);
      });

      await session.prompt(fullPrompt);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      throwIfTurnFailed(observedTurn);
      throwIfTurnFailed(turnEndOf(lastAssistantMessage(session.messages)));

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      unsubscribe?.();
      session.dispose();
    }
  }

  private resolveModel(selectors: string | readonly string[]) {
    const registry = this.sessionOptions.modelRegistry;
    if (registry === undefined) throw new Error("Model selection needs a modelRegistry");
    return resolveAgentModel(selectors, registry);
  }

  /**
   * Session options for one run. pi resolves the selector now and sets `model`; omp receives it as `modelPattern`
   * and drops the parent's `model`, so omp's own resolution decides.
   */
  private sessionOptionsFor(
    model: string | readonly string[] | undefined,
    base: WorkflowSessionOptions,
  ): WorkflowSessionOptions {
    if (model === undefined) return { ...base, ...this.sessionOptions };
    if (this.host === "omp") {
      const { model: _parentModel, ...inherited } = this.sessionOptions;
      return { ...base, ...inherited, modelPattern: typeof model === "string" ? model : [...model] };
    }
    const selected = this.resolveModel(model);
    const override: WorkflowSessionOptions = { ...base, ...this.sessionOptions, model: selected.model };
    if (selected.thinkingLevel) override.thinkingLevel = selected.thinkingLevel;
    return override;
  }

  private buildPrompt(
    prompt: string,
    options: Pick<AgentRunOptions, "instructions" | "label">,
    structured: boolean,
  ): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: readonly unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
