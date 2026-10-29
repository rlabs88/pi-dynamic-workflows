import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentRunEvent } from "./agent.js";
import { type AgentRecord, FIELD_CAP, type RunRecord, TOOL_RESULT_CAP, type WorkflowRunStore } from "./run-store.js";

/**
 * Side-band progress files for hosts that cannot see a background run over their RPC channel (t3code).
 * The host sets `T3_WORKFLOW_PROGRESS_DIR`; with it unset nothing in this module runs.
 * The format is documented in docs/t3-progress-contract.md.
 */
export const WORKFLOW_PROGRESS_SCHEMA_VERSION = 1;
export const T3_WORKFLOW_PROGRESS_DIR_ENV = "T3_WORKFLOW_PROGRESS_DIR";

export const WIRE_TEXT_CAP = 20_000;
export const WIRE_ERROR_CAP = FIELD_CAP;
export const WIRE_TOOL_ARGS_CAP = FIELD_CAP;
export const WIRE_TOOL_RESULT_CAP = TOOL_RESULT_CAP;
export const TRANSCRIPT_BYTE_CAP = 4 * 1024 * 1024;
/** progress.json stays well below the reader's 8 MiB limit; see {@link fitSnapshot}. */
export const SNAPSHOT_BYTE_CAP = 4 * 1024 * 1024;
export const STOP_POLL_MS = 250;

export type WireAgentState = "queued" | "running" | "completed" | "failed";
export type WireRunStatus = "running" | "completed" | "failed" | "stopped";
export type WireStopReason = "user" | "aborted";

export interface WireAgent {
  /** 0-based: AgentRecord.id - 1. */
  index: number;
  /** "a<AgentRecord.id>"; the transcript file stem. */
  agentId: string;
  label: string;
  state: WireAgentState;
  /** `skipped`: the user skipped this agent. `stopped`: the run ended before the agent did. */
  endReason?: "skipped" | "stopped";
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  attempt: 1;
  /** Input plus output tokens. Cache reads are not counted. */
  totalTokens: number;
  toolCalls: number;
  durationMs?: number;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  prompt?: string;
  result?: string;
  error?: string;
}

export interface WireProgress {
  schemaVersion: typeof WORKFLOW_PROGRESS_SCHEMA_VERSION;
  runKey: string;
  runId: string;
  name: string;
  description?: string;
  status: WireRunStatus;
  /** Only with status "stopped". */
  stopReason?: WireStopReason;
  seq: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: string;
  /** The workflow's return value as JSON text. */
  result?: string;
  phases: { index: number; title: string }[];
  agents: WireAgent[];
  totals: { totalTokens: number; toolCalls: number; durationMs: number };
  handles: { runId: string; runDir: string; transcriptDir: string; scriptPath: string };
}

export type WireTranscriptBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_start"; id: string; name: string; args: string }
  | { kind: "tool_end"; id: string; name: string; result: string; isError: boolean }
  | { kind: "end"; state: "completed" | "failed"; result?: string; error?: string }
  | { kind: "truncated" };

export type WireTranscriptLine = { v: 1; seq: number; at: number } & WireTranscriptBody;

/** Added to the workflow tool result `details` when progress files are enabled. */
export interface WorkflowLaunchDetailsAddition {
  runKey: string;
  progressPath: string;
  transcriptDir: string;
}

/** The progress root from the environment, or undefined when the host did not ask for progress files. */
export function readProgressRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[T3_WORKFLOW_PROGRESS_DIR_ENV]?.trim();
  return value ? resolve(value) : undefined;
}

export function workflowRunKey(runId: string, startedAt: number): string {
  return `${runId}-${startedAt.toString(36)}`;
}

const cap = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function agentState(agent: AgentRecord): Pick<WireAgent, "state" | "endReason"> {
  switch (agent.status) {
    case "queued":
      return { state: "queued" };
    case "running":
      return { state: "running" };
    case "done":
      return { state: "completed" };
    case "failed":
      return { state: "failed" };
    case "skipped":
      return { state: "failed", endReason: "skipped" };
    case "stopped":
      return { state: "failed", endReason: "stopped" };
  }
}

function toWireAgent(agent: AgentRecord, phases: readonly string[]): WireAgent {
  const phaseIndex = agent.phase === undefined ? -1 : phases.indexOf(agent.phase);
  const result = jsonText(agent.result);
  const wire: WireAgent = {
    index: agent.id - 1,
    agentId: `a${agent.id}`,
    label: agent.label,
    ...agentState(agent),
    attempt: 1,
    totalTokens: agent.ioTokens,
    toolCalls: agent.toolCallCount,
    queuedAt: agent.queuedAt,
  };
  if (phaseIndex >= 0) {
    wire.phaseIndex = phaseIndex;
    wire.phaseTitle = phases[phaseIndex];
  }
  if (agent.model !== undefined) wire.model = agent.model;
  if (agent.startedAt !== undefined) wire.startedAt = agent.startedAt;
  if (agent.endedAt !== undefined) wire.completedAt = agent.endedAt;
  if (agent.startedAt !== undefined && agent.endedAt !== undefined) wire.durationMs = agent.endedAt - agent.startedAt;
  const prompt = agent.prompt ?? agent.promptPreview;
  if (prompt) wire.prompt = cap(prompt, WIRE_TEXT_CAP);
  if (result !== undefined) wire.result = cap(result, WIRE_TEXT_CAP);
  if (agent.error) wire.error = cap(agent.error, WIRE_ERROR_CAP);
  return wire;
}

/**
 * Serialises a snapshot under SNAPSHOT_BYTE_CAP. Settled agents lose most of their prompt and result first
 * (oldest first), then every agent loses them. Transcripts keep the full text, so only the summary shrinks.
 */
export function fitSnapshot(progress: WireProgress): string {
  let text = JSON.stringify(progress);
  if (Buffer.byteLength(text) <= SNAPSHOT_BYTE_CAP) return text;
  const settled = progress.agents.filter((a) => a.state === "completed" || a.state === "failed");
  for (const agent of settled) {
    if (agent.result !== undefined) agent.result = cap(agent.result, 2_000);
    if (agent.prompt !== undefined) agent.prompt = cap(agent.prompt, 1_000);
    text = JSON.stringify(progress);
    if (Buffer.byteLength(text) <= SNAPSHOT_BYTE_CAP) return text;
  }
  for (const agent of progress.agents) {
    delete agent.result;
    if (agent.prompt !== undefined) agent.prompt = cap(agent.prompt, 200);
  }
  return JSON.stringify(progress);
}

interface TranscriptState {
  path: string;
  seq: number;
  bytes: number;
  /** The user line is written. */
  opened: boolean;
  /** The end line, or the truncated line, is written; nothing follows. */
  closed: boolean;
  /** The prompt the script passed, used when the runner never reports its own start. */
  prompt: string;
}

export interface ProgressSinkOptions {
  root: string;
  store: WorkflowRunStore;
  runId: string;
  /** Normalized workflow source, written to script.js once. */
  script: string;
  /** Called once when the host creates the stop sentinel. */
  onStopRequested: () => void;
  stopPollMs?: number;
  now?: () => number;
}

/**
 * Writes one run's progress snapshot and member transcripts under `<root>/<runKey>/`.
 * Snapshots follow the store's notifications; the terminal snapshot is the last write and
 * lands before the store's synchronous final notify returns, so before any settle notification.
 * Write failures never reach the workflow: the files are a best-effort side channel.
 */
export class ProgressSink {
  readonly runKey: string;
  readonly runDir: string;
  readonly transcriptDir: string;
  readonly progressPath: string;
  readonly scriptPath: string;
  private readonly stopPath: string;
  private readonly run: RunRecord;
  private readonly options: ProgressSinkOptions;
  private readonly transcripts = new Map<number, TranscriptState>();
  private seq = 0;
  private lastFingerprint = "";
  private result: unknown;
  private closed = false;
  private unsubscribe: () => void;
  private stopTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(run: RunRecord, options: ProgressSinkOptions) {
    this.run = run;
    this.options = options;
    this.runKey = workflowRunKey(run.id, run.startedAt);
    this.runDir = join(options.root, this.runKey);
    this.transcriptDir = join(this.runDir, "agents");
    this.progressPath = join(this.runDir, "progress.json");
    this.scriptPath = join(this.runDir, "script.js");
    this.stopPath = join(this.runDir, "stop");
    this.unsubscribe = options.store.subscribe(() => this.flush());
  }

  /** Creates the run directory, script.js and the initial snapshot. Returns undefined when the directory cannot be written. */
  static create(options: ProgressSinkOptions): { sink: ProgressSink } | { error: string } {
    const run = options.store.list().find((r) => r.id === options.runId);
    if (!run) return { error: `run ${options.runId} is not in the run store` };
    const sink = new ProgressSink(run, options);
    try {
      mkdirSync(sink.transcriptDir, { recursive: true });
      writeFileSync(sink.scriptPath, options.script);
      sink.writeSnapshot();
    } catch (error) {
      sink.unsubscribe();
      return { error: error instanceof Error ? error.message : String(error) };
    }
    sink.startStopWatch();
    return { sink };
  }

  launchDetails(): WorkflowLaunchDetailsAddition {
    return { runKey: this.runKey, progressPath: this.progressPath, transcriptDir: this.transcriptDir };
  }

  /** The workflow's return value; set before the run finishes so the terminal snapshot carries it. */
  setResult(result: unknown): void {
    this.result = result;
  }

  agentStarted(id: number, prompt: string): void {
    if (this.closed || this.transcripts.has(id)) return;
    this.transcripts.set(id, {
      path: join(this.transcriptDir, `a${id}.jsonl`),
      seq: 0,
      bytes: 0,
      opened: false,
      closed: false,
      prompt,
    });
  }

  agentEvent(id: number, event: AgentRunEvent): void {
    const state = this.transcripts.get(id);
    if (this.closed || !state || state.closed) return;
    if (event.type === "start") {
      this.append(state, { kind: "user", text: cap(event.prompt, WIRE_TEXT_CAP) });
      return;
    }
    this.open(state);
    switch (event.type) {
      case "message":
        this.append(state, { kind: "assistant", text: cap(event.text, WIRE_TEXT_CAP) });
        break;
      case "tool_start": {
        const args = typeof event.args === "string" ? event.args : (JSON.stringify(event.args) ?? "");
        this.append(state, { kind: "tool_start", id: event.id, name: event.name, args: cap(args, WIRE_TOOL_ARGS_CAP) });
        break;
      }
      case "tool_end":
        this.append(state, {
          kind: "tool_end",
          id: event.id,
          name: event.name,
          result: cap(event.result, WIRE_TOOL_RESULT_CAP),
          isError: event.isError,
        });
        break;
      case "text":
      case "usage":
        break;
    }
  }

  agentEnded(id: number, outcome: { status: AgentRecord["status"]; result?: unknown; error?: string }): void {
    const state = this.transcripts.get(id);
    if (this.closed || !state || state.closed) return;
    this.open(state);
    this.appendEnd(state, outcome.status, outcome.result, outcome.error);
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.stopTimer);
    this.stopTimer = undefined;
  }

  private open(state: TranscriptState): void {
    if (state.opened) return;
    this.append(state, { kind: "user", text: cap(state.prompt, WIRE_TEXT_CAP) });
  }

  private appendEnd(state: TranscriptState, status: AgentRecord["status"], result: unknown, error: string | undefined) {
    if (status === "done") {
      const text = jsonText(result);
      this.append(state, {
        kind: "end",
        state: "completed",
        ...(text === undefined ? {} : { result: cap(text, WIRE_TEXT_CAP) }),
      });
      return;
    }
    const reason =
      error ?? (status === "skipped" ? "Skipped by the user" : "The workflow ended before this agent finished");
    this.append(state, { kind: "end", state: "failed", error: cap(reason, WIRE_ERROR_CAP) });
  }

  private append(state: TranscriptState, body: WireTranscriptBody): void {
    if (state.closed) return;
    const at = (this.options.now ?? Date.now)();
    let line = `${JSON.stringify({ v: 1, seq: state.seq + 1, at, ...body })}\n`;
    let size = Buffer.byteLength(line);
    let kind = body.kind;
    if (state.bytes + size > TRANSCRIPT_BYTE_CAP) {
      line = `${JSON.stringify({ v: 1, seq: state.seq + 1, at, kind: "truncated" })}\n`;
      size = Buffer.byteLength(line);
      kind = "truncated";
    }
    try {
      appendFileSync(state.path, line);
    } catch {
      return;
    }
    state.seq += 1;
    state.bytes += size;
    if (kind === "user") state.opened = true;
    if (kind === "end" || kind === "truncated") state.closed = true;
  }

  private flush(): void {
    if (this.closed) return;
    if (this.run.status !== "running") {
      this.endOpenTranscripts();
      this.writeSnapshot();
      this.dispose();
      return;
    }
    this.writeSnapshot();
  }

  /** Agents the run stopped under have no onAgentEnd; their transcripts end here, before the terminal snapshot. */
  private endOpenTranscripts(): void {
    for (const [id, state] of this.transcripts) {
      if (state.closed) continue;
      this.open(state);
      const agent = this.run.agents.find((a) => a.id === id);
      this.appendEnd(state, agent?.status ?? "stopped", agent?.result, agent?.error);
    }
  }

  private snapshot(): WireProgress {
    const run = this.run;
    const now = (this.options.now ?? Date.now)();
    const result = run.status === "completed" ? jsonText(this.result) : undefined;
    const agents = run.agents.map((agent) => toWireAgent(agent, run.phases));
    const progress: WireProgress = {
      schemaVersion: WORKFLOW_PROGRESS_SCHEMA_VERSION,
      runKey: this.runKey,
      runId: run.id,
      name: run.name,
      status: run.status,
      seq: this.seq + 1,
      startedAt: run.startedAt,
      updatedAt: now,
      phases: run.phases.map((title, index) => ({ index, title })),
      agents,
      totals: {
        totalTokens: agents.reduce((sum, a) => sum + a.totalTokens, 0),
        toolCalls: agents.reduce((sum, a) => sum + a.toolCalls, 0),
        durationMs: (run.endedAt ?? now) - run.startedAt,
      },
      handles: {
        runId: run.id,
        runDir: this.runDir,
        transcriptDir: this.transcriptDir,
        scriptPath: this.scriptPath,
      },
    };
    if (run.description) progress.description = run.description;
    if (run.stopReason !== undefined && run.status === "stopped") progress.stopReason = run.stopReason;
    if (run.endedAt !== undefined) progress.endedAt = run.endedAt;
    if (run.error) progress.error = cap(run.error, WIRE_ERROR_CAP);
    if (result !== undefined) progress.result = cap(result, WIRE_TEXT_CAP);
    return progress;
  }

  private writeSnapshot(): void {
    const progress = this.snapshot();
    const fingerprint = JSON.stringify({
      ...progress,
      seq: 0,
      updatedAt: 0,
      totals: { ...progress.totals, durationMs: 0 },
    });
    if (fingerprint === this.lastFingerprint) return;
    try {
      const tmp = `${this.progressPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${fitSnapshot(progress)}\n`);
      renameSync(tmp, this.progressPath);
    } catch {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.seq = progress.seq;
  }

  private startStopWatch(): void {
    const timer = setInterval(() => {
      if (this.closed || !existsSync(this.stopPath)) return;
      clearInterval(timer);
      this.stopTimer = undefined;
      this.options.onStopRequested();
    }, this.options.stopPollMs ?? STOP_POLL_MS);
    timer.unref();
    this.stopTimer = timer;
  }
}
