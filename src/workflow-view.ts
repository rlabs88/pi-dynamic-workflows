import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, isAgentFinished } from "./format.js";
import type { AgentRecord, AgentStatus, RunRecord, RunStatus, WorkflowRunSource } from "./run-store.js";

// ── View state ──────────────────────────────────────────────────────

export interface ViewState {
  mode: "list" | "detail";
  selectedRunId: string;
  level: "phases" | "agents" | "agent";
  /** Fallback when `selectedPhaseKey` is unset or no longer present. */
  selectedPhaseIndex: number;
  /** The selected phase by group key (see `PhaseGroup.key`), so a phase added mid-run never moves the selection. */
  selectedPhaseKey?: string;
  selectedAgentId?: number;
  cardScroll: number;
  expanded: boolean;
  agentFilter?: AgentStatus;
  /** Opened on one run (from the footer): leaving its detail closes the view instead of showing the run list. */
  closeOnBack?: boolean;
}

/** Terminal area the view renders into; lets the reducer clamp card scrolling. */
export interface WorkflowViewViewport {
  width: number;
  height: number;
}

// ── Actions returned by the key reducer ─────────────────────────────

export type WorkflowViewAction =
  | { type: "close" }
  | { type: "stopRun"; runId: string }
  | { type: "stopAgent"; runId: string; agentId: number };

// ── Key normalisation ───────────────────────────────────────────────

export type NormalisedKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | "pageup"
  | "pagedown"
  | "j"
  | "k"
  | "x"
  | "f"
  | "other";

export function normalizeKey(data: string): NormalisedKey {
  if (matchesKey(data, "up")) return "up";
  if (matchesKey(data, "down")) return "down";
  if (matchesKey(data, "left")) return "left";
  if (matchesKey(data, "right")) return "right";
  if (matchesKey(data, "enter")) return "enter";
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "pageUp")) return "pageup";
  if (matchesKey(data, "pageDown")) return "pagedown";
  if (data === "j") return "j";
  if (data === "k") return "k";
  if (data === "x") return "x";
  if (data === "f") return "f";
  return "other";
}

// ── Layout constants ────────────────────────────────────────────────

const SPLIT_MIN_WIDTH = 64;
/** Detail chrome: top rule, name, description, blank line, hints. */
const DETAIL_CHROME = 5;
const PHASES_PANE_MAX = 30;
const RIGHT_PANE_MIN = 30;
const PROMPT_COLLAPSED_LINES = 2;
const OUTCOME_COLLAPSED_LINES = 20;
const COLLAPSED_CALLS = 3;
const SYNTHETIC_PHASE = "Agents";
const SYNTHETIC_PHASE_KEY = "\0agents";
const STATUS_ORDER: readonly AgentStatus[] = ["running", "queued", "done", "failed", "skipped", "stopped"];

// ── Phase grouping and selection ────────────────────────────────────

interface PhaseGroup {
  /** Selection identity: the title, or a reserved key for the synthetic group so a real "Agents" phase stays distinct. */
  key: string;
  title: string;
  agents: AgentRecord[];
}

/**
 * `run.phases` then the agents' own phases, in first-seen order; agents with no phase go to a trailing
 * synthetic "Agents" group.
 */
function phaseGroups(run: RunRecord): PhaseGroup[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const add = (title: string | undefined): void => {
    if (title === undefined || seen.has(title)) return;
    seen.add(title);
    titles.push(title);
  };
  for (const title of run.phases) add(title);
  for (const agent of run.agents) add(agent.phase);
  const groups = titles.map((title) => ({ key: title, title, agents: run.agents.filter((a) => a.phase === title) }));
  const orphans = run.agents.filter((a) => a.phase === undefined);
  if (orphans.length > 0) groups.push({ key: SYNTHETIC_PHASE_KEY, title: SYNTHETIC_PHASE, agents: orphans });
  return groups;
}

interface DetailSelection {
  groups: PhaseGroup[];
  phaseIndex: number;
  group: PhaseGroup | undefined;
  /** The selected phase's agents after the status filter. */
  agents: AgentRecord[];
  agentIndex: number;
  agent: AgentRecord | undefined;
}

function resolveDetail(state: ViewState, run: RunRecord): DetailSelection {
  const groups = phaseGroups(run);
  // Title first, then the group holding the selected agent, then the index: the selection never moves on its own.
  let phaseIndex =
    state.selectedPhaseKey === undefined ? -1 : groups.findIndex((g) => g.key === state.selectedPhaseKey);
  if (phaseIndex < 0 && state.selectedAgentId !== undefined)
    phaseIndex = groups.findIndex((g) => g.agents.some((a) => a.id === state.selectedAgentId));
  if (phaseIndex < 0 && groups.length > 0) phaseIndex = clamp(state.selectedPhaseIndex, 0, groups.length - 1);
  const group: PhaseGroup | undefined = groups[phaseIndex];
  const all = group?.agents ?? [];
  // The open card's agent stays listed after its status leaves the filter, so the card never switches on its own
  const agents = state.agentFilter
    ? all.filter((a) => a.status === state.agentFilter || (state.level === "agent" && a.id === state.selectedAgentId))
    : all;
  const found = agents.findIndex((a) => a.id === state.selectedAgentId);
  const agentIndex = agents.length === 0 ? -1 : Math.max(0, found);
  const agent: AgentRecord | undefined = agents[agentIndex];
  return { groups, phaseIndex, group, agents, agentIndex, agent };
}

function presentStatuses(agents: readonly AgentRecord[]): AgentStatus[] {
  return STATUS_ORDER.filter((status) => agents.some((a) => a.status === status));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Key reducer (pure) ──────────────────────────────────────────────

export function reduceWorkflowViewKey(
  state: ViewState,
  key: NormalisedKey,
  runs: readonly RunRecord[],
  viewport: WorkflowViewViewport,
): { state: ViewState; action?: WorkflowViewAction } {
  if (state.mode === "list") return reduceListKey(state, key, runs);

  const run = runs.find((r) => r.id === state.selectedRunId);
  if (!run) {
    return {
      state: {
        ...state,
        mode: "list",
        selectedRunId: runs[0]?.id ?? "",
        level: "phases",
        selectedPhaseIndex: 0,
        selectedPhaseKey: undefined,
        selectedAgentId: undefined,
        cardScroll: 0,
        agentFilter: undefined,
      },
      action: runs.length === 0 ? { type: "close" } : undefined,
    };
  }

  const sel = resolveDetail(state, run);
  if (state.level === "phases") return reducePhasesKey(state, key, run, sel);
  if (state.level === "agents") return reduceAgentsKey(state, key, sel);
  return reduceAgentKey(state, key, run, sel, viewport);
}

function reduceListKey(
  state: ViewState,
  key: NormalisedKey,
  runs: readonly RunRecord[],
): { state: ViewState; action?: WorkflowViewAction } {
  // A missing or vanished selection falls back to the first run.
  const index = Math.max(
    0,
    runs.findIndex((r) => r.id === state.selectedRunId),
  );
  const run: RunRecord | undefined = runs[index];
  switch (key) {
    case "up":
      return { state: { ...state, selectedRunId: runs[Math.max(0, index - 1)]?.id ?? "" } };
    case "down":
      return { state: { ...state, selectedRunId: runs[Math.min(runs.length - 1, index + 1)]?.id ?? "" } };
    case "enter":
    case "right":
      if (!run) return { state };
      return {
        state: {
          ...state,
          mode: "detail",
          selectedRunId: run.id,
          level: "phases",
          selectedPhaseIndex: 0,
          selectedPhaseKey: undefined,
          selectedAgentId: undefined,
          cardScroll: 0,
          expanded: false,
          agentFilter: undefined,
        },
      };
    case "escape":
    case "left":
      return { state, action: { type: "close" } };
    case "x":
      return run?.status === "running" ? { state, action: { type: "stopRun", runId: run.id } } : { state };
    default:
      return { state };
  }
}

function reducePhasesKey(
  state: ViewState,
  key: NormalisedKey,
  run: RunRecord,
  sel: DetailSelection,
): { state: ViewState; action?: WorkflowViewAction } {
  const last = Math.max(0, sel.groups.length - 1);
  const select = (index: number): ViewState => ({
    ...state,
    selectedPhaseIndex: index,
    selectedPhaseKey: sel.groups[index]?.key,
    selectedAgentId: undefined,
  });
  switch (key) {
    case "up":
    case "k":
      return { state: select(clamp(sel.phaseIndex - 1, 0, last)) };
    case "down":
    case "j":
      return { state: select(clamp(sel.phaseIndex + 1, 0, last)) };
    case "enter":
    case "right": {
      const first = sel.group?.agents[0];
      if (!first) return { state };
      return {
        state: {
          ...state,
          level: "agents",
          selectedPhaseIndex: sel.phaseIndex,
          selectedPhaseKey: sel.group?.key,
          selectedAgentId: first.id,
          agentFilter: undefined,
          cardScroll: 0,
        },
      };
    }
    case "escape":
    case "left":
      if (state.closeOnBack) return { state, action: { type: "close" } };
      return {
        state: {
          ...state,
          mode: "list",
          level: "phases",
          selectedPhaseIndex: 0,
          selectedPhaseKey: undefined,
          selectedAgentId: undefined,
          cardScroll: 0,
          agentFilter: undefined,
        },
      };
    case "x":
      return run.status === "running" ? { state, action: { type: "stopRun", runId: run.id } } : { state };
    default:
      return { state };
  }
}

function reduceAgentsKey(
  state: ViewState,
  key: NormalisedKey,
  sel: DetailSelection,
): { state: ViewState; action?: WorkflowViewAction } {
  const { agents, agentIndex } = sel;
  switch (key) {
    case "up":
    case "k":
      return { state: { ...state, selectedAgentId: agents[Math.max(0, agentIndex - 1)]?.id } };
    case "down":
    case "j":
      return { state: { ...state, selectedAgentId: agents[Math.min(agents.length - 1, agentIndex + 1)]?.id } };
    case "enter":
    case "right":
      if (!sel.agent) return { state };
      return { state: { ...state, level: "agent", selectedAgentId: sel.agent.id, cardScroll: 0, expanded: false } };
    case "escape":
    case "left":
      return {
        state: { ...state, level: "phases", selectedAgentId: undefined, cardScroll: 0, agentFilter: undefined },
      };
    case "f": {
      const all = sel.group?.agents ?? [];
      const present = presentStatuses(all);
      if (present.length <= 1 && state.agentFilter === undefined) return { state };
      // A filter whose status is gone resets to all; otherwise cycle all → each present status → all.
      let agentFilter: AgentStatus | undefined;
      if (state.agentFilter === undefined) agentFilter = present[0];
      else {
        const current = present.indexOf(state.agentFilter);
        agentFilter = current < 0 ? undefined : present[current + 1];
      }
      const visible = agentFilter ? all.filter((a) => a.status === agentFilter) : all;
      const keep = visible.some((a) => a.id === sel.agent?.id);
      return { state: { ...state, agentFilter, selectedAgentId: keep ? sel.agent?.id : visible[0]?.id } };
    }
    default:
      return { state };
  }
}

function reduceAgentKey(
  state: ViewState,
  key: NormalisedKey,
  run: RunRecord,
  sel: DetailSelection,
  viewport: WorkflowViewViewport,
): { state: ViewState; action?: WorkflowViewAction } {
  const { agents, agentIndex, agent } = sel;
  const scrollTo = (next: ViewState, scroll: number): ViewState => ({
    ...next,
    cardScroll: clamp(scroll, 0, maxCardScroll(next, sel, viewport)),
  });
  const page = (): number => agentLevelLayout(viewport.width, viewport.height, sel).cardRows;
  switch (key) {
    case "j":
      return { state: scrollTo(state, state.cardScroll + 1) };
    case "k":
      return { state: scrollTo(state, state.cardScroll - 1) };
    case "pagedown":
      return { state: scrollTo(state, state.cardScroll + page()) };
    case "pageup":
      return { state: scrollTo(state, state.cardScroll - page()) };
    case "enter":
    case "right": {
      const toggled = { ...state, expanded: !state.expanded };
      return { state: scrollTo(toggled, toggled.cardScroll) };
    }
    case "escape":
    case "left":
      return { state: { ...state, level: "agents", cardScroll: 0 } };
    case "up":
    case "down": {
      const next = agents[clamp(agentIndex + (key === "up" ? -1 : 1), 0, Math.max(0, agents.length - 1))];
      if (!next || next.id === agent?.id) return { state };
      return { state: { ...state, selectedAgentId: next.id, cardScroll: 0 } };
    }
    case "x":
      if (!agent || (agent.status !== "running" && agent.status !== "queued")) return { state };
      return { state, action: { type: "stopAgent", runId: run.id, agentId: agent.id } };
    default:
      return { state };
  }
}

function maxCardScroll(state: ViewState, sel: DetailSelection, viewport: WorkflowViewViewport): number {
  if (!sel.agent) return 0;
  const layout = agentLevelLayout(viewport.width, viewport.height, sel);
  // Line count does not depend on the clock, so any `now` works here.
  const total = agentCardLines(sel.agent, layout.cardWidth, 0, PLAIN_STYLE, state.expanded).length;
  return Math.max(0, total - layout.cardRows);
}

// ── Style map ───────────────────────────────────────────────────────

export interface WorkflowViewStyle {
  selected: (s: string) => string;
  success: (s: string) => string;
  error: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  title: (s: string) => string;
}

const PLAIN_STYLE: WorkflowViewStyle = {
  selected: (s) => s,
  success: (s) => s,
  error: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
  title: (s) => s,
};

// ── Text helpers ────────────────────────────────────────────────────

const GLYPH_BY_STATUS: Record<AgentStatus, string> = {
  queued: "◌",
  running: "⏺",
  done: "✔",
  failed: "✘",
  skipped: "✘",
  stopped: "◌",
};

const LABEL_BY_STATUS: Record<AgentStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

const GLYPH_BY_RUN_STATUS: Record<RunStatus, string> = {
  running: "⏺",
  completed: "✔",
  failed: "✘",
  stopped: "✘",
};

/** Collapse whitespace and control characters so target text stays on one row. */
function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

/** Split target text into lines, dropping control characters other than newlines. */
function textLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[^\P{Cc}\n]/gu, "")
    .split("\n");
}

/** Truncate to `width` columns; never wider. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
}

function padTo(text: string, width: number): string {
  const fitted = fit(text, width);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/** Word-wrap target text to `width`, one entry per screen row. */
function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of textLines(text)) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    for (const piece of wrapTextWithAnsi(line, w)) out.push(fit(piece, w));
  }
  return out;
}

/**
 * Left text with right-aligned `right`. When both do not fit with at least `minLeft` columns of left,
 * `onTight` picks which side survives.
 */
function alignRight(
  left: string,
  right: string,
  width: number,
  options: { gap?: number; minLeft?: number; onTight?: "left" | "right" } = {},
): string {
  const gap = options.gap ?? 1;
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + gap + rw <= width) return left + " ".repeat(width - lw - rw) + right;
  const room = width - gap - rw;
  if (room >= Math.min(lw, options.minLeft ?? 1) && room > 0) {
    const l = fit(left, room);
    return l + " ".repeat(width - visibleWidth(l) - rw) + right;
  }
  return options.onTight === "right" ? fit(right, width) : fit(left, width);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function elapsed(startedAt: number, endedAt: number | undefined, now: number): string {
  return formatDuration(Math.max(0, (endedAt ?? now) - startedAt));
}

function agentDuration(agent: AgentRecord, now: number): string {
  return elapsed(agent.startedAt ?? agent.queuedAt, agent.endedAt, now);
}

function modelOf(agent: AgentRecord): string | undefined {
  const model: unknown = agent.model;
  return typeof model === "string" && model.length > 0 ? oneLine(model) : undefined;
}

function scrollIndicator(start: number, end: number, total: number): string {
  return `↑ ${start + 1}–${end} of ${total} ↓`;
}

/** Visible slice of `total` rows of at most `size`, keeping `selected` in view. */
function windowAround(total: number, selected: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const start = clamp(selected - Math.floor(size / 2), 0, total - size);
  return { start, end: start + size };
}

// ── Row builders ────────────────────────────────────────────────────

/** Pane row: one column of padding, a 2-column selection gutter, content, one column of padding. */
function paneRow(selected: boolean, content: string, width: number, style: WorkflowViewStyle): string {
  const gutter = selected ? style.selected("❯ ") : "  ";
  return fit(` ${gutter}${padTo(content, Math.max(0, width - 4))} `, width);
}

/** `✘` if any agent failed; `✔` if every agent finished (a stopped agent did not); else the 1-based number. */
function phaseMark(group: PhaseGroup, index: number): { mark: string; kind: "done" | "failed" | "pending" } {
  if (group.agents.some((a) => a.status === "failed")) return { mark: "✘", kind: "failed" };
  if (group.agents.length > 0 && group.agents.every((a) => isAgentFinished(a.status)))
    return { mark: "✔", kind: "done" };
  return { mark: `${index + 1}`, kind: "pending" };
}

function phaseRatio(group: PhaseGroup): string {
  return `${group.agents.filter((a) => isAgentFinished(a.status)).length}/${group.agents.length}`;
}

function phaseRowContent(
  group: PhaseGroup,
  index: number,
  highlighted: boolean,
  width: number,
  style: WorkflowViewStyle,
): string {
  const { mark, kind } = phaseMark(group, index);
  const styledMark = !highlighted
    ? mark
    : kind === "failed"
      ? style.error(mark)
      : kind === "done"
        ? style.success(mark)
        : style.selected(mark);
  return alignRight(`${styledMark} ${oneLine(group.title)}`, phaseRatio(group), width, { minLeft: 3 });
}

/**
 * Agent row: glyph and label, right-aligned `model · tok · tool calls` and duration; drops model, then stats.
 * A stopped agent keeps the word `stopped` last, cutting its label harder, since its `◌` glyph alone reads as queued.
 */
function agentRowContent(agent: AgentRecord, width: number, now: number): string {
  const label = oneLine(agent.label);
  const left = `${GLYPH_BY_STATUS[agent.status]} ${label}`;
  const time = agentDuration(agent, now);
  const duration = agent.status === "stopped" ? `stopped · ${time}` : time;
  const stats = `${formatTokens(agent.tokens)} tok · ${plural(agent.toolCallCount, "tool call")}`;
  const model = modelOf(agent);
  const candidates = [
    model ? `${model} · ${stats}  ${duration}` : undefined,
    `${stats}  ${duration}`,
    duration,
    agent.status === "stopped" ? "stopped" : undefined,
  ];
  const labelMinLeft = 2 + Math.min(visibleWidth(label), 12);
  for (const right of candidates) {
    const minLeft = right === "stopped" ? 4 : labelMinLeft;
    if (right && minLeft + 2 + visibleWidth(right) <= width) return alignRight(left, right, width, { gap: 2, minLeft });
  }
  return fit(left, width);
}

// ── Box drawing helpers ─────────────────────────────────────────────

function boxEdge(label: string | undefined, width: number): string {
  if (!label || width < 4) return "─".repeat(Math.max(0, width));
  const text = ` ${fit(label, width - 3)} `;
  return text + "─".repeat(Math.max(0, width - visibleWidth(text)));
}

function makeBoxTop(titleL: string, titleR: string, leftW: number, rightW: number): string {
  return `╭${boxEdge(titleL, leftW)}┬${boxEdge(titleR, rightW)}╮`;
}

function makeBoxBottom(leftW: number, rightW: number, footL?: string, footR?: string): string {
  return `╰${boxEdge(footL, leftW)}┴${boxEdge(footR, rightW)}╯`;
}

function makeBoxRow(left: string, right: string, leftW: number, rightW: number): string {
  return `│${padTo(left, leftW)}│${padTo(right, rightW)}│`;
}

interface PaneList {
  title: string;
  rows: string[];
  selected: number;
  /** Shown instead of rows when there are none. */
  empty?: string;
}

/** Two bordered panes; each list is windowed around its selection to fit `maxRows`. */
function renderSplitBox(
  left: PaneList,
  right: PaneList,
  leftW: number,
  rightW: number,
  maxRows: number,
  style: WorkflowViewStyle,
): string[] {
  const leftRows = left.rows.length > 0 ? left.rows : [left.empty ? ` ${style.dim(left.empty)}` : ""];
  const rightRows = right.rows.length > 0 ? right.rows : [right.empty ? ` ${style.dim(right.empty)}` : ""];
  const rows = Math.max(1, Math.min(maxRows, Math.max(leftRows.length, rightRows.length)));
  const lw = windowAround(leftRows.length, Math.max(0, left.selected), rows);
  const rw = windowAround(rightRows.length, Math.max(0, right.selected), rows);
  const footL = lw.end - lw.start < leftRows.length ? scrollIndicator(lw.start, lw.end, leftRows.length) : undefined;
  const footR = rw.end - rw.start < rightRows.length ? scrollIndicator(rw.start, rw.end, rightRows.length) : undefined;

  const lines = [makeBoxTop(left.title, right.title, leftW, rightW)];
  for (let i = 0; i < rows; i++) {
    lines.push(makeBoxRow(leftRows[lw.start + i] ?? "", rightRows[rw.start + i] ?? "", leftW, rightW));
  }
  lines.push(makeBoxBottom(leftW, rightW, footL, footR));
  return lines;
}

// ── Render function ─────────────────────────────────────────────────

interface RenderOptions {
  width: number;
  height: number;
  now: number;
  style: WorkflowViewStyle;
}

/** Renders at most `height` lines, none wider than `width`. */
export function renderWorkflowView(state: ViewState, runs: readonly RunRecord[], options: RenderOptions): string[] {
  const height = Math.max(1, Math.floor(options.height));
  const width = Math.max(1, Math.floor(options.width));
  // Backstop: the host aborts on any line wider than the terminal.
  return renderWorkflowViewUnclamped(state, runs, options)
    .slice(0, height)
    .map((line) => fit(line, width));
}

/** The renderers' own output before the backstop; exported so tests can check they already fit. */
/** @internal */
export function renderWorkflowViewUnclamped(
  state: ViewState,
  runs: readonly RunRecord[],
  options: RenderOptions,
): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const opts = { ...options, width, height };
  const run = state.mode === "detail" ? runs.find((r) => r.id === state.selectedRunId) : undefined;
  return run ? renderRunDetail(state, run, opts) : renderRunList(state, runs, opts);
}

// ── Run list rendering ──────────────────────────────────────────────

function renderRunList(state: ViewState, runs: readonly RunRecord[], options: RenderOptions): string[] {
  const { width, height, now, style } = options;
  const hints: string[] = [];

  if (runs.length === 0) {
    return [
      renderHeaderLine("Dynamic workflows", "", width, style),
      "",
      style.dim(fit("  No dynamic workflows in this session.", width)),
      "",
      style.dim(fit("esc close", width)),
    ];
  }

  const count = (status: RunStatus): number => runs.filter((r) => r.status === status).length;
  const counts = (
    [
      ["running", count("running")],
      ["completed", count("completed")],
      ["stopped", count("stopped")],
      ["failed", count("failed")],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);

  const selectedIndex = Math.max(
    0,
    runs.findIndex((r) => r.id === state.selectedRunId),
  );
  const selectedRun = runs[selectedIndex];
  const budget = Math.max(1, height - 3);
  const size = runs.length > budget ? Math.max(1, budget - 1) : runs.length;
  const win = windowAround(runs.length, selectedIndex, size);

  const lines = [renderHeaderLine("Dynamic workflows", counts.join(" · "), width, style)];
  for (let i = win.start; i < win.end; i++) {
    const run = runs[i];
    const isSelected = i === selectedIndex;
    const glyph = GLYPH_BY_RUN_STATUS[run.status];
    const styledGlyph =
      run.status === "completed" ? style.success(glyph) : run.status === "running" ? glyph : style.error(glyph);
    const gutter = isSelected ? style.selected("❯ ") : "  ";
    const tokens = run.agents.reduce((sum, a) => sum + a.tokens, 0);
    const right = `${elapsed(run.startedAt, run.endedAt, now)} · ${plural(run.agents.length, "agent")} · ${formatTokens(tokens)} tok`;
    lines.push(alignRight(` ${gutter}${styledGlyph} ${oneLine(run.name)}`, right, width, { gap: 2, minLeft: 12 }));
  }
  if (win.end - win.start < runs.length)
    lines.push(style.dim(fit(`  ${scrollIndicator(win.start, win.end, runs.length)}`, width)));

  if (runs.length > 1) hints.push("↑↓ select");
  hints.push("enter view");
  if (selectedRun?.status === "running") hints.push("x stop");
  hints.push("esc close");
  lines.push("", style.dim(fit(hints.join(" · "), width)));
  return lines;
}

function renderHeaderLine(left: string, right: string, width: number, style: WorkflowViewStyle): string {
  const leftText = ` ${left} `;
  const rightText = right ? ` ${right} ` : "";
  const lw = visibleWidth(leftText);
  const rw = visibleWidth(rightText);
  if (lw >= width) return style.title(fit(leftText, width));
  if (lw + rw + 1 <= width) return `${style.title(leftText)}${"─".repeat(width - lw - rw)}${style.dim(rightText)}`;
  return `${style.title(leftText)}${style.dim(fit(rightText, width - lw))}`;
}

// ── Run detail rendering ────────────────────────────────────────────

function renderRunDetail(state: ViewState, run: RunRecord, options: RenderOptions): string[] {
  const { width, height, now, style } = options;
  const done = run.agents.filter((a) => isAgentFinished(a.status)).length;
  const suffix =
    run.status === "completed"
      ? " · done"
      : run.status === "stopped"
        ? " · stopped"
        : run.status === "failed"
          ? " · failed"
          : "";
  const stats = `${done}/${run.agents.length} agents · ${elapsed(run.startedAt, run.endedAt, now)}${suffix}`;
  const description = oneLine(run.description);

  const lines = [
    style.dim("─".repeat(width)),
    style.title(fit(oneLine(run.name), width)),
    alignRight(description, stats, width, {
      gap: 2,
      minLeft: Math.min(visibleWidth(description), 10),
      onTight: "right",
    }),
  ];

  const sel = resolveDetail(state, run);
  const body = Math.max(1, height - DETAIL_CHROME);
  const content =
    state.level === "phases" || state.level === "agents"
      ? renderPhasesAndAgents(state, run, sel, width, body, now, style)
      : renderAgentLevel(state, sel, width, body, now, style);
  lines.push(...content.rows, "", style.dim(fit(content.hints.join(" · "), width)));
  return lines;
}

interface LevelContent {
  rows: string[];
  hints: string[];
}

/** Columns a pane needs to show its scroll indicator in the bottom border when `total` rows overflow `maxRows`. */
function indicatorWidth(total: number, maxRows: number): number {
  return total > maxRows ? visibleWidth(scrollIndicator(total - 1, total, total)) + 3 : 0;
}

function phasesPaneWidth(groups: readonly PhaseGroup[], width: number, maxRows: number): number {
  let longest = Math.max(visibleWidth(" Phases ") + 1, indicatorWidth(groups.length, maxRows));
  groups.forEach((group, i) => {
    const row = 4 + visibleWidth(phaseMark(group, i).mark) + 1 + visibleWidth(oneLine(group.title)) + 1;
    longest = Math.max(longest, row + visibleWidth(phaseRatio(group)));
  });
  return Math.max(10, Math.min(PHASES_PANE_MAX, longest, width - 3 - RIGHT_PANE_MIN));
}

function agentsTitle(sel: DetailSelection, filter: AgentStatus | undefined): string {
  const group = sel.group;
  if (!group) return "";
  return `${oneLine(group.title)} · ${plural(group.agents.length, "agent")}${filter ? ` · showing ${filter}` : ""}`;
}

/** Phases level and agents level: phases on the left, the selected phase's agents on the right. */
function renderPhasesAndAgents(
  state: ViewState,
  run: RunRecord,
  sel: DetailSelection,
  width: number,
  body: number,
  now: number,
  style: WorkflowViewStyle,
): LevelContent {
  const atAgents = state.level === "agents";
  const filter = atAgents ? state.agentFilter : undefined;
  const agents = atAgents ? sel.agents : (sel.group?.agents ?? []);
  const agentIndex = atAgents ? sel.agentIndex : -1;
  const empty = filter ? `No ${filter} agents.` : "No agents yet.";

  const hints: string[] = [];
  if (atAgents) {
    if (agents.length > 1) hints.push("↑↓ agent");
    if (presentStatuses(sel.group?.agents ?? []).length > 1 || state.agentFilter) hints.push("f filter");
    if (sel.agent) hints.push("enter card");
  } else {
    hints.push("↑↓ select");
    if (run.status === "running") hints.push("x stop workflow");
  }
  hints.push("esc back");

  if (width >= SPLIT_MIN_WIDTH) {
    const boxRows = Math.max(1, body - 2);
    const leftW = phasesPaneWidth(sel.groups, width, boxRows);
    const rightW = width - leftW - 3;
    const phaseRows = sel.groups.map((group, i) =>
      paneRow(
        !atAgents && i === sel.phaseIndex,
        phaseRowContent(group, i, i === sel.phaseIndex, leftW - 4, style),
        leftW,
        style,
      ),
    );
    const agentRows = agents.map((a, i) =>
      paneRow(i === agentIndex, agentRowContent(a, rightW - 4, now), rightW, style),
    );
    const rows = renderSplitBox(
      { title: "Phases", rows: phaseRows, selected: sel.phaseIndex, empty: "No phases yet." },
      { title: agentsTitle(sel, filter), rows: agentRows, selected: agentIndex, empty },
      leftW,
      rightW,
      boxRows,
      style,
    );
    return { rows, hints };
  }

  // Narrow: the focused list fills the width under a title row with a scroll indicator.
  const listRows = Math.max(1, body - 1);
  if (!atAgents) {
    const all = sel.groups.map((group, i) =>
      paneRow(i === sel.phaseIndex, phaseRowContent(group, i, i === sel.phaseIndex, width - 4, style), width, style),
    );
    return { rows: narrowList("Phases", all, sel.phaseIndex, "No phases yet.", width, listRows, style), hints };
  }
  const all = agents.map((a, i) => paneRow(i === agentIndex, agentRowContent(a, width - 4, now), width, style));
  return { rows: narrowList(agentsTitle(sel, filter), all, agentIndex, empty, width, listRows, style), hints };
}

function narrowList(
  title: string,
  rows: string[],
  selected: number,
  empty: string,
  width: number,
  maxRows: number,
  style: WorkflowViewStyle,
): string[] {
  if (rows.length === 0) return [style.dim(fit(title, width)), style.dim(fit(`   ${empty}`, width))];
  const win = windowAround(rows.length, Math.max(0, selected), maxRows);
  const header =
    win.end - win.start < rows.length
      ? alignRight(title, scrollIndicator(win.start, win.end, rows.length), width, { gap: 2, minLeft: 6 })
      : fit(title, width);
  return [style.dim(header), ...rows.slice(win.start, win.end)];
}

// ── Agent level (card view) ─────────────────────────────────────────

interface AgentLevelLayout {
  split: boolean;
  leftW: number;
  rightW: number;
  cardWidth: number;
  cardRows: number;
}

function agentLevelLayout(width: number, height: number, sel: DetailSelection): AgentLevelLayout {
  const body = Math.max(1, height - DETAIL_CHROME);
  if (width < SPLIT_MIN_WIDTH) {
    return {
      split: false,
      leftW: 0,
      rightW: width,
      cardWidth: Math.max(1, width - 2),
      cardRows: Math.max(1, body - 1),
    };
  }
  const cardRows = Math.max(1, body - 2);
  let longest = visibleWidth(agentsTitle(sel, undefined)) + 3;
  for (const a of sel.agents) longest = Math.max(longest, 4 + 2 + visibleWidth(oneLine(a.label)) + 2 + 7 + 1);
  const fitted = Math.min(longest, Math.floor(width * 0.35));
  const leftW = Math.max(20, indicatorWidth(sel.agents.length, cardRows), fitted);
  const rightW = width - leftW - 3;
  return { split: true, leftW, rightW, cardWidth: Math.max(1, rightW - 2), cardRows };
}

function renderAgentLevel(
  state: ViewState,
  sel: DetailSelection,
  width: number,
  body: number,
  now: number,
  style: WorkflowViewStyle,
): LevelContent {
  const agent = sel.agent;
  if (!agent) return { rows: [style.dim(fit("No agent selected.", width))], hints: ["esc back"] };

  const layout = agentLevelLayout(width, body + DETAIL_CHROME, sel);
  const card = agentCardLines(agent, layout.cardWidth, now, style, state.expanded);
  const maxScroll = Math.max(0, card.length - layout.cardRows);
  const scroll = clamp(state.cardScroll, 0, maxScroll);
  const shown = card.slice(scroll, scroll + layout.cardRows);
  const indicator = maxScroll > 0 ? scrollIndicator(scroll, scroll + shown.length, card.length) : undefined;

  const hints: string[] = [];
  if (sel.agents.length > 1) hints.push("↑↓ agent");
  if (maxScroll > 0) hints.push("j/k scroll");
  hints.push(state.expanded ? "⏎ collapse" : "⏎ expand");
  if (agent.status === "running" || agent.status === "queued") hints.push("x stop");
  hints.push("esc back");

  if (!layout.split) {
    const title = oneLine(agent.label);
    const header = indicator ? alignRight(title, indicator, width, { gap: 2, minLeft: 6 }) : fit(title, width);
    return { rows: [style.dim(header), ...shown.map((line) => ` ${line}`)], hints };
  }

  const { leftW, rightW } = layout;
  const agentRows = sel.agents.map((a, i) =>
    paneRow(i === sel.agentIndex, agentRowContent(a, leftW - 4, now), leftW, style),
  );
  const lw = windowAround(agentRows.length, sel.agentIndex, layout.cardRows);
  const leftShown = agentRows.slice(lw.start, lw.end);
  const rows = Math.max(1, Math.min(layout.cardRows, Math.max(leftShown.length, shown.length)));
  const footL = lw.end - lw.start < agentRows.length ? scrollIndicator(lw.start, lw.end, agentRows.length) : undefined;

  const lines = [makeBoxTop(agentsTitle(sel, state.agentFilter), oneLine(agent.label), leftW, rightW)];
  for (let i = 0; i < rows; i++) {
    const cardLine = shown[i];
    lines.push(makeBoxRow(leftShown[i] ?? "", cardLine === undefined ? "" : ` ${cardLine}`, leftW, rightW));
  }
  lines.push(makeBoxBottom(leftW, rightW, footL, indicator));
  return { rows: lines, hints };
}

// ── Agent card content ──────────────────────────────────────────────

function pushCollapsible(
  lines: string[],
  section: string[],
  limit: number,
  indent: string,
  width: number,
  style: WorkflowViewStyle,
): void {
  lines.push(...section.slice(0, limit));
  const remaining = section.length - limit;
  if (remaining > 0) lines.push(style.dim(fit(`${indent}… ${plural(remaining, "more line")}`, width)));
}

function indented(text: string, indent: string, width: number): string[] {
  return wrap(text, width - indent.length).map((line) => `${indent}${line}`);
}

/** Every line of the agent card at `width`; the caller scrolls and slices. */
function agentCardLines(
  agent: AgentRecord,
  width: number,
  now: number,
  style: WorkflowViewStyle,
  expanded: boolean,
): string[] {
  const lines: string[] = [];

  const glyph = GLYPH_BY_STATUS[agent.status];
  const styledGlyph =
    agent.status === "done"
      ? style.success(glyph)
      : agent.status === "failed"
        ? style.error(glyph)
        : agent.status === "skipped"
          ? style.dim(glyph)
          : glyph;
  const model = modelOf(agent);
  lines.push(fit(`${styledGlyph} ${LABEL_BY_STATUS[agent.status]}${model ? ` · ${model}` : ""}`, width));

  let stats = `${formatTokens(agent.tokens)} tok · ${plural(agent.toolCallCount, "tool call")} · ${agentDuration(agent, now)}`;
  if (agent.status === "running" && agent.lastProgressAt && now - agent.lastProgressAt >= 30000) {
    stats += ` · idle ${Math.round((now - agent.lastProgressAt) / 1000)}s`;
  }
  lines.push(style.dim(fit(stats, width)), "");

  // Prompt: the script's task when collapsed, the full prompt sent to the agent when expanded.
  lines.push(style.bold(fit("Prompt", width)));
  const prompt = indented(expanded ? (agent.prompt ?? agent.promptPreview) : agent.promptPreview, "  ", width);
  pushCollapsible(lines, prompt, expanded ? prompt.length : PROMPT_COLLAPSED_LINES, "  ", width, style);
  lines.push("");

  // Activity
  const calls = agent.toolCalls;
  const total = Math.max(agent.toolCallCount, calls.length);
  const activityTitle =
    calls.length === 0
      ? "Activity"
      : expanded
        ? "Activity · ⏎ collapse"
        : total > COLLAPSED_CALLS
          ? `Activity · last ${Math.min(COLLAPSED_CALLS, calls.length)} of ${total}`
          : "Activity · ⏎ expand";
  lines.push(style.bold(fit(activityTitle, width)));
  if (calls.length === 0) {
    lines.push(style.dim(fit(agent.status === "running" ? "  No tool calls yet." : "  No tool calls.", width)));
  } else if (expanded) {
    for (const call of calls) {
      const glyphText = call.running ? "⏺" : call.isError ? "✘" : "✔";
      lines.push(...indented(`${glyphText} ${oneLine(call.name)}(${argsSummary(call.args)})`, "  ", width));
      if (call.result)
        lines.push(...indented(call.result, "    ", width).map((l) => (call.isError ? style.error(l) : l)));
    }
  } else {
    for (const call of calls.slice(-COLLAPSED_CALLS)) {
      const glyphText = call.running ? "⏺" : call.isError ? "✘" : "✔";
      lines.push(fit(`  ${glyphText} ${oneLine(call.name)}(${argsSummary(call.args, 40)})`, width));
    }
  }
  lines.push("");

  // Outcome
  lines.push(style.bold(fit("Outcome", width)));
  const outcomeLimit = expanded ? Number.POSITIVE_INFINITY : OUTCOME_COLLAPSED_LINES;
  if (agent.status === "done") {
    const text = formatResult(agent.result);
    if (text.length === 0) lines.push(style.dim(fit("  (empty)", width)));
    else pushCollapsible(lines, indented(text, "  ", width), outcomeLimit, "  ", width, style);
  } else if (agent.status === "failed" && agent.error) {
    const error = indented(agent.error, "  ", width).map((l) => style.error(l));
    pushCollapsible(lines, error, outcomeLimit, "  ", width, style);
  } else if (agent.status === "running" && agent.text.trim().length > 0) {
    // Live output: the latest streamed text, its tail when collapsed.
    const live = indented(agent.text, "  ", width).map((l) => style.dim(l));
    lines.push(...(expanded ? live : live.slice(-OUTCOME_COLLAPSED_LINES)));
  } else {
    const note =
      agent.status === "running"
        ? "Still running…"
        : agent.status === "queued"
          ? "Waiting for an agent slot."
          : agent.status === "stopped"
            ? "The workflow stopped before this agent finished."
            : agent.status === "skipped"
              ? "Skipped by user."
              : "";
    if (note) lines.push(...indented(note, "  ", width).map((l) => style.dim(l)));
  }

  if (agent.truncated) lines.push(style.dim(fit("  (output truncated)", width)));
  return lines;
}

/** `key: value` summary of JSON call arguments on one line; `valueCap` limits each value when collapsed. */
function argsSummary(args: string, valueCap?: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return oneLine(args);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return oneLine(args);
  const entries: [string, unknown][] = Object.entries(parsed);
  const shown = valueCap ? entries.slice(0, 3) : entries;
  const parts = shown.map(([key, value]) => {
    const text = oneLine(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));
    return `${key}: ${valueCap ? fit(text, valueCap) : text}`;
  });
  if (shown.length < entries.length) parts.push("…");
  return parts.join(", ");
}

function formatResult(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : value;
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

// ── Component ───────────────────────────────────────────────────────

export interface WorkflowViewComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose(): void;
}

export interface WorkflowViewTUI {
  requestRender(): void;
  terminal?: { rows: number };
}

export interface WorkflowViewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Reads through `Reflect.get` so pi's `new Proxy({}, { get })` theme (no `has` trap) passes. */
function isWorkflowViewTheme(value: unknown): value is WorkflowViewTheme {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "fg") === "function" &&
    typeof Reflect.get(value, "bold") === "function"
  );
}

export function themeStyle(theme: unknown): WorkflowViewStyle {
  if (!isWorkflowViewTheme(theme)) return PLAIN_STYLE;
  return {
    selected: (s) => theme.fg("accent", s),
    success: (s) => theme.fg("success", s),
    error: (s) => theme.fg("error", s),
    dim: (s) => theme.fg("dim", s),
    bold: (s) => theme.bold(s),
    title: (s) => theme.fg("accent", s),
  };
}

function initialViewState(runs: readonly RunRecord[], runId?: string): ViewState {
  const first = runs[0];
  const requested = runId === undefined ? undefined : runs.find((run) => run.id === runId);
  return {
    // Opens straight into the detail when a run is requested or exactly one run exists.
    mode: requested !== undefined || runs.length === 1 ? "detail" : "list",
    selectedRunId: requested?.id ?? first?.id ?? "",
    level: "phases",
    selectedPhaseIndex: 0,
    selectedAgentId: undefined,
    cardScroll: 0,
    expanded: false,
    agentFilter: undefined,
    closeOnBack: requested !== undefined,
  };
}

/** Lines left for the view after the host's status line and footer. */
function viewHeight(tui: WorkflowViewTUI): number {
  const rows = tui.terminal?.rows;
  return Math.max(10, (typeof rows === "number" && rows > 0 ? rows : 30) - 6);
}

export function createWorkflowViewComponent(
  tui: WorkflowViewTUI,
  source: WorkflowRunSource,
  theme: unknown,
  done: (result: unknown) => void,
  runId?: string,
): WorkflowViewComponent {
  const style = themeStyle(theme);
  let runs = [...source.list()];
  let state = initialViewState(runs, runId);
  let lastWidth = 80;
  let disposed = false;

  let unsubscribe: (() => void) | undefined = source.subscribe(() => {
    if (disposed) return;
    runs = [...source.list()];
    tui.requestRender();
  });

  let timerHandle: NodeJS.Timeout | undefined;
  function startTimer(): void {
    if (timerHandle || disposed) return;
    timerHandle = setTimeout(function tick() {
      if (!disposed && runs.some((r) => r.status === "running")) {
        tui.requestRender();
        timerHandle = setTimeout(tick, 1000);
      } else {
        timerHandle = undefined;
      }
    }, 1000);
  }
  startTimer();

  function dispose(): void {
    disposed = true;
    clearTimeout(timerHandle);
    timerHandle = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return {
    render(width: number): string[] {
      lastWidth = width;
      startTimer();
      return renderWorkflowView(state, runs, { width, height: viewHeight(tui), now: Date.now(), style });
    },

    handleInput(data: string): void {
      if (disposed) return;
      const result = reduceWorkflowViewKey(state, normalizeKey(data), runs, {
        width: lastWidth,
        height: viewHeight(tui),
      });
      state = result.state;

      const action = result.action;
      if (action?.type === "close") {
        dispose();
        done(undefined);
        return;
      }
      if (action?.type === "stopRun") source.stopRun(action.runId);
      if (action?.type === "stopAgent") source.stopAgent(action.runId, action.agentId);
      tui.requestRender();
    },

    invalidate(): void {
      // Render keeps no cache.
    },

    dispose,
  };
}

// Minimal ui type for openWorkflowsView
export interface WorkflowViewUI {
  custom: (
    factory: (
      tui: WorkflowViewTUI,
      theme: unknown,
      keybindings: unknown,
      done: (result: unknown) => void,
    ) => WorkflowViewComponent,
    options?: { overlay?: boolean },
  ) => Promise<unknown>;
}

// ── Entry point ─────────────────────────────────────────────────────

export function openWorkflowsView(ui: WorkflowViewUI, source: WorkflowRunSource, runId?: string): void {
  ui.custom((tui, theme, _keybindings, done) => createWorkflowViewComponent(tui, source, theme, done, runId), {
    overlay: false,
  }).catch(() => {
    // Fire-and-forget: the host cancels the view on teardown.
  });
}
