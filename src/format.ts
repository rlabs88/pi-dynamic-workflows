import type { WorkflowAgentStatus } from "./display.js";
import type { AgentStatus } from "./run-store.js";

/** Floors to whole seconds: "0s", "41s", "1m 42s", "1h 2m". */
export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** "950", "1.2k", "48.9k", "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  const k = Math.floor(n / 100) / 10;
  if (k < 1000) return `${k.toFixed(1)}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
}

/** Ran to an end: every status except "queued", "running" and "stopped" (cut off by a run stop). */
export function isAgentFinished(status: AgentStatus | WorkflowAgentStatus): boolean {
  return status !== "queued" && status !== "running" && status !== "stopped";
}
