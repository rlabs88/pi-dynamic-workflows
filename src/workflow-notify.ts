import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "./format.js";
import { isOmpHost } from "./model-selector.js";
import { type AgentRecord, workflowRuns } from "./run-store.js";
import type { WorkflowRunResult } from "./workflow.js";

export const WORKFLOW_NOTIFICATION_TYPE = "workflow-notification" as const;

/** Result text longer than this is cut before it reaches the model. */
export const MAX_NOTIFICATION_RESULT_CHARS = 8000;

export type FinishedStatus = "completed" | "failed" | "stopped";

interface RunOutcomeBase {
  runId: string;
  name: string;
  durationMs: number;
  agents: readonly AgentRecord[];
  /** Agent failure lines, as the foreground error shows them; empty when none. */
  failures: string;
}

/** One finished run, as the foreground tool result and the background notification describe it. */
export type RunOutcome =
  | (RunOutcomeBase & { status: "completed"; run: WorkflowRunResult })
  | (RunOutcomeBase & { status: "failed" | "stopped"; error: string });

export interface WorkflowNotificationDetails {
  runId: string;
  status: FinishedStatus;
  name: string;
  durationMs: number;
  agents: number;
  tokens: number;
  /** Completed runs: the result text, truncated. */
  result?: string;
  /** Failed and stopped runs: the reason. */
  error?: string;
}

export interface WorkflowNotificationMessage {
  customType: typeof WORKFLOW_NOTIFICATION_TYPE;
  content: string;
  display: true;
  details: WorkflowNotificationDetails;
}

export interface NotificationDelivery {
  triggerTurn?: boolean;
  deliverAs: "steer" | "aside" | "nextTurn";
}

/** Sends a finished background run to the session. */
export interface WorkflowNotifier {
  notify(message: WorkflowNotificationMessage, delivery: NotificationDelivery): void;
}

/** Completed and failed runs wake an idle session; a user stop waits for the next turn. */
export function notificationDelivery(status: FinishedStatus): NotificationDelivery {
  if (status === "stopped") return { deliverAs: "nextTurn" };
  return { triggerTurn: true, deliverAs: isOmpHost() ? "aside" : "steer" };
}

export function truncateResult(text: string): string {
  if (text.length <= MAX_NOTIFICATION_RESULT_CHARS) return text;
  const cut = text.length - MAX_NOTIFICATION_RESULT_CHARS;
  return `${text.slice(0, MAX_NOTIFICATION_RESULT_CHARS)}\n[result truncated: ${cut} more characters not shown]`;
}

function resultText(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}

function summaryFor(outcome: RunOutcome): string {
  const head = `Dynamic workflow "${outcome.name}"`;
  if (outcome.status === "completed") return `${head} completed`;
  if (outcome.status === "failed") return `${head} failed: ${outcome.error}`;
  return `${head} was stopped`;
}

export function buildWorkflowNotification(outcome: RunOutcome): WorkflowNotificationMessage {
  const agents = outcome.agents;
  const count = (status: AgentRecord["status"]) => agents.filter((a) => a.status === status).length;
  const tokens = agents.reduce((sum, a) => sum + a.tokens, 0);
  const toolUses = agents.reduce((sum, a) => sum + a.toolCallCount, 0);
  const result = outcome.status === "completed" ? truncateResult(resultText(outcome.run.result)) : undefined;
  const error = outcome.status === "completed" ? undefined : outcome.error;

  const content = [
    "<task-notification>",
    `<task-id>${outcome.runId}</task-id>`,
    `<status>${outcome.status === "stopped" ? "killed" : outcome.status}</status>`,
    `<summary>${summaryFor(outcome)}</summary>`,
    `<result>${result ?? ""}</result>`,
    `<failures>${outcome.failures.trim()}</failures>`,
    "<usage>",
    `<agent_count>${agents.length}</agent_count>`,
    `<agents_done>${count("done")}</agents_done>`,
    `<agents_error>${count("failed")}</agents_error>`,
    `<agents_skipped>${count("skipped")}</agents_skipped>`,
    `<subagent_tokens>${tokens}</subagent_tokens>`,
    `<tool_uses>${toolUses}</tool_uses>`,
    `<duration_ms>${outcome.durationMs}</duration_ms>`,
    "</usage>",
    "</task-notification>",
  ].join("\n");

  return {
    customType: WORKFLOW_NOTIFICATION_TYPE,
    content,
    display: true,
    details: {
      runId: outcome.runId,
      status: outcome.status,
      name: outcome.name,
      durationMs: outcome.durationMs,
      agents: agents.length,
      tokens,
      result,
      error,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFinishedStatus(value: unknown): value is FinishedStatus {
  return value === "completed" || value === "failed" || value === "stopped";
}

function isNotificationDetails(value: unknown): value is WorkflowNotificationDetails {
  if (!isRecord(value)) return false;
  const optionalString = (v: unknown) => v === undefined || typeof v === "string";
  return (
    typeof value.runId === "string" &&
    isFinishedStatus(value.status) &&
    typeof value.name === "string" &&
    typeof value.durationMs === "number" &&
    typeof value.agents === "number" &&
    typeof value.tokens === "number" &&
    optionalString(value.result) &&
    optionalString(value.error)
  );
}

/** Message row: one line collapsed; the result and error follow when expanded. */
export function renderWorkflowNotification(details: unknown, expanded: boolean, theme: Theme): Component {
  if (!isNotificationDetails(details)) return new Text(theme.fg("muted", "workflow notification"), 0, 0);
  const ok = details.status === "completed";
  const icon = ok ? theme.fg("success", "✔") : theme.fg("error", "✘");
  const line = `${icon} Workflow ${details.name} ${details.status} in ${formatDuration(details.durationMs)} · ${details.agents} agents · ${formatTokens(details.tokens)} tokens`;
  const lines = [line];
  if (expanded) {
    if (details.result) lines.push("", details.result);
    if (details.error) lines.push("", theme.fg("error", details.error));
  }
  return new Text(lines.join("\n"), 0, 0);
}

// Background runs launched in this session, keyed by run id; the value is the session generation at launch.
let sessionGeneration = 0;
const backgroundRuns = new Map<string, number>();

/** Records a background run so its settlement can notify the session that launched it. */
export function trackBackgroundRun(runId: string): void {
  backgroundRuns.set(runId, sessionGeneration);
}

/** True while a background run launched in the current session is unsettled; false once the session ended under it. */
export function isBackgroundRunTracked(runId: string): boolean {
  return backgroundRuns.get(runId) === sessionGeneration;
}

/** Called once a background run settles. True when the run should notify: it is still tracked and its session is current. */
export function settleBackgroundRun(runId: string): boolean {
  const launchedIn = backgroundRuns.get(runId);
  backgroundRuns.delete(runId);
  return launchedIn !== undefined && launchedIn === sessionGeneration;
}

/** Session teardown: stop every background run and suppress its notification. */
export function endWorkflowSession(): void {
  sessionGeneration += 1;
  const runIds = [...backgroundRuns.keys()];
  backgroundRuns.clear();
  for (const runId of runIds) workflowRuns.stopRun(runId);
}
