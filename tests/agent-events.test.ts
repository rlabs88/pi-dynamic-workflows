import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentRunEvent,
  createSessionEventMapper,
  WorkflowAgent,
  type WorkflowSession,
  type WorkflowSessionOptions,
} from "../src/agent.js";

function assistantEnd(usage: unknown, model?: string) {
  return { type: "message_end", message: { role: "assistant", model, usage, stopReason: "stop", content: [] } };
}

test("mapper: text deltas accumulate per assistant message and reset on the next one", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(map({ type: "message_start", message: { role: "assistant" } }), []);
  assert.deepEqual(map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }), [
    { type: "text", text: "Hello " },
  ]);
  assert.deepEqual(map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }), [
    { type: "text", text: "Hello world" },
  ]);
  map({ type: "message_start", message: { role: "toolResult" } });
  map({ type: "message_start", message: { role: "assistant" } });
  assert.deepEqual(map({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Next" } }), [
    { type: "text", text: "Next" },
  ]);
});

test("mapper: toolcall stream events produce nothing (tool_execution_start is the only tool_start source)", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(
    map({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } }),
    [],
  );
  assert.deepEqual(
    map({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } }),
    [],
  );
});

test("mapper: assistant message_end yields usage with model; user message_end yields nothing", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(map(assistantEnd({ totalTokens: 100 }, "m-1")), [{ type: "usage", tokens: 100, model: "m-1" }]);
  assert.deepEqual(map({ type: "message_end", message: { role: "user", content: [] } }), []);
});

test("mapper: token count never becomes NaN and a missing model is omitted", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(map(assistantEnd({ input: 3, output: 4 })), [{ type: "usage", tokens: 7 }]);
  assert.deepEqual(map(assistantEnd({ totalTokens: "x" })), []);
  assert.deepEqual(map({ type: "message_end", message: { role: "assistant", model: 42, usage: { totalTokens: 5 } } }), [
    { type: "usage", tokens: 5 },
  ]);
});

test("mapper: tool_execution_start/end map to tool_start/tool_end (omp ids with |)", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(
    map({ type: "tool_execution_start", toolCallId: "c|1", toolName: "bash", args: { command: "ls" } }),
    [{ type: "tool_start", id: "c|1", name: "bash", args: { command: "ls" } }],
  );
  assert.deepEqual(
    map({
      type: "tool_execution_end",
      toolCallId: "c|1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text" }, { type: "text", text: "b" }],
      },
      isError: true,
    }),
    [{ type: "tool_end", id: "c|1", name: "bash", result: "ab", isError: true }],
  );
});

test("mapper: malformed and lifecycle events produce nothing", () => {
  const map = createSessionEventMapper();
  for (const ev of [
    null,
    undefined,
    3,
    { type: "turn_start" },
    { type: "agent_end" },
    { type: "tool_execution_start" },
  ]) {
    assert.deepEqual(map(ev), []);
  }
});

class FakeSession implements WorkflowSession {
  messages: unknown[] = [];
  model?: { id: string };
  listeners = new Set<(event: unknown) => void>();
  constructor(private readonly reply: string) {}
  subscribe(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: unknown) {
    for (const l of this.listeners) l(event);
  }
  async prompt() {
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.reply } });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: this.reply }] });
  }
  abort() {}
  dispose() {
    // omp keeps listeners until async dispose finishes: emit a late event
    this.emit(assistantEnd({ totalTokens: 9 }, "late"));
  }
}

function fakeFactory(sessions: FakeSession[], options: WorkflowSessionOptions[]) {
  return async (opts: WorkflowSessionOptions) => {
    options.push(opts);
    const session = new FakeSession(`reply${sessions.length}`);
    session.model = opts.model;
    sessions.push(session);
    return { session };
  };
}

test("agent: start event carries the model id string, not the model object", async () => {
  const events: AgentRunEvent[] = [];
  const agent = new WorkflowAgent({
    tools: [],
    session: { model: { id: "deepseek-v4-flash" } as never },
    createSession: fakeFactory([], []),
  });
  const result = await agent.run("hi", { onEvent: (e) => events.push(e) });
  assert.equal(result, "reply0");
  const start = events.find((e) => e.type === "start");
  assert.equal(start?.type === "start" ? start.model : undefined, "deepseek-v4-flash");
});

test("agent: events emitted during dispose are not forwarded (subscription removed first)", async () => {
  const events: AgentRunEvent[] = [];
  const sessions: FakeSession[] = [];
  const agent = new WorkflowAgent({ tools: [], createSession: fakeFactory(sessions, []) });
  await agent.run("hi", { onEvent: (e) => events.push(e) });
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text"],
  );
  assert.equal(sessions[0].listeners.size, 0);
});

test("agent: session agentIds are unique across instances without a runId", async () => {
  const opts: WorkflowSessionOptions[] = [];
  const factory = fakeFactory([], opts);
  await new WorkflowAgent({ tools: [], createSession: factory }).run("x");
  await new WorkflowAgent({ tools: [], createSession: factory }).run("x");
  const ids = opts.map((o) => o.agentId);
  assert.equal(typeof ids[0], "string");
  assert.notEqual(ids[0], ids[1]);
});
