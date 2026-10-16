/** Agent lifecycle as shown in the drill-down view. `skipped` = stopped by the user; `stopped` = the run ended first. */
export type AgentStatus = "queued" | "running" | "done" | "failed" | "skipped" | "stopped";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface ToolCallRecord {
  id: string;
  name: string;
  /** JSON of the call arguments, capped at FIELD_CAP characters. */
  args: string;
  /** Result text, capped at TOOL_RESULT_CAP characters. Undefined while running. */
  result?: string;
  isError?: boolean;
  running: boolean;
}

export interface AgentRecord {
  /** 1-based, unique within a run, assigned in agent() call order. */
  id: number;
  label: string;
  /** Undefined when agent() ran before any phase(); the view groups these under "Agents". */
  phase?: string;
  status: AgentStatus;
  /** The prompt the script passed to agent(). */
  promptPreview: string;
  /** The full prompt sent to the backend, set when the agent starts. */
  prompt?: string;
  model?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  lastProgressAt?: number;
  /** Sum of reported usage across the agent's assistant messages. */
  tokens: number;
  /** Most recent MAX_TOOL_CALLS calls, oldest first. */
  toolCalls: ToolCallRecord[];
  /** Total calls, including ones dropped from toolCalls. */
  toolCallCount: number;
  /** Latest assistant text, capped at TEXT_CAP characters. */
  text: string;
  /** Final value returned to the script (string or structured object). */
  result?: unknown;
  error?: string;
  /** True when any field above was capped or calls were dropped. */
  truncated: boolean;
}

export interface RunRecord {
  /** Unique within the process, e.g. "wf_3". */
  id: string;
  name: string;
  description: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** Runtime phase() titles in first-seen order. */
  phases: string[];
  currentPhase?: string;
  logs: string[];
  /** Ordered by id. */
  agents: AgentRecord[];
  error?: string;
}

/** Read and control surface the drill-down view consumes. */
export interface WorkflowRunSource {
  /** Newest run first. */
  list(): readonly RunRecord[];
  /** Called after any change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  stopRun(runId: string): void;
  stopAgent(runId: string, agentId: number): void;
}

import type { AgentRunEvent } from "./agent.js";

export const TOOL_RESULT_CAP = 2000;
export const FIELD_CAP = 4000;
export const TEXT_CAP = 20000;
export const MAX_TOOL_CALLS = 200;
export const MAX_RUNS = 10;

// ── Implementation ─────────────────────────────────────────

type NotifyFn = () => void;
type UnsubFn = () => void;

let nextRunId = 0;

function nextId(): string {
  return `wf_${++nextRunId}`;
}

function capString(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max), truncated: true };
}

export class WorkflowRunStore implements WorkflowRunSource {
  private runs: RunRecord[] = [];
  private listeners = new Set<NotifyFn>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotify = false;
  // Per-run agent stop controllers: runId → Map<agentId, () => void>
  private agentStops = new Map<string, Map<number, () => void>>();
  // Per-run AbortController for stopping a run
  private runControllers = new Map<string, AbortController>();

  list(): readonly RunRecord[] {
    return this.runs;
  }

  subscribe(listener: NotifyFn): UnsubFn {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stopRun(runId: string): void {
    const controller = this.runControllers.get(runId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    // Also stop all agents for this run
    const stops = this.agentStops.get(runId);
    if (stops) {
      for (const stop of stops.values()) {
        try {
          stop();
        } catch {
          // ignore
        }
      }
    }
  }

  stopAgent(runId: string, agentId: number): void {
    const stops = this.agentStops.get(runId);
    const stop = stops?.get(agentId);
    if (stop) {
      try {
        stop();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Register a per-agent stop function.
   */
  registerAgentStop(runId: string, agentId: number, stop: () => void): void {
    let stops = this.agentStops.get(runId);
    if (!stops) {
      stops = new Map();
      this.agentStops.set(runId, stops);
    }
    stops.set(agentId, stop);
  }

  // ── Mutation API ────────────────────────────────────

  /**
   * Create a new run and return its id and an AbortController.
   */
  startRun(meta: { name: string; description: string }, stopRun: AbortController): string {
    const id = nextId();
    this.runControllers.set(id, stopRun);
    const run: RunRecord = {
      id,
      name: meta.name,
      description: meta.description,
      status: "running",
      startedAt: Date.now(),
      phases: [],
      logs: [],
      agents: [],
    };
    this.runs.unshift(run);
    this.evictFinished();
    this.scheduleNotify();
    return id;
  }

  /**
   * Record a phase title.
   */
  phase(runId: string, title: string): void {
    const run = this.findRun(runId);
    if (run?.status !== "running") return;
    if (!run.phases.includes(title)) {
      run.phases.push(title);
    }
    run.currentPhase = title;
    this.scheduleNotify();
  }

  /**
   * Append a log line.
   */
  log(runId: string, message: string): void {
    const run = this.findRun(runId);
    if (!run) return;
    run.logs.push(message);
    this.scheduleNotify();
  }

  /**
   * Record that an agent has been queued.
   */
  agentQueued(runId: string, opts: { id: number; label: string; phase?: string; prompt: string }): void {
    const run = this.findRun(runId);
    if (!run) return;
    if (opts.phase !== undefined && !run.phases.includes(opts.phase)) run.phases.push(opts.phase);
    const agent: AgentRecord = {
      id: opts.id,
      label: opts.label,
      phase: opts.phase,
      status: "queued",
      promptPreview: capString(opts.prompt, FIELD_CAP).value,
      queuedAt: Date.now(),
      tokens: 0,
      toolCalls: [],
      toolCallCount: 0,
      text: "",
      truncated: false,
    };
    run.agents.push(agent);
    this.scheduleNotify();
  }

  /**
   * Record that an agent has started.
   */
  agentStarted(runId: string, agentId: number, opts: { prompt: string; model?: string }): void {
    if (this.findRun(runId)?.status !== "running") return;
    const agent = this.findAgent(runId, agentId);
    if (agent?.status !== "queued") return;
    agent.status = "running";
    agent.prompt = opts.prompt;
    agent.model = opts.model;
    agent.startedAt = Date.now();
    this.scheduleNotify();
  }

  /**
   * Process an agent lifecycle event.
   */
  agentEvent(runId: string, agentId: number, event: AgentRunEvent): void {
    const agent = this.findAgent(runId, agentId);
    if (!agent) return;
    // A finished run's stopped or skipped agent is final: late runner updates change nothing
    if (this.findRun(runId)?.status !== "running" && (agent.status === "stopped" || agent.status === "skipped")) return;
    agent.lastProgressAt = Date.now();

    switch (event.type) {
      case "text": {
        // Keep the tail: the newest streamed text is what the live Outcome shows
        if (event.text.length > TEXT_CAP) {
          agent.text = event.text.slice(-TEXT_CAP);
          agent.truncated = true;
        } else {
          agent.text = event.text;
        }
        break;
      }
      case "tool_start": {
        agent.toolCallCount++;
        const argsStr = typeof event.args === "string" ? event.args : JSON.stringify(event.args);
        const cappedArgs = capString(argsStr, FIELD_CAP);
        const tc: ToolCallRecord = {
          id: event.id,
          name: event.name,
          args: cappedArgs.value,
          running: true,
        };
        if (cappedArgs.truncated) agent.truncated = true;
        agent.toolCalls.push(tc);
        // Drop oldest if over max
        if (agent.toolCalls.length > MAX_TOOL_CALLS) {
          agent.toolCalls.shift();
        }
        break;
      }
      case "tool_end": {
        const existing = agent.toolCalls.find((tc) => tc.id === event.id && tc.running);
        if (existing) {
          const cappedResult = capString(event.result, TOOL_RESULT_CAP);
          existing.result = cappedResult.value;
          existing.isError = event.isError;
          existing.running = false;
          if (cappedResult.truncated) agent.truncated = true;
        }
        break;
      }
      case "usage": {
        agent.tokens += event.tokens;
        if (event.model) agent.model = event.model;
        break;
      }
      case "start": {
        if (this.findRun(runId)?.status !== "running" || (agent.status !== "queued" && agent.status !== "running")) {
          break;
        }
        agent.status = "running";
        agent.startedAt = Date.now();
        agent.prompt = event.prompt;
        if (event.model) agent.model = event.model;
        break;
      }
    }
    this.scheduleNotify();
  }

  /**
   * Record an agent's end state.
   */
  agentEnded(runId: string, agentId: number, opts: { status: AgentStatus; result?: unknown; error?: string }): void {
    const agent = this.findAgent(runId, agentId);
    // A user skip is final, and so is a finished run's stop of its unfinished agents
    if (!agent || agent.status === "skipped") return;
    if (agent.status === "stopped" && this.findRun(runId)?.status !== "running") return;
    agent.status = opts.status;
    agent.endedAt = Date.now();
    if (opts.result !== undefined) agent.result = opts.result;
    if (opts.error) agent.error = opts.error;
    this.scheduleNotify();
  }

  /**
   * Finish a run with the given status.
   */
  finishRun(runId: string, status: RunStatus, error?: string): void {
    const run = this.findRun(runId);
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    if (error) run.error = error;

    // Mark queued/running agents as stopped
    const now = Date.now();
    for (const agent of run.agents) {
      if (agent.status === "queued" || agent.status === "running") {
        agent.status = "stopped";
        agent.endedAt = now;
      }
    }

    // Cleanup run state
    this.runControllers.delete(runId);
    this.agentStops.delete(runId);

    // Evict before the synchronous flush so listeners see the final list
    this.evictFinished();
    this.flushNotify();
  }

  // ── Private helpers ────────────────────────────────

  private findRun(runId: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === runId);
  }

  private findAgent(runId: string, agentId: number): AgentRecord | undefined {
    const run = this.findRun(runId);
    return run?.agents.find((a) => a.id === agentId);
  }

  private evictFinished(): void {
    // Keep at most MAX_RUNS; preserve running runs
    const finished = this.runs.filter((r) => r.status !== "running");
    // Sort finished newest-first (they're already in list order, unshift inserts at front)
    while (this.runs.length > MAX_RUNS && finished.length > 0) {
      const oldest = finished.pop();
      if (oldest) {
        const idx = this.runs.indexOf(oldest);
        if (idx !== -1) this.runs.splice(idx, 1);
      }
    }
  }

  private scheduleNotify(): void {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    this.notifyTimer = setTimeout(() => {
      this.flushNotify();
    }, 50);
  }

  private flushNotify(): void {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.pendingNotify = false;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // swallow
      }
    }
  }
}

/** Process-wide singleton store. */
export const workflowRuns = new WorkflowRunStore();
