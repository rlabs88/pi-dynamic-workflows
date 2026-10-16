import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, RunRecord, ToolCallRecord, WorkflowRunSource } from "../src/run-store.js";
import {
  createWorkflowViewComponent,
  normalizeKey,
  reduceWorkflowViewKey,
  renderWorkflowView,
  renderWorkflowViewUnclamped,
  type ViewState,
  type WorkflowViewStyle,
} from "../src/workflow-view.js";

// Identity style: no ANSI codes, so tests read plain text.
const plain: WorkflowViewStyle = {
  selected: (s) => s,
  success: (s) => s,
  error: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
  title: (s) => s,
};

const NOW = 100_000;
const VIEWPORT = { width: 80, height: 24 };

// ── Fixtures ────────────────────────────────────────────────────────

function toolCall(id: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id, name: "read", args: JSON.stringify({ path: "/tmp/test" }), running: false, ...overrides };
}

function agent(id: number, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    label: `agent-${id}`,
    phase: "Inspect",
    status: "done",
    queuedAt: 1000,
    startedAt: 1000,
    endedAt: 5000,
    lastProgressAt: 4500,
    prompt: "Step 1: Read the file\nStep 2: Summarize\nStep 3: Report",
    promptPreview: "Step 1: Read the file",
    model: "gpt-4",
    tokens: 48900,
    toolCalls: [
      toolCall(`tc_${id}_1`),
      toolCall(`tc_${id}_2`, {
        name: "write",
        args: JSON.stringify({ path: "/tmp/out", content: "test" }),
        result: "Done",
      }),
    ],
    toolCallCount: 2,
    text: "",
    result: { summary: "The file exports add and mul." },
    truncated: false,
    ...overrides,
  };
}

function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    name: `run-${id}`,
    description: `Description for ${id}`,
    status: "completed",
    startedAt: 1000,
    endedAt: 55000,
    phases: ["Inspect"],
    logs: [],
    agents: [agent(1), agent(2)],
    ...overrides,
  };
}

/** Phases Inspect (done, done, running), Review (none), Build (failed, skipped), synthetic Agents (stopped, queued). */
function phasedRun(id = "wf_1"): RunRecord {
  return run(id, {
    status: "running",
    endedAt: undefined,
    phases: ["Inspect", "Review", "Build"],
    agents: [
      agent(1),
      agent(2),
      agent(3, { status: "running", endedAt: undefined, toolCalls: [], toolCallCount: 0, result: undefined }),
      agent(4, { phase: "Build", status: "failed", error: "SyntaxError: Unexpected token", result: undefined }),
      agent(5, { phase: "Build", status: "skipped", result: undefined }),
      agent(6, { phase: undefined, status: "stopped", result: undefined }),
      agent(7, { phase: undefined, status: "queued", startedAt: undefined, endedAt: undefined, result: undefined }),
    ],
  });
}

function listState(selectedRunId = ""): ViewState {
  return {
    mode: "list",
    selectedRunId,
    level: "phases",
    selectedPhaseIndex: 0,
    selectedAgentId: undefined,
    cardScroll: 0,
    expanded: false,
    agentFilter: undefined,
  };
}

function detail(overrides: Partial<ViewState> = {}): ViewState {
  return { ...listState("wf_1"), mode: "detail", ...overrides };
}

/** Renders through the backstop and asserts the backstop changed nothing (T2): the renderers fit on their own. */
function view(state: ViewState, runs: readonly RunRecord[], size: { width?: number; height?: number } = {}): string[] {
  const options = { width: size.width ?? 80, height: size.height ?? 60, now: NOW, style: plain };
  const lines = renderWorkflowView(state, runs, options);
  assert.deepEqual(renderWorkflowViewUnclamped(state, runs, options), lines, "the backstop changed a line");
  return lines;
}

/** Agent level of a run holding only `a` (no phases, so it sits in the synthetic group). */
function cardView(a: AgentRecord, size: { width?: number; height?: number; expanded?: boolean } = {}): string[] {
  const r = run("wf_card", { phases: [], agents: [{ ...a, phase: undefined }] });
  const state = detail({ selectedRunId: "wf_card", level: "agent", selectedAgentId: a.id, expanded: size.expanded });
  return view(state, [r], size);
}

function hints(lines: string[]): string {
  return lines[lines.length - 1] ?? "";
}

function assertFits(lines: string[], width: number, height: number, label: string): void {
  assert.ok(lines.length <= height, `${label}: ${lines.length} lines exceed height ${height}`);
  const closers: Record<string, string> = { "╭": "╮", "│": "│", "╰": "╯" };
  lines.forEach((line, i) => {
    assert.ok(visibleWidth(line) <= width, `${label}: line ${i} is ${visibleWidth(line)} > ${width}: ${line}`);
    assert.ok(!/[\n\r]/.test(line), `${label}: line ${i} has a line break: ${JSON.stringify(line)}`);
    const closer = closers[line[0] ?? ""];
    if (closer) assert.equal(line[line.length - 1], closer, `${label}: line ${i} lost its right border: ${line}`);
  });
}

function fakeSource(runs: RunRecord[]): WorkflowRunSource & { listeners: Set<() => void>; stops: string[] } {
  const listeners = new Set<() => void>();
  const stops: string[] = [];
  return {
    listeners,
    stops,
    list: () => runs,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopRun: (runId) => stops.push(`run:${runId}`),
    stopAgent: (runId, agentId) => stops.push(`agent:${runId}:${agentId}`),
  };
}

// ── B2: width ───────────────────────────────────────────────────────

test("B2: every line fits widths 20..200 at every level, filter on and off, with long names", () => {
  const long = "x".repeat(70);
  const agents = Array.from({ length: 120 }, (_, i) =>
    agent(i + 1, {
      label: `agent-${i + 1}-${long}`,
      phase: i < 100 ? `phase-with-a-very-long-title-${long}` : "Short",
      status: i % 2 ? "running" : "done",
      model: `provider/model-${long}`,
      toolCalls: [
        toolCall(`tc_${i}`, { args: JSON.stringify({ path: `/very/long/${long}`, mode: long }), result: long }),
      ],
    }),
  );
  const r = run("wf_1", {
    name: `name-${long}${long}`,
    description: `description ${long} ${long}`,
    phases: [`phase-with-a-very-long-title-${long}`, "Short"],
    status: "stopped",
    agents,
  });
  const runs = [r, run("wf_2", { name: long })];
  const states: ViewState[] = [
    listState("wf_1"),
    detail({ level: "phases" }),
    detail({ level: "phases", selectedPhaseIndex: 1 }),
    detail({ level: "agents", selectedAgentId: 2 }),
    detail({ level: "agents", selectedAgentId: 2, agentFilter: "running" }),
    detail({ level: "agent", selectedAgentId: 2 }),
    detail({ level: "agent", selectedAgentId: 2, agentFilter: "running", expanded: true }),
  ];
  for (let width = 20; width <= 200; width++) {
    for (const state of states) {
      const lines = view(state, runs, { width, height: 30 });
      assertFits(lines, width, 30, `${state.mode}/${state.level} filter=${state.agentFilter} w=${width}`);
    }
  }
});

// ── M1: line breaks ─────────────────────────────────────────────────

test("M1: no rendered line contains a line break, even when target text has them", () => {
  const a = agent(1, {
    label: "multi\nline label",
    status: "failed",
    prompt: "first\r\nsecond\rthird\n\nfifth",
    error: "boom\nstack line\r\nmore",
    toolCalls: [
      toolCall("tc_1", {
        name: "write",
        args: JSON.stringify({ path: "/a", content: "line1\nline2" }),
        result: "out1\nout2",
      }),
    ],
    toolCallCount: 1,
  });
  const b = agent(2, { result: "result line 1\nresult line 2" });
  const r = run("wf_1", {
    name: "name\nwith break",
    description: "desc\r\nwith break",
    phases: ["Phase\none"],
    agents: [
      { ...a, phase: "Phase\none" },
      { ...b, phase: "Phase\none" },
    ],
  });
  for (const width of [50, 100]) {
    for (const state of [
      listState("wf_1"),
      detail(),
      detail({ level: "agents", selectedAgentId: 1 }),
      detail({ level: "agent", selectedAgentId: 1 }),
      detail({ level: "agent", selectedAgentId: 1, expanded: true }),
      detail({ level: "agent", selectedAgentId: 2, expanded: true }),
    ]) {
      const lines = view(state, [r, run("wf_2")], { width, height: 80 });
      assertFits(lines, width, 80, `${state.level} expanded=${state.expanded} w=${width}`);
    }
  }
  const expanded = cardView(a, { width: 100, height: 80, expanded: true }).join("\n");
  for (const piece of ["line1 line2", "out1", "out2", "boom", "stack line", "second", "third", "fifth"]) {
    assert.ok(expanded.includes(piece), `expanded card shows ${piece}`);
  }
});

// ── E4: wrapping ────────────────────────────────────────────────────

function section(lines: string[], title: string): string[] {
  const trimmed = lines.map((l) => l.trim());
  const start = trimmed.findIndex((l) => l === title || l.startsWith(`${title} ·`));
  const end = trimmed.findIndex((l, i) => i > start && l === "");
  return trimmed.slice(start + 1, end < 0 ? undefined : end);
}

test("E4: Prompt and Outcome word-wrap; collapsed limits count wrapped lines", () => {
  const words = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(3, "0")}`).join(" ");
  const a = agent(1, {
    promptPreview: words("p", 40),
    prompt: words("p", 40),
    result: words("r", 200),
    toolCalls: [toolCall("tc_1", { result: words("t", 30) })],
    toolCallCount: 1,
  });

  const collapsed = cardView(a, { width: 50, height: 200 });
  const prompt = section(collapsed, "Prompt");
  assert.equal(prompt.length, 3, "two wrapped prompt lines and the more-lines marker");
  assert.match(prompt[2], /^… \d+ more lines$/);
  assert.ok(
    prompt.slice(0, 2).every((l) => !l.includes("…")),
    "prompt lines are wrapped, not truncated",
  );
  assert.ok(prompt[0].startsWith("p001 p002"));

  const outcome = section(collapsed, "Outcome");
  assert.equal(outcome.length, 21, "twenty wrapped outcome lines and the more-lines marker");
  assert.ok(outcome.slice(0, 20).every((l) => !l.includes("…")));
  const more = Number(/^… (\d+) more lines$/.exec(outcome[20])?.[1]);

  const expanded = cardView(a, { width: 50, height: 400, expanded: true });
  assert.equal(section(expanded, "Outcome").length, 20 + more, "the marker counts the hidden wrapped lines");
  const text = expanded.join(" ");
  for (const word of ["p001", "p040", "r001", "r200", "t001", "t030"]) assert.ok(text.includes(word), `${word} shown`);
});

// ── M2: list selection ──────────────────────────────────────────────

test("M2: the list selects the first run by default and enter opens it", () => {
  const runs = [run("wf_1", { status: "running", endedAt: undefined }), run("wf_2")];
  const source = fakeSource(runs);
  const component = createWorkflowViewComponent({ requestRender: () => {} }, source, undefined, () => {});
  const list = component.render(80);
  assert.ok(
    list.some((l) => l.includes("❯") && l.includes("run-wf_1")),
    "first run row is selected",
  );
  assert.ok(hints(list).includes("x stop"), "stop hint for the selected running run");

  component.handleInput?.("\r");
  const opened = component.render(80);
  assert.ok(
    opened.some((l) => l.includes("Description for wf_1")),
    "enter opened the first run",
  );
  component.dispose();
});

test("M2: a vanished selection falls back to the first run", () => {
  const runs = [run("wf_1"), run("wf_2")];
  const lines = view(listState("wf_gone"), runs);
  assert.ok(lines.some((l) => l.includes("❯") && l.includes("run-wf_1")));
  assert.equal(reduceWorkflowViewKey(listState("wf_gone"), "enter", runs, VIEWPORT).state.selectedRunId, "wf_1");
  assert.equal(reduceWorkflowViewKey(listState("wf_gone"), "down", runs, VIEWPORT).state.selectedRunId, "wf_2");
});

// ── M3: agent level ↑/↓ ─────────────────────────────────────────────

test("M3: ↑/↓ at the agent level move between agents and stay at the agent level", () => {
  const runs = [phasedRun()];
  let state = detail({ level: "agent", selectedAgentId: 1 });
  state = reduceWorkflowViewKey(state, "down", runs, VIEWPORT).state;
  assert.equal(state.level, "agent");
  assert.equal(state.selectedAgentId, 2);
  state = reduceWorkflowViewKey(state, "down", runs, VIEWPORT).state;
  assert.equal(state.selectedAgentId, 3);
  state = reduceWorkflowViewKey(state, "up", runs, VIEWPORT).state;
  assert.equal(state.level, "agent");
  assert.equal(state.selectedAgentId, 2);
  const lines = view(state, runs, { width: 100 });
  assert.ok(lines[3].includes("agent-2"), "card title follows the selection");
});

// ── M4: phase scoping ───────────────────────────────────────────────

test("M4: agents and agent levels list only the selected phase's agents", () => {
  const runs = [phasedRun()];
  // Build is phase index 2.
  let state = reduceWorkflowViewKey(detail({ selectedPhaseIndex: 2 }), "enter", runs, VIEWPORT).state;
  assert.equal(state.level, "agents");
  assert.equal(state.selectedAgentId, 4);
  for (let i = 0; i < 3; i++) state = reduceWorkflowViewKey(state, "up", runs, VIEWPORT).state;
  assert.equal(state.selectedAgentId, 4, "↑ stays inside the phase");

  for (const width of [100, 50]) {
    const agentsLevel = view(state, runs, { width }).join("\n");
    assert.ok(agentsLevel.includes("Build · 2 agents"));
    assert.ok(agentsLevel.includes("agent-4") && agentsLevel.includes("agent-5"));
    assert.ok(!agentsLevel.includes("agent-1"), "other phases' agents are not listed");
  }
  const agentLevel = view(reduceWorkflowViewKey(state, "enter", runs, VIEWPORT).state, runs, { width: 100 });
  assert.ok(agentLevel[3].includes("Build · 2 agents"));
  assert.ok(!agentLevel.join("\n").includes("agent-1"));

  // The synthetic Agents phase (index 3) holds agents without a known phase.
  const synthetic = reduceWorkflowViewKey(detail({ selectedPhaseIndex: 3 }), "enter", runs, VIEWPORT).state;
  assert.equal(synthetic.selectedAgentId, 6);
  const syntheticLines = view(synthetic, runs, { width: 100 }).join("\n");
  assert.ok(syntheticLines.includes("Agents · 2 agents"));
  assert.ok(syntheticLines.includes("agent-7") && !syntheticLines.includes("agent-4"));
});

// ── M5: height ──────────────────────────────────────────────────────

test("M5: lists are windowed around the selection to fit the height, with a scroll indicator", () => {
  // A three-line task keeps the narrow card taller than the 20-row viewport.
  const promptPreview = "Step 1: Read the file\nStep 2: Summarize\nStep 3: Report";
  const many = run("wf_1", { agents: Array.from({ length: 60 }, (_, i) => agent(i + 1, { promptPreview })) });
  for (const width of [100, 50]) {
    for (const level of ["phases", "agents", "agent"] as const) {
      const lines = view(detail({ level, selectedAgentId: 45 }), [many], { width, height: 20 });
      assertFits(lines, width, 20, `${level} w=${width}`);
      assert.match(hints(lines), /esc back/, `${level} w=${width}: hints stay on screen`);
      // The narrow agent level shows only the card; its title names the agent.
      if (level === "agent" && width < 64) {
        assert.match(lines[3], /^agent-45 +↑ 1–\d+ of \d+ ↓$/);
        continue;
      }
      if (level !== "phases") {
        assert.ok(
          lines.some((l) => /❯ ✔ agent-45\b/.test(l)),
          `${level} w=${width}: selected row is visible`,
        );
      }
      if (level !== "phases" || width >= 64) {
        assert.ok(
          lines.some((l) => /↑ \d+–\d+ of 60 ↓/.test(l)),
          `${level} w=${width}: indicator shows the window`,
        );
      }
    }
    const titles = Array.from({ length: 60 }, (_, i) => `P${i + 1}`);
    const phased = run("wf_1", { phases: titles, agents: titles.map((phase, i) => agent(i + 1, { phase })) });
    const lines = view(detail({ selectedPhaseIndex: 45 }), [phased], { width, height: 20 });
    assertFits(lines, width, 20, `60 phases w=${width}`);
    assert.ok(
      lines.some((l) => /❯ ✔ P46 /.test(l)),
      `60 phases w=${width}: selected phase is visible`,
    );
    assert.ok(
      lines.some((l) => /↑ \d+–\d+ of 60 ↓/.test(l)),
      `60 phases w=${width}: indicator`,
    );
  }

  const runs = Array.from({ length: 10 }, (_, i) => run(`wf_${i}`));
  const list = view(listState("wf_8"), runs, { width: 80, height: 8 });
  assertFits(list, 80, 8, "list");
  assert.ok(list.some((l) => l.includes("❯") && l.includes("run-wf_8")));
  assert.ok(list.some((l) => /↑ \d+–\d+ of 10 ↓/.test(l)));
});

test("M5: card scroll is clamped at both ends", () => {
  const calls = Array.from({ length: 200 }, (_, i) => toolCall(`tc_${i}`, { result: `result ${i}` }));
  const a = agent(1, { phase: undefined, toolCalls: calls, toolCallCount: 200, truncated: true });
  const runs = [run("wf_1", { phases: [], agents: [a] })];
  const viewport = { width: 100, height: 24 };
  let state = detail({ level: "agent", selectedAgentId: 1, expanded: true });

  for (let i = 0; i < 1000; i++) state = reduceWorkflowViewKey(state, "j", runs, viewport).state;
  const max = state.cardScroll;
  assert.ok(max > 0);
  const bottom = view(state, runs, viewport);
  assert.ok(
    bottom.some((l) => l.includes("(output truncated)")),
    "the last card line is visible at the end",
  );
  assert.equal(reduceWorkflowViewKey(state, "j", runs, viewport).state.cardScroll, max, "j stops at the end");
  assert.equal(reduceWorkflowViewKey(state, "pagedown", runs, viewport).state.cardScroll, max);
  assert.equal(reduceWorkflowViewKey(state, "k", runs, viewport).state.cardScroll, max - 1, "k moves at once");
  assert.deepEqual(view({ ...state, cardScroll: 10_000 }, runs, viewport), bottom, "render clamps a stale scroll");

  assert.equal(reduceWorkflowViewKey({ ...state, cardScroll: 0 }, "k", runs, viewport).state.cardScroll, 0);
  assert.equal(reduceWorkflowViewKey({ ...state, cardScroll: 5 }, "pageup", runs, viewport).state.cardScroll, 0);
});

// ── E1: phases pane width ───────────────────────────────────────────

test("E1: the phases pane is as narrow as its content, at most 30 columns", () => {
  const short = run("wf_1", { phases: ["Read"], agents: [agent(1, { phase: "Read" })] });
  const top = view(detail(), [short], { width: 140 })[3];
  assert.equal(top.indexOf("┬"), 15, `pane fits " ❯ ✔ Read 1/1 ": ${top}`);

  const long = run("wf_1", { phases: ["A".repeat(80)], agents: [agent(1, { phase: "A".repeat(80) })] });
  assert.equal(view(detail(), [long], { width: 140 })[3].indexOf("┬"), 31);
});

// ── E2: agent rows ──────────────────────────────────────────────────

test("E2: agent rows keep a selection gutter and right-align model, stats and duration", () => {
  const runs = [phasedRun()];
  const phases = view(detail(), runs, { width: 100 });
  assert.match(phases[4], /│ {3}✔ agent-1 +gpt-4 · 48\.9k tok · 2 tool calls {2}4s │$/);

  const agents = view(detail({ level: "agents", selectedAgentId: 2 }), runs, { width: 100 });
  assert.match(agents[4], /│ {3}✔ agent-1 /, "unselected rows keep a two-column gutter");
  assert.match(agents[5], /│ ❯ ✔ agent-2 +gpt-4 · 48\.9k tok · 2 tool calls {2}4s │$/);

  const narrow = (width: number) => view(detail({ level: "agents", selectedAgentId: 1 }), runs, { width })[4];
  assert.match(narrow(60), /❯ ✔ agent-1 +gpt-4 · 48\.9k tok · 2 tool calls {2}4s $/);
  assert.match(narrow(48), /❯ ✔ agent-1 +48\.9k tok · 2 tool calls {2}4s $/, "drops the model first");
  assert.match(narrow(30), /❯ ✔ agent-1 +4s $/, "then the stats");
});

// ── m1: filter ──────────────────────────────────────────────────────

test("m1: f cycles all → each present status → all, resets on leaving, applies at the agent level", () => {
  const runs = [phasedRun()];
  let state = detail({ level: "agents", selectedAgentId: 1 });
  const seen: (string | undefined)[] = [];
  for (let i = 0; i < 3; i++) {
    state = reduceWorkflowViewKey(state, "f", runs, VIEWPORT).state;
    seen.push(state.agentFilter);
  }
  assert.deepEqual(seen, ["running", "done", undefined]);

  state = reduceWorkflowViewKey(state, "f", runs, VIEWPORT).state;
  assert.equal(state.agentFilter, "running");
  assert.equal(state.selectedAgentId, 3, "selection moves into the filtered list");
  assert.ok(view(state, runs, { width: 100 }).join("\n").includes("showing running"));
  const back = reduceWorkflowViewKey(state, "escape", runs, VIEWPORT).state;
  assert.equal(back.agentFilter, undefined, "leaving the agents level clears the filter");

  let card = detail({ level: "agent", selectedAgentId: 1, agentFilter: "done" });
  card = reduceWorkflowViewKey(card, "down", runs, VIEWPORT).state;
  card = reduceWorkflowViewKey(card, "down", runs, VIEWPORT).state;
  assert.equal(card.selectedAgentId, 2, "the running agent is filtered out at the agent level");
  assert.ok(!view(card, runs, { width: 100 }).join("\n").includes("agent-3"));
});

// ── m2: hints ───────────────────────────────────────────────────────

test("m2: hints list only keys that act", () => {
  const runs = [phasedRun()];
  const agentsLevel = view(detail({ level: "agents", selectedAgentId: 3 }), runs, { width: 50 });
  assert.equal(hints(agentsLevel), "↑↓ agent · f filter · enter card · esc back");
  assert.equal(
    reduceWorkflowViewKey(detail({ level: "agents", selectedAgentId: 3 }), "x", runs, VIEWPORT).action,
    undefined,
  );

  const single = run("wf_1", { phases: ["Inspect"], agents: [agent(1)] });
  assert.equal(hints(view(detail(), [single])), "↑↓ select · esc back");
  assert.equal(hints(view(detail({ level: "agents", selectedAgentId: 1 }), [single])), "enter card · esc back");
  assert.equal(hints(view(detail({ level: "agent", selectedAgentId: 1 }), [single])), "⏎ expand · esc back");
  assert.equal(hints(view(listState("wf_1"), [single])), "enter view · esc close");

  const running = view(detail({ level: "agent", selectedAgentId: 3 }), runs, { width: 100, height: 14 });
  assert.equal(hints(running), "↑↓ agent · j/k scroll · ⏎ expand · x stop · esc back");
});

// ── m6 / N1: theme guard ────────────────────────────────────────────

test("N1: the component styles with a plain theme object and with pi's Proxy theme, plain text otherwise", () => {
  const source = fakeSource([run("wf_1"), run("wf_2")]);
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `*${text}*` };
  // pi builds its theme as `new Proxy({}, { get })` with no `has` trap, so `"fg" in theme` is false.
  const piTheme = new Proxy({}, { get: (_t, p) => Reflect.get(theme, p) });
  for (const host of [theme, piTheme]) {
    const themed = createWorkflowViewComponent({ requestRender: () => {} }, source, host, () => {});
    assert.ok(themed.render(80)[0].includes("<accent> Dynamic workflows </>"));
    themed.dispose();
  }

  const fallback = createWorkflowViewComponent({ requestRender: () => {} }, source, {}, () => {});
  const lines = fallback.render(80);
  assert.ok(lines[0].startsWith(" Dynamic workflows "));
  assert.ok(lines.every((l) => !l.includes("</>")));
  fallback.dispose();
});

// ── m7: phase order ─────────────────────────────────────────────────

test("m7: phases keep first-seen order, including integer-like and __proto__ titles", () => {
  const titles = ["Setup", "2", "1", "__proto__"];
  const r = run("wf_1", { phases: titles, agents: titles.map((phase, i) => agent(i + 1, { phase })) });
  const rows = view(detail(), [r], { width: 50 }).slice(4, 8);
  assert.deepEqual(
    rows.map((l) => /[✔✘\d] (\S+) +\d+\/\d+/.exec(l)?.[1]),
    titles,
  );
});

// ── Component lifecycle ─────────────────────────────────────────────

test("one run auto-opens the detail in the component's initial state", () => {
  const component = createWorkflowViewComponent(
    { requestRender: () => {} },
    fakeSource([run("wf_1")]),
    undefined,
    () => {},
  );
  const lines = component.render(80);
  assert.ok(lines.some((l) => l.includes("Description for wf_1")));
  assert.ok(lines.some((l) => l.includes("Phases")));
  assert.ok(!lines.some((l) => l.includes("Dynamic workflows")));
  component.dispose();
});

test("a requested run id opens that run's detail even when several runs exist", () => {
  const component = createWorkflowViewComponent(
    { requestRender: () => {} },
    fakeSource([run("wf_1"), run("wf_2")]),
    undefined,
    () => {},
    "wf_2",
  );
  const lines = component.render(80);
  assert.ok(lines.some((l) => l.includes("Description for wf_2")));
  assert.ok(!lines.some((l) => l.includes("Dynamic workflows")));
  component.dispose();
});

test("escape from a requested run's detail closes the view instead of opening the run list", () => {
  let closed = 0;
  const component = createWorkflowViewComponent(
    { requestRender: () => {} },
    fakeSource([run("wf_1"), run("wf_2")]),
    undefined,
    () => {
      closed++;
    },
    "wf_2",
  );
  component.handleInput("\x1b");
  assert.equal(closed, 1);
  component.dispose();
});

test("dispose unsubscribes and stops the tick", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let renders = 0;
  const source = fakeSource([run("wf_1", { status: "running", endedAt: undefined })]);
  const component = createWorkflowViewComponent({ requestRender: () => renders++ }, source, undefined, () => {});
  component.render(80);
  t.mock.timers.tick(1000);
  assert.equal(renders, 1, "the tick re-renders a running run");
  assert.equal(source.listeners.size, 1);

  component.dispose();
  assert.equal(source.listeners.size, 0, "store subscription removed");
  t.mock.timers.tick(5000);
  component.render(80);
  t.mock.timers.tick(5000);
  assert.equal(renders, 1, "no tick after dispose");
});

test("escape closes the view and releases the subscription", () => {
  let closed = 0;
  const source = fakeSource([run("wf_1"), run("wf_2")]);
  const component = createWorkflowViewComponent({ requestRender: () => {} }, source, undefined, () => closed++);
  component.handleInput?.("\x1b");
  assert.equal(closed, 1);
  assert.equal(source.listeners.size, 0);
});

// ── List ────────────────────────────────────────────────────────────

test("list header counts running, completed, stopped and failed runs separately, omitting zeros", () => {
  const mixed = [
    run("wf_1", { status: "running", endedAt: undefined }),
    run("wf_2"),
    run("wf_3", { status: "failed" }),
    run("wf_4", { status: "stopped" }),
  ];
  assert.match(view(listState(), mixed)[0], / 1 running · 1 completed · 1 stopped · 1 failed $/);
  const header = view(listState(), [run("wf_1"), run("wf_2")])[0];
  assert.match(header, / 2 completed $/);
  assert.ok(!header.includes("running") && !header.includes("failed") && !header.includes("stopped"));
});

test("empty state shows placeholder text", () => {
  const lines = view(listState(), []);
  assert.ok(lines.join("\n").includes("No dynamic workflows in this session."));
});

// ── Navigation ──────────────────────────────────────────────────────

test("navigation: enter/right descends through levels and toggles expand at the card", () => {
  const runs = [run("wf_0"), phasedRun()];
  for (const key of ["enter", "right"] as const) {
    let r = reduceWorkflowViewKey(listState("wf_1"), key, runs, VIEWPORT);
    assert.equal(r.state.mode, "detail");
    assert.equal(r.state.level, "phases");
    r = reduceWorkflowViewKey(r.state, key, runs, VIEWPORT);
    assert.equal(r.state.level, "agents");
    assert.equal(r.state.selectedAgentId, 1);
    r = reduceWorkflowViewKey(r.state, key, runs, VIEWPORT);
    assert.equal(r.state.level, "agent");
    r = reduceWorkflowViewKey(r.state, key, runs, VIEWPORT);
    assert.equal(r.state.level, "agent");
    assert.equal(r.state.expanded, true);
  }
});

test("navigation: enter on a phase without agents stays at the phases level", () => {
  const r = reduceWorkflowViewKey(detail({ selectedPhaseIndex: 1 }), "enter", [phasedRun()], VIEWPORT);
  assert.equal(r.state.level, "phases");
});

test("navigation: escape/left ascends and closes from the list", () => {
  const runs = [phasedRun()];
  for (const key of ["escape", "left"] as const) {
    assert.equal(reduceWorkflowViewKey(listState("wf_1"), key, runs, VIEWPORT).action?.type, "close");
    assert.equal(reduceWorkflowViewKey(detail(), key, runs, VIEWPORT).state.mode, "list");
    assert.equal(
      reduceWorkflowViewKey(detail({ level: "agents", selectedAgentId: 1 }), key, runs, VIEWPORT).state.level,
      "phases",
    );
    const up = reduceWorkflowViewKey(detail({ level: "agent", selectedAgentId: 2 }), key, runs, VIEWPORT).state;
    assert.equal(up.level, "agents");
    assert.equal(up.selectedAgentId, 2);
  }
});

// ── x ───────────────────────────────────────────────────────────────

test("x: stops the selected running run, workflow, or running/queued agent only", () => {
  const live = phasedRun();
  const done = run("wf_2");
  const runs = [live, done];
  assert.deepEqual(reduceWorkflowViewKey(listState("wf_1"), "x", runs, VIEWPORT).action, {
    type: "stopRun",
    runId: "wf_1",
  });
  assert.equal(reduceWorkflowViewKey(listState("wf_2"), "x", runs, VIEWPORT).action, undefined);
  assert.deepEqual(reduceWorkflowViewKey(detail(), "x", runs, VIEWPORT).action, { type: "stopRun", runId: "wf_1" });
  assert.equal(reduceWorkflowViewKey(detail({ selectedRunId: "wf_2" }), "x", runs, VIEWPORT).action, undefined);
  assert.equal(
    reduceWorkflowViewKey(detail({ level: "agents", selectedAgentId: 3 }), "x", runs, VIEWPORT).action,
    undefined,
  );

  const at = (selectedPhaseIndex: number, selectedAgentId: number) =>
    reduceWorkflowViewKey(detail({ level: "agent", selectedPhaseIndex, selectedAgentId }), "x", runs, VIEWPORT).action;
  assert.deepEqual(at(0, 3), { type: "stopAgent", runId: "wf_1", agentId: 3 }, "running agent");
  assert.deepEqual(at(3, 7), { type: "stopAgent", runId: "wf_1", agentId: 7 }, "queued agent");
  assert.equal(at(0, 1), undefined, "done agent");
  assert.equal(at(3, 6), undefined, "stopped agent");
});

test("x on a queued agent reaches the source through the component", () => {
  const source = fakeSource([phasedRun(), run("wf_2")]);
  const component = createWorkflowViewComponent({ requestRender: () => {} }, source, undefined, () => {});
  component.render(100);
  // list → phases → down ×3 to the synthetic Agents phase → agents → down to the queued agent → card → x
  for (const key of ["\r", "\x1b[B", "\x1b[B", "\x1b[B", "\r", "\x1b[B", "\r", "x"]) component.handleInput?.(key);
  assert.deepEqual(source.stops, ["agent:wf_1:7"]);
  component.dispose();
});

// ── Card content ────────────────────────────────────────────────────

test("card: a structured result renders as pretty JSON", () => {
  const joined = cardView(agent(1), { expanded: true }).join("\n");
  assert.ok(joined.includes('"summary": "The file exports add and mul."'));
});

test("card: a failed agent shows its error", () => {
  const joined = cardView(agent(4, { status: "failed", error: "SyntaxError: Unexpected token" })).join("\n");
  assert.ok(joined.includes("SyntaxError: Unexpected token"));
});

test("N3: collapsed Prompt shows the script's task, expanded shows the full prompt sent to the agent", () => {
  const task = "Read math.js and list every exported function with a short summary each";
  const a = agent(1, { promptPreview: task, prompt: `Workflow phase: Inspect\n\nTask label: agent-1\n\n${task}` });
  const collapsed = section(cardView(a, { width: 50 }), "Prompt");
  assert.equal(collapsed.length, 2, "two wrapped lines of the task");
  assert.ok(collapsed[0].includes("Read math.js"));
  assert.ok(!collapsed.join("\n").includes("Workflow phase"));
  const expanded = cardView(a, { width: 50, height: 80, expanded: true }).join("\n");
  assert.ok(expanded.includes("Workflow phase: Inspect") && expanded.includes("Task label: agent-1"));
});

test("live output: a running agent's Outcome shows its streamed text tail, or Still running… before any", () => {
  const running = { status: "running" as const, endedAt: undefined, result: undefined };
  assert.deepEqual(section(cardView(agent(3, running), { width: 50 }), "Outcome"), ["Still running…"]);
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const live = section(cardView(agent(3, { ...running, text }), { width: 50, height: 80 }), "Outcome");
  assert.equal(live.length, 20, "last 20 lines when collapsed");
  assert.equal(live[0], "line 11");
  assert.equal(live[19], "line 30");
  const full = section(cardView(agent(3, { ...running, text }), { width: 50, height: 80, expanded: true }), "Outcome");
  assert.equal(full.length, 30);
});

test("card: collapsed Activity shows the last 3 calls with · last 3 of N", () => {
  const a = agent(8, {
    toolCalls: ["bash", "read", "write", "grep", "edit"].map((name, i) => toolCall(`tc_${i}`, { name })),
    toolCallCount: 5,
  });
  const joined = cardView(a).join("\n");
  assert.ok(joined.includes("write(") && joined.includes("grep(") && joined.includes("edit("));
  assert.ok(!joined.includes("bash("));
  assert.ok(joined.includes("Activity · last 3 of 5"));
});

test("card: header shows status and model; a non-string model is ignored", () => {
  assert.ok(cardView(agent(1)).some((l) => l.includes("✔ Completed · gpt-4")));
  const objectModel: unknown = { id: "m", provider: "p" };
  const lines = cardView({ ...agent(1), model: objectModel as string });
  assert.ok(lines.some((l) => /│ ✔ Completed +│$/.test(l)));
});

test("card: idle indicator for a running agent without recent progress", () => {
  const joined = cardView(agent(9, { status: "running", endedAt: undefined, lastProgressAt: 5000 })).join("\n");
  assert.ok(joined.includes("idle 95s"));
});

test("card: truncated indicator", () => {
  assert.ok(
    cardView(agent(10, { truncated: true }))
      .join("\n")
      .includes("(output truncated)"),
  );
});

// ── Misc ────────────────────────────────────────────────────────────

test("normalizeKey handles all expected inputs", () => {
  assert.equal(normalizeKey("j"), "j");
  assert.equal(normalizeKey("k"), "k");
  assert.equal(normalizeKey("x"), "x");
  assert.equal(normalizeKey("f"), "f");
  assert.equal(normalizeKey("\r"), "enter");
  assert.equal(normalizeKey("\x1b"), "escape");
  assert.equal(normalizeKey("a"), "other");
  assert.equal(normalizeKey(" "), "other");
});

test("split layout appears only at width ≥ 64", () => {
  const runs = [phasedRun()];
  assert.ok(!view(detail(), runs, { width: 63 }).some((l) => l.includes("╭")));
  assert.ok(view(detail(), runs, { width: 64 }).some((l) => l.includes("╭")));
});

test("reduceWorkflowViewKey does not mutate its input state", () => {
  const state = listState("wf_1");
  const copy = { ...state };
  reduceWorkflowViewKey(state, "enter", [run("wf_1")], VIEWPORT);
  assert.deepEqual(state, copy);
});

// ── Round 2 ─────────────────────────────────────────────────────────

test("N2: a phase added mid-run never moves the selection; x still targets the agent being read", () => {
  const running = { status: "running" as const, endedAt: undefined, result: undefined };
  const r = run("wf_1", {
    status: "running",
    endedAt: undefined,
    phases: ["Scan"],
    agents: [
      agent(1, { ...running, phase: undefined, label: "planner" }),
      agent(2, { ...running, phase: "Scan", label: "scanner" }),
      agent(3, { ...running, phase: "Review", label: "reviewer" }),
    ],
  });
  const runs = [r];
  // An agent's own phase is a group of its own; only phase-less agents go to Agents.
  const phases = view(detail(), runs, { width: 100 }).join("\n");
  assert.ok(/Scan[\s\S]*Review[\s\S]*Agents/.test(phases));

  let state = detail();
  for (const key of ["down", "down", "enter", "enter"] as const)
    state = reduceWorkflowViewKey(state, key, runs, VIEWPORT).state;
  assert.equal(state.level, "agent");
  assert.equal(state.selectedAgentId, 1);

  r.phases.push("Fix");
  r.agents.push(agent(4, { ...running, phase: "Fix", label: "fixer" }));
  const top = view(state, runs, { width: 100 })[3];
  assert.ok(top.includes("Agents · 1 agent") && top.includes("planner"), top);
  assert.deepEqual(reduceWorkflowViewKey(state, "x", runs, VIEWPORT).action, {
    type: "stopAgent",
    runId: "wf_1",
    agentId: 1,
  });
});

test("N5: f never gets stuck on a filter whose status is gone", () => {
  const r = run("wf_1", {
    status: "running",
    phases: ["P"],
    agents: [agent(1, { phase: "P" }), agent(2, { phase: "P", status: "running", endedAt: undefined })],
  });
  let state = reduceWorkflowViewKey(detail({ level: "agents", selectedAgentId: 1 }), "f", [r], VIEWPORT).state;
  assert.equal(state.agentFilter, "running");
  r.agents[1].status = "done";
  assert.ok(hints(view(state, [r], { width: 50 })).includes("f filter"), "the hint stays while a filter is set");
  state = reduceWorkflowViewKey(state, "f", [r], VIEWPORT).state;
  assert.equal(state.agentFilter, undefined);
  const pane = view(state, [r], { width: 50 }).join("\n");
  assert.ok(pane.includes("a2") || pane.includes("agent-2"));
  assert.ok(!pane.includes("No running agents."));
});

test("N6: header and phase ratio count finished agents, not stopped ones; phase mark follows the ✘/✔/number rule", () => {
  const lines = view(detail(), [phasedRun()], { width: 100 });
  assert.match(lines[2], /4\/7 agents/);
  const rows = lines.join("\n");
  assert.match(rows, /1 Inspect +2\/3/);
  assert.match(rows, /✘ Build +2\/2/);
  assert.match(rows, /4 Agents +0\/2/, "a stopped agent keeps the number and is not counted");

  const skipped = run("wf_1", { agents: [agent(1), agent(2, { status: "skipped", result: undefined })] });
  assert.match(view(detail(), [skipped], { width: 100 }).join("\n"), /✔ Inspect +2\/2/);
  const stopped = run("wf_1", { status: "stopped", agents: [agent(1), agent(2, { status: "stopped" })] });
  assert.match(view(detail(), [stopped], { width: 100 }).join("\n"), /1 Inspect +1\/2/);
  const none = run("wf_1", {
    status: "stopped",
    agents: [agent(1, { status: "stopped" }), agent(2, { status: "stopped" })],
  });
  const noneLines = view(detail(), [none], { width: 100 });
  assert.match(noneLines[2], /0\/2 agents · .* · stopped/);
  assert.match(noneLines.join("\n"), /1 Inspect +0\/2/);
});

test("N10: truncation uses the host's default ellipsis", () => {
  const long = run("wf_1", { name: "n".repeat(200) });
  assert.ok(view(listState(), [long, run("wf_2")], { width: 60 })[1].includes("..."));
});

test("N11: stopped agent rows show ◌ and stopped", () => {
  const lines = view(detail({ level: "agents", selectedAgentId: 6, selectedPhaseIndex: 3 }), [phasedRun()], {
    width: 120,
  });
  assert.ok(lines.some((l) => /◌ agent-6 .*stopped · /.test(l)));
});

test("F2: with a status filter, the open card and its x target stay on the agent after it leaves the filter", () => {
  const agents = (first: AgentRecord["status"]) => [
    agent(1, { phase: "P", status: first, endedAt: first === "running" ? undefined : 5000 }),
    agent(2, { phase: "P", status: "running", endedAt: undefined }),
    agent(3, { phase: "P" }),
  ];
  let runs = [run("wf_1", { status: "running", endedAt: undefined, phases: ["P"], agents: agents("running") })];
  let state = detail();
  for (const key of ["enter", "f", "enter"] as const) state = reduceWorkflowViewKey(state, key, runs, VIEWPORT).state;
  assert.equal(state.agentFilter, "running");
  assert.equal(state.selectedAgentId, 1);
  const title = (lines: string[]) => lines.find((l) => l.startsWith("╭")) ?? "";
  assert.match(title(view(state, runs, { width: 100 })), /┬ agent-1 /);

  runs = [run("wf_1", { status: "running", endedAt: undefined, phases: ["P"], agents: agents("done") })];
  assert.match(title(view(state, runs, { width: 100 })), /┬ agent-1 /, "the card did not switch without a key");
  const action = reduceWorkflowViewKey(state, "x", runs, VIEWPORT).action;
  assert.notDeepEqual(action, { type: "stopAgent", runId: "wf_1", agentId: 2 });
});

test("F4: a real phase titled Agents and the synthetic Agents group are selected separately", () => {
  const runs = [
    run("wf_1", {
      status: "running",
      endedAt: undefined,
      phases: ["Agents"],
      agents: [
        agent(1, { phase: undefined, status: "running", endedAt: undefined }),
        agent(2, { phase: "Agents", status: "running", endedAt: undefined }),
      ],
    }),
  ];
  let state = detail();
  for (const key of ["down", "enter"] as const) state = reduceWorkflowViewKey(state, key, runs, VIEWPORT).state;
  assert.equal(state.selectedAgentId, 1, "the phase-less agent is reachable");
  state = reduceWorkflowViewKey(detail(), "enter", runs, VIEWPORT).state;
  assert.equal(state.selectedAgentId, 2);
});

test("F7: the narrow list shows the scroll indicator only when rows are hidden", () => {
  const few = view(detail({ level: "agents", selectedAgentId: 1 }), [run("wf_1")], { width: 50 });
  assert.ok(!few.some((l) => / of \d+ ↓/.test(l)), few.join("\n"));
  const many = run("wf_1", { agents: Array.from({ length: 30 }, (_, i) => agent(i + 1)) });
  const lines = view(detail({ level: "agents", selectedAgentId: 1 }), [many], { width: 50, height: 16 });
  assert.ok(
    lines.some((l) => / of 30 ↓/.test(l)),
    lines.join("\n"),
  );
});

test("F8: the split card's left pane keeps the word stopped for a stopped agent", () => {
  const lines = view(detail({ level: "agent", selectedAgentId: 6, selectedPhaseIndex: 3 }), [phasedRun()], {
    width: 80,
  });
  assert.ok(
    lines.some((l) => /◌ agent-6 +stopped/.test(l.split("│")[1] ?? "")),
    lines.join("\n"),
  );
});

test("P3-1: a long-labelled stopped agent's row keeps the word stopped at every width from 40", () => {
  const stopped = agent(6, { label: "read strings.js and list every export", phase: undefined, status: "stopped" });
  const r = run("wf_1", { status: "stopped", phases: [], agents: [stopped] });
  for (const width of [40, 64, 70, 77, 80]) {
    const levels = width >= 64 ? (["agents", "agent"] as const) : (["agents"] as const);
    for (const level of levels) {
      const lines = view(detail({ level, selectedAgentId: 6 }), [r], { width });
      assertFits(lines, width, 60, `${level}@${width}`);
      const rows = lines.map((l) => (level === "agent" ? (l.split("│")[1] ?? "") : l)).filter((l) => l.includes("◌"));
      assert.equal(rows.length, 1, `${level}@${width}:\n${lines.join("\n")}`);
      assert.match(rows[0], /◌ read.* stopped/, `${level}@${width}:\n${lines.join("\n")}`);
    }
  }
});

test("the detail header shows the run name in the title style", () => {
  const style: WorkflowViewStyle = { ...plain, title: (s) => `<T>${s}</T>` };
  const lines = renderWorkflowView(detail(), [run("wf_1")], { width: 80, height: 40, now: NOW, style });
  assert.ok(lines[1].startsWith("<T>run-wf_1"), lines[1]);
});
