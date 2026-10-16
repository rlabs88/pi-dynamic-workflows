import assert from "node:assert/strict";
import test from "node:test";
import { FIELD_CAP, MAX_RUNS, MAX_TOOL_CALLS, TEXT_CAP, WorkflowRunStore } from "../src/run-store.js";

function makeStore(): WorkflowRunStore {
  return new WorkflowRunStore();
}

test("store: tool_start/tool_end pair updates running state", async () => {
  const store = makeStore();
  const controller = new AbortController();
  const runId = store.startRun({ name: "test", description: "tool pair test" }, controller);

  store.agentQueued(runId, { id: 1, label: "a1", prompt: "work" });
  store.agentStarted(runId, 1, { prompt: "work" });

  const run = store.list().find((r) => r.id === runId);
  assert(run);
  const agent = run.agents[0];
  assert.equal(agent.status, "running");
  assert.equal(agent.toolCalls.length, 0);

  // tool_start
  store.agentEvent(runId, 1, { type: "tool_start", id: "call_1", name: "bash", args: { command: "ls" } });
  assert.equal(agent.toolCalls.length, 1);
  assert.equal(agent.toolCalls[0].id, "call_1");
  assert.equal(agent.toolCalls[0].running, true);
  assert.equal(agent.toolCalls[0].name, "bash");
  assert.equal(agent.toolCalls[0].args, `{"command":"ls"}`);

  // tool_end
  store.agentEvent(runId, 1, {
    type: "tool_end",
    id: "call_1",
    name: "bash",
    result: "src/\ntests/\n",
    isError: false,
  });
  assert.equal(agent.toolCalls[0].running, false);
  assert.equal(agent.toolCalls[0].result, "src/\ntests/\n");
});

test("store: token sum across usage events", async () => {
  const store = makeStore();
  const controller = new AbortController();
  const runId = store.startRun({ name: "test", description: "tokens" }, controller);

  store.agentQueued(runId, { id: 1, label: "a1", prompt: "work" });
  store.agentStarted(runId, 1, { prompt: "work" });

  store.agentEvent(runId, 1, { type: "usage", tokens: 100 });
  store.agentEvent(runId, 1, { type: "usage", tokens: 250 });

  const agent = store.list().find((r) => r.id === runId)?.agents[0];
  assert.equal(agent.tokens, 350);
});

test("store: caps truncate and set truncated flag", async () => {
  const store = makeStore();
  const controller = new AbortController();
  const runId = store.startRun({ name: "test", description: "cap test" }, controller);

  store.agentQueued(runId, { id: 1, label: "a1", prompt: "work" });
  store.agentStarted(runId, 1, { prompt: "work" });

  // Push text beyond TEXT_CAP
  const longText = "x".repeat(30000);
  store.agentEvent(runId, 1, { type: "text", text: longText });

  const agent = store.list().find((r) => r.id === runId)?.agents[0];
  assert.equal(agent.text.length, 20000); // TEXT_CAP
  assert.equal(agent.truncated, true);
});

test("store: tool-call list drops oldest beyond MAX_TOOL_CALLS while toolCallCount keeps the total", async () => {
  const store = makeStore();
  const controller = new AbortController();
  const runId = store.startRun({ name: "test", description: "tool call cap" }, controller);

  store.agentQueued(runId, { id: 1, label: "a1", prompt: "work" });
  store.agentStarted(runId, 1, { prompt: "work" });

  // Push MAX_TOOL_CALLS + 5 tool starts
  for (let i = 0; i < MAX_TOOL_CALLS + 5; i++) {
    store.agentEvent(runId, 1, {
      type: "tool_start",
      id: `call_${i}`,
      name: "bash",
      args: { cmd: `echo ${i}` },
    });
  }

  const agent = store.list().find((r) => r.id === runId)?.agents[0];
  assert.equal(agent.toolCalls.length, MAX_TOOL_CALLS);
  assert.equal(agent.toolCallCount, MAX_TOOL_CALLS + 5);
  // The oldest should be gone
  assert.equal(agent.toolCalls[0].id, "call_5");
});

test("store: finishing a run marks queued and running agents as stopped, keeps finished ones", () => {
  const store = makeStore();
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  for (const id of [1, 2, 3]) store.agentQueued(runId, { id, label: `a${id}`, prompt: "p" });
  store.agentStarted(runId, 2, { prompt: "p" });
  store.agentStarted(runId, 3, { prompt: "p" });
  store.agentEnded(runId, 3, { status: "done", result: "r" });
  store.finishRun(runId, "stopped");
  const run = store.list().find((r) => r.id === runId);
  assert.deepEqual(
    run?.agents.map((a) => a.status),
    ["stopped", "stopped", "done"],
  );
  assert.equal(run?.status, "stopped");
});

test("store: a running run survives eviction; the oldest finished run is evicted", () => {
  const store = makeStore();
  const running = store.startRun({ name: "running", description: "d" }, new AbortController());
  const finished: string[] = [];
  for (let i = 0; i < MAX_RUNS; i++) {
    const id = store.startRun({ name: `f${i}`, description: "d" }, new AbortController());
    store.finishRun(id, "completed");
    finished.push(id);
  }
  const ids = store.list().map((r) => r.id);
  assert.equal(ids.length, MAX_RUNS);
  assert.ok(ids.includes(running));
  assert.ok(!ids.includes(finished[0]));
  assert.equal(store.list().find((r) => r.id === running)?.status, "running");
});

test("store: several mutations coalesce into one notification after 50 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = makeStore();
  let calls = 0;
  store.subscribe(() => calls++);
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  store.phase(runId, "P");
  store.log(runId, "x");
  store.agentQueued(runId, { id: 1, label: "a", prompt: "p" });
  assert.equal(calls, 0);
  t.mock.timers.tick(49);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
});

test("store: finishRun notifies synchronously and cancels the pending timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = makeStore();
  let calls = 0;
  store.subscribe(() => calls++);
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  store.log(runId, "x");
  store.finishRun(runId, "completed");
  assert.equal(calls, 1);
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
});

test("store: an eviction caused by finishRun is visible to the synchronous notification", () => {
  const store = makeStore();
  const ids: string[] = [];
  for (let i = 0; i <= MAX_RUNS; i++)
    ids.push(store.startRun({ name: `r${i}`, description: "d" }, new AbortController()));
  assert.equal(store.list().length, MAX_RUNS + 1);
  let seen: string[] = [];
  store.subscribe(() => {
    seen = store.list().map((r) => r.id);
  });
  store.finishRun(ids[0], "completed");
  assert.equal(seen.length, MAX_RUNS);
  assert.ok(!seen.includes(ids[0]));
});

test("store: start events for a finished run, or for a skipped agent, change nothing", () => {
  const store = makeStore();
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  store.agentQueued(runId, { id: 1, label: "a1", prompt: "p" });
  store.agentQueued(runId, { id: 2, label: "a2", prompt: "p" });
  store.agentEnded(runId, 2, { status: "skipped" });
  store.agentStarted(runId, 2, { prompt: "p" });
  store.agentEvent(runId, 2, { type: "start", prompt: "p" });
  store.finishRun(runId, "stopped");
  store.agentStarted(runId, 1, { prompt: "p" });
  store.agentEvent(runId, 1, { type: "start", prompt: "p" });
  store.agentEnded(runId, 2, { status: "stopped" });
  const [a1, a2] = store.list()[0].agents;
  assert.equal(a1.status, "stopped");
  assert.equal(a2.status, "skipped");
});

test("F3: live text past TEXT_CAP keeps the newest tail and marks truncation", () => {
  const store = makeStore();
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  store.agentQueued(runId, { id: 1, label: "a1", prompt: "p" });
  store.agentStarted(runId, 1, { prompt: "p" });
  const text = `${"a".repeat(TEXT_CAP)}THE END`;
  store.agentEvent(runId, 1, { type: "text", text });
  const agent = store.list()[0].agents[0];
  assert.equal(agent.text.length, TEXT_CAP);
  assert.ok(agent.text.endsWith("THE END"));
  assert.equal(agent.truncated, true);
});

test("F6: the prompt preview keeps up to FIELD_CAP characters", () => {
  const store = makeStore();
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  const prompt = "word ".repeat(FIELD_CAP);
  store.agentQueued(runId, { id: 1, label: "a1", prompt });
  assert.equal(store.list()[0].agents[0].promptPreview, prompt.slice(0, FIELD_CAP));
});

test("F5: an agent's unseen phase is appended to run.phases, so phases only ever append", () => {
  const store = makeStore();
  const runId = store.startRun({ name: "t", description: "d" }, new AbortController());
  store.agentQueued(runId, { id: 1, label: "a1", phase: "Z", prompt: "p" });
  store.phase(runId, "A");
  store.agentQueued(runId, { id: 2, label: "a2", phase: "A", prompt: "p" });
  store.agentQueued(runId, { id: 3, label: "a3", prompt: "p" });
  assert.deepEqual(store.list()[0].phases, ["Z", "A"]);
});
