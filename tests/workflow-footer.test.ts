import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord, WorkflowRunSource } from "../src/run-store.js";
import { type FooterUI, installWorkflowFooter, reduceFooterKey, renderFooterLines } from "../src/workflow-footer.js";
import type { WorkflowViewStyle } from "../src/workflow-view.js";

const plain: WorkflowViewStyle = {
  selected: (s) => s,
  success: (s) => s,
  error: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
  title: (s) => s,
};

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";

function run(id: string, status: RunRecord["status"] = "running"): RunRecord {
  return {
    id,
    name: `run-${id}`,
    description: `Description for ${id}`,
    status,
    startedAt: 1000,
    endedAt: status === "running" ? undefined : 2000,
    phases: [],
    logs: [],
    agents: [],
  };
}

type FakeSource = WorkflowRunSource & { listeners: Set<() => void>; stops: string[] };

function fakeSource(runs: RunRecord[]): FakeSource {
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

function notify(source: FakeSource): void {
  for (const listener of source.listeners) listener();
}

interface FooterComponent {
  render(width: number): string[];
}

interface FakeHost {
  requestRender(): void;
  getFocused(): unknown;
}

function isFooterFactory(value: unknown): value is (host: FakeHost, theme: unknown) => FooterComponent {
  return typeof value === "function";
}

function prompt(text = "", autocomplete = false) {
  return { getText: () => text, isAutocompleteActive: () => autocomplete };
}

interface WidgetCall {
  key: string;
  content: unknown;
  options: unknown;
}

/** Installs the footer against a fake UI; `focus.current` is what the TUI reports as focused. */
function install(runs: RunRecord[]) {
  const source = fakeSource(runs);
  const opened: string[] = [];
  const calls: WidgetCall[] = [];
  const focus: { current: unknown } = { current: prompt() };
  let handler: ((data: string) => unknown) | undefined;
  let unsubscribed = 0;
  const ui = {
    setWidget: (key: string, content: unknown, options: unknown) => {
      calls.push({ key, content, options });
    },
    onTerminalInput: (next: (data: string) => unknown) => {
      handler = next;
      return () => {
        unsubscribed++;
        handler = undefined;
      };
    },
    // Unchecked: the fake implements only the two UI hooks the footer calls; the rest of ExtensionUIContext is unused.
  } as unknown as FooterUI;
  const dispose = installWorkflowFooter(ui, source, (runId) => opened.push(runId));
  const host: FakeHost = { requestRender: () => {}, getFocused: () => focus.current };
  return {
    source,
    opened,
    calls,
    focus,
    dispose,
    press: (data: string) => handler?.(data),
    unsubscribed: () => unsubscribed,
    host,
  };
}

/** Installs the footer and mounts its widget (only possible while a run is running). */
function mount(runs: RunRecord[]) {
  const installed = install(runs);
  const factory = installed.calls.at(-1)?.content;
  if (!isFooterFactory(factory)) throw new Error("the footer widget was not mounted");
  const component = factory(installed.host, undefined);
  return { ...installed, lines: (width = 120) => component.render(width) };
}

// ── Reducer ─────────────────────────────────────────────────────────

test("reduceFooterKey passes every key when no run is running", () => {
  assert.deepEqual(reduceFooterKey(undefined, [], "down"), { selected: undefined, effect: { type: "pass" } });
});

test("reduceFooterKey: down on an idle prompt selects row 0 and consumes", () => {
  assert.deepEqual(reduceFooterKey(undefined, ["a", "b"], "down"), { selected: 0, effect: { type: "consume" } });
});

test("reduceFooterKey: up on row 0 clears the selection and consumes", () => {
  assert.deepEqual(reduceFooterKey(0, ["a", "b"], "up"), { selected: undefined, effect: { type: "consume" } });
});

test("reduceFooterKey: down clamps at the last row", () => {
  assert.deepEqual(reduceFooterKey(1, ["a", "b"], "down"), { selected: 1, effect: { type: "consume" } });
});

test("reduceFooterKey: a stale selection clamps to the last remaining row", () => {
  assert.deepEqual(reduceFooterKey(5, ["a", "b"], "down"), { selected: 1, effect: { type: "consume" } });
});

test("reduceFooterKey: enter opens the selected run and clears the selection", () => {
  assert.deepEqual(reduceFooterKey(1, ["a", "b"], "enter"), {
    selected: undefined,
    effect: { type: "open", runId: "b" },
  });
});

test("reduceFooterKey: x stops the selected run and keeps the row selected", () => {
  assert.deepEqual(reduceFooterKey(0, ["a", "b"], "x"), { selected: 0, effect: { type: "stop", runId: "a" } });
});

test("reduceFooterKey: escape clears the selection and is consumed", () => {
  assert.deepEqual(reduceFooterKey(0, ["a"], "escape"), { selected: undefined, effect: { type: "consume" } });
});

test("reduceFooterKey: any other key clears the selection and passes through", () => {
  assert.deepEqual(reduceFooterKey(0, ["a"], "left"), { selected: undefined, effect: { type: "pass" } });
  assert.deepEqual(reduceFooterKey(undefined, ["a"], "x"), { selected: undefined, effect: { type: "pass" } });
});

// ── Renderer ────────────────────────────────────────────────────────

test("renderFooterLines shows no gutter and no hint while nothing is selected", () => {
  const lines = renderFooterLines([run("a"), run("b")], undefined, 5000, 120, plain);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !line.startsWith("❯ ") && !line.includes("↑/↓ select")));
});

test("renderFooterLines marks the selected row and adds the hint while a row is selected", () => {
  const lines = renderFooterLines([run("a"), run("b")], 1, 5000, 120, plain);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("  "));
  assert.ok(lines[1].startsWith("❯ "));
  assert.match(lines[2], /↑\/↓ select · enter view · x stop/);
});

// ── Installer ───────────────────────────────────────────────────────

test("the footer widget is shown while a run runs and cleared when none run", () => {
  const runs = [run("a")];
  const installed = install(runs);
  assert.equal(installed.calls.length, 1);
  assert.equal(installed.calls[0].key, "workflow-footer");
  assert.deepEqual(installed.calls[0].options, { placement: "belowEditor" });
  assert.equal(typeof installed.calls[0].content, "function");

  runs[0] = { ...runs[0], status: "completed", endedAt: 2000 };
  notify(installed.source);
  assert.equal(installed.calls.length, 2);
  assert.equal(installed.calls[1].content, undefined);
});

test("no widget is set when no run is running", () => {
  const installed = install([run("a", "completed")]);
  assert.equal(installed.calls.length, 0);
});

test("down on an idle prompt selects the first running row and consumes the key", () => {
  const m = mount([run("a"), run("b")]);
  assert.deepEqual(m.press(DOWN), { consume: true });
  const lines = m.lines();
  assert.ok(lines[0].startsWith("❯ "));
  assert.ok(lines[1].startsWith("  "));
});

test("a kitty key release after down keeps the row selected", () => {
  const m = mount([run("a"), run("b")]);
  m.press(DOWN);
  assert.equal(m.press("\x1b[1;1:3B"), undefined);
  assert.ok(m.lines()[0].startsWith("❯ "));
  m.press(DOWN);
  assert.ok(m.lines()[1].startsWith("❯ "));
});

test("down with text in the prompt passes through and selects nothing", () => {
  const m = mount([run("a"), run("b")]);
  m.focus.current = prompt("hi");
  assert.equal(m.press(DOWN), undefined);
  assert.ok(m.lines().every((line) => !line.startsWith("❯ ")));
});

test("typing into the prompt drops an existing selection", () => {
  const m = mount([run("a"), run("b")]);
  m.press(DOWN);
  m.focus.current = prompt("h");
  assert.equal(m.press(DOWN), undefined);
  m.focus.current = prompt();
  assert.ok(m.lines().every((line) => !line.startsWith("❯ ")));
});

test("down with an open autocomplete passes through", () => {
  const m = mount([run("a")]);
  m.focus.current = prompt("", true);
  assert.equal(m.press(DOWN), undefined);
});

test("keys pass through when the focused component is not the prompt", () => {
  const m = mount([run("a")]);
  m.focus.current = {};
  assert.equal(m.press(DOWN), undefined);
});

test("enter on the selected row opens that run", () => {
  const m = mount([run("a"), run("b")]);
  m.press(DOWN);
  m.press(DOWN);
  assert.deepEqual(m.press(ENTER), { consume: true });
  assert.deepEqual(m.opened, ["b"]);
});

test("x stops the selected run and keeps the row selected", () => {
  const m = mount([run("a"), run("b")]);
  m.press(DOWN);
  assert.deepEqual(m.press("x"), { consume: true });
  assert.deepEqual(m.source.stops, ["run:a"]);
  assert.ok(m.lines()[0].startsWith("❯ "));
});

test("escape clears the selection and up on row 0 clears it too", () => {
  const m = mount([run("a"), run("b")]);
  m.press(DOWN);
  assert.deepEqual(m.press(ESC), { consume: true });
  assert.ok(m.lines().every((line) => !line.startsWith("❯ ")));
  m.press(DOWN);
  assert.deepEqual(m.press(UP), { consume: true });
  assert.ok(m.lines().every((line) => !line.startsWith("❯ ")));
});

test("left passes through and clears the selection", () => {
  const m = mount([run("a")]);
  m.press(DOWN);
  assert.equal(m.press(LEFT), undefined);
  assert.ok(m.lines().every((line) => !line.startsWith("❯ ")));
});

test("a run that finishes clamps the selection to the rows that remain", () => {
  const runs = [run("a"), run("b")];
  const m = mount(runs);
  m.press(DOWN);
  m.press(DOWN);
  runs[1] = { ...runs[1], status: "completed", endedAt: 2000 };
  notify(m.source);
  assert.ok(m.lines()[0].startsWith("❯ "));
  assert.deepEqual(m.press("x"), { consume: true });
  assert.deepEqual(m.source.stops, ["run:a"]);
});

test("disposing clears the widget and stops listening to the run store", () => {
  const m = mount([run("a")]);
  m.dispose();
  assert.equal(m.calls.at(-1)?.content, undefined);
  assert.equal(m.source.listeners.size, 0);
  assert.equal(m.unsubscribed(), 1);
});
