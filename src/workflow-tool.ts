import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentRunEvent, WorkflowAgent } from "./agent.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  type WorkflowAgentSnapshot,
  type WorkflowAgentStatus,
  type WorkflowSnapshot,
} from "./display.js";
import { formatDuration, formatTokens, isAgentFinished } from "./format.js";
import { type AgentRecord, type AgentStatus, type RunRecord, workflowRuns } from "./run-store.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Subagent runner; defaults to a session-backed WorkflowAgent. */
  agent?: Pick<WorkflowAgent, "run">;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, pass opts.model as a model selector. On omp it takes anything `omp --model` accepts: `provider/modelId[:thinking]`, a model name such as `grok-4.7`, or a role such as `@deepseek_flash`. On pi only exact `provider/modelId[:thinking]` selectors are accepted. An array is an ordered fallback list, e.g. `{ model: ['anthropic/claude-haiku-5-5', 'cursor/grok-4.7'] }`. Use only model ids the host lists. Omit it to follow omp's task model routing: `task.agentModelOverrides` for the agentType, else for `task`, else the parent session's model.",
      "For workflow, pass opts.backend: 'cursor' to run one agent as a Cursor SDK local agent, with opts.model as a Cursor model id (for example `composer-2.5` or `grok-4.7`; a `cursor/` prefix is optional). Use opts.modelParams for Cursor model parameters. Omit backend to use the host session.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);

      const runController = new AbortController();
      const runId = workflowRuns.startRun(parsed.meta, runController);

      // Combine host signal with run's controller so "x" in the view stops the run
      const combinedSignal = signal
        ? (AbortSignal.any?.([signal, runController.signal]) ?? runController.signal)
        : runController.signal;

      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);
      const findRun = () => workflowRuns.list().find((r) => r.id === runId);

      const syncSnapshotAgents = () => {
        const run = findRun();
        if (run) snapshot.agents = run.agents.map(toSnapshotAgent);
        snapshot = recomputeWorkflowSnapshot(snapshot);
      };

      const update = () => {
        syncSnapshotAgents();
        display.update(snapshot);
      };

      const statusLineFor = (word: "Completed" | "Failed" | "Stopped", durationMs: number) => {
        const agents = findRun()?.agents ?? [];
        const tokens = agents.reduce((s, a) => s + a.tokens, 0);
        const icon = word === "Completed" ? "✔" : "✘";
        return `${icon} ${word} in ${formatDuration(durationMs)} · ${agents.length} agents · ${formatTokens(tokens)} tokens`;
      };

      const fail = (word: "Failed" | "Stopped", message: string): Error => {
        const durationMs = Date.now() - (findRun()?.startedAt ?? Date.now());
        workflowRuns.finishRun(runId, word === "Stopped" ? "stopped" : "failed", message);
        syncSnapshotAgents();
        snapshot.durationMs = durationMs;
        display.complete(snapshot);
        return new Error(`${statusLineFor(word, durationMs)}\n${message}${agentErrorSection(snapshot.logs)}`);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal: combinedSignal,
          concurrency: options.concurrency,
          agent: options.agent,
          runId,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onLog(message) {
            workflowRuns.log(runId, message);
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            workflowRuns.phase(runId, title);
            snapshot.currentPhase = title;
            if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
            update();
          },
          onAgentQueued(event) {
            workflowRuns.agentQueued(runId, event);
            update();
          },
          onAgentStart(event) {
            workflowRuns.agentStarted(runId, event.id, { prompt: event.prompt });
            update();
          },
          onAgentEvent(id, event: AgentRunEvent) {
            workflowRuns.agentEvent(runId, id, event);
          },
          onAgentEnd(event) {
            workflowRuns.agentEnded(runId, event.id, {
              status: event.status,
              result: event.result,
              error: event.error,
            });
            update();
          },
          onAgentControl(id, stop) {
            workflowRuns.registerAgentStop(runId, id, stop);
          },
        });
      } catch (error) {
        if (combinedSignal.aborted || isAbortError(error)) {
          const byUser = runController.signal.aborted && !signal?.aborted;
          throw fail("Stopped", byUser ? "Workflow was stopped by the user from /workflows" : "Workflow was aborted");
        }
        // Errors thrown inside the script's vm context are not `instanceof Error` here
        throw fail("Failed", isRecord(error) && typeof error.message === "string" ? error.message : String(error));
      }

      if (result.agentCount === 0) {
        throw fail(
          "Failed",
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      workflowRuns.finishRun(runId, "completed");
      syncSnapshotAgents();
      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      display.complete(snapshot);

      const statusLine = statusLineFor("Completed", result.durationMs);

      return {
        content: [
          {
            type: "text",
            text: `${statusLine}\n\nWorkflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}${agentErrorSection(result.logs)}`,
          },
        ],
        details: {
          ...snapshot,
          statusLine,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details: unknown = result.details;
      const snap = toRenderSnapshot(details);
      if (snap) {
        const lines = renderWorkflowLines(snap, workflowDisplayOptions);
        if (isPartial) {
          return new Text([...lines, "", theme.fg("muted", "/workflows to drill down")].join("\n"), 0, 0);
        }
        const statusLine = isRecord(details) && typeof details.statusLine === "string" ? details.statusLine : undefined;
        return new Text((statusLine ? [statusLine, ...lines] : lines).join("\n"), 0, 0);
      }

      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

/** Footer line for a running run. Every finished agent status counts as done. */
export function formatRunStatusLine(run: RunRecord, now = Date.now()): string {
  const total = run.agents.length;
  const done = run.agents.filter((a) => isAgentFinished(a.status)).length;
  const tokens = run.agents.reduce((s, a) => s + a.tokens, 0);
  const barWidth = 20;
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(barWidth - filled);
  return `◯ ${run.name}  ${bar}  ${done}/${total} · ${formatDuration(now - run.startedAt)} · ↓ ${formatTokens(tokens)} tokens`;
}

const snapshotStatus: Record<AgentStatus, WorkflowAgentStatus> = {
  queued: "queued",
  running: "running",
  done: "done",
  failed: "error",
  skipped: "skipped",
  stopped: "skipped",
};

function toSnapshotAgent(agent: AgentRecord): WorkflowAgentSnapshot {
  return {
    id: agent.id,
    label: agent.label,
    phase: agent.phase,
    prompt: agent.prompt ?? agent.promptPreview,
    status: snapshotStatus[agent.status],
    resultPreview: agent.result !== undefined ? preview(agent.result) : undefined,
    error: agent.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const agentStatuses: readonly WorkflowAgentStatus[] = ["queued", "running", "done", "error", "skipped"];

function isAgentStatus(value: unknown): value is WorkflowAgentStatus {
  return agentStatuses.some((s) => s === value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toRenderSnapshot(details: unknown): WorkflowSnapshot | undefined {
  if (!isRecord(details) || typeof details.name !== "string" || !details.name) return undefined;
  const agents: WorkflowAgentSnapshot[] = [];
  if (Array.isArray(details.agents)) {
    for (const a of details.agents) {
      if (!isRecord(a)) continue;
      agents.push({
        id: typeof a.id === "number" ? a.id : agents.length + 1,
        label: optionalString(a.label) ?? "",
        phase: optionalString(a.phase),
        prompt: optionalString(a.prompt) ?? "",
        status: isAgentStatus(a.status) ? a.status : "queued",
        resultPreview: optionalString(a.resultPreview),
        error: optionalString(a.error),
      });
    }
  }
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  return recomputeWorkflowSnapshot({
    name: details.name,
    phases: strings(details.phases),
    currentPhase: optionalString(details.currentPhase),
    logs: strings(details.logs),
    agents,
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

const agentFailureLog = /^agent .+ (?:failed: |stopped by user$)/;

// Failed and stopped agents, one line each in log order, so the parent model can see why they did not finish.
function agentErrorSection(logs: readonly string[]): string {
  const lines = logs
    .filter((line) => agentFailureLog.test(line))
    .map((line) => `- ${line.replace(/\s+/g, " ").trim().slice(0, 500)}`);
  return lines.length > 0 ? `\n\nAgent errors:\n${lines.join("\n")}` : "";
}
