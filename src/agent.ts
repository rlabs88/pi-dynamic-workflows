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
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

// ── Event types ────────────────────────────────────────────

export type AgentRunEvent =
  | { type: "start"; prompt: string; model?: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; tokens: number; model?: string };

// ── Options ────────────────────────────────────────────────

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
}

/** The subset of an agent session the runner uses. */
export interface WorkflowSession {
  readonly messages: readonly unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
}

/** Session options plus the omp subagent identity keys (pi ignores them). */
export type WorkflowSessionOptions = CreateAgentSessionOptions & { agentId?: string; taskDepth?: number };

export type WorkflowSessionFactory = (options: WorkflowSessionOptions) => Promise<{ session: WorkflowSession }>;

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  agentId?: string;
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /** Event subscription for the agent's lifecycle. */
  onEvent?: (event: AgentRunEvent) => void;
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

// ── WorkflowAgent ──────────────────────────────────────────

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly runId?: string;
  private readonly createSession: WorkflowSessionFactory;
  private readonly instanceId = randomUUID();
  private agentCounter = 0;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.runId = options.runId;
    this.createSession = options.createSession ?? createAgentSession;
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

    // Emit start event before session creation, with the full prompt
    const fullPrompt = this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema));
    options.onEvent?.({
      type: "start",
      prompt: fullPrompt,
      model: this.sessionOptions.model?.id,
    });

    const agentDir = getAgentDir();

    // omp identity fix: pass agentId and taskDepth so concurrent sessions don't collide
    // pi ignores extra keys, omp uses them for subagent identity
    const sessionOpts: WorkflowSessionOptions = {
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      agentId: `wf-${this.runId ?? this.instanceId}-${agentId}`,
      taskDepth: 1,
      ...this.sessionOptions,
    };

    const { session } = await this.createSession(sessionOpts);

    let removeAbortListener: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const mapFn = createSessionEventMapper();

    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      // Subscribe to session events and forward mapped events
      if (options.onEvent) {
        unsubscribe = session.subscribe((raw: unknown) => {
          const events = mapFn(raw);
          for (const e of events) {
            options.onEvent?.(e);
          }
        });
      }

      await session.prompt(fullPrompt);
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

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

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
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
