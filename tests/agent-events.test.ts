import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  type AgentRunEvent,
  createSessionEventMapper,
  WorkflowAgent,
  type WorkflowSession,
  type WorkflowSessionOptions,
} from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

function assistantEnd(usage: unknown, model?: string, content: unknown = []) {
  return { type: "message_end", message: { role: "assistant", model, usage, stopReason: "stop", content } };
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
  assert.deepEqual(map(assistantEnd({ totalTokens: 100 }, "m-1")), [
    { type: "usage", tokens: 100, ioTokens: 100, model: "m-1" },
  ]);
  assert.deepEqual(map({ type: "message_end", message: { role: "user", content: [] } }), []);
});

test("mapper: ioTokens leaves out cache reads that omp's totalTokens includes", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(map(assistantEnd({ input: 12, output: 30, cacheRead: 432_000, totalTokens: 432_042 }, "m")), [
    { type: "usage", tokens: 432_042, ioTokens: 42, model: "m" },
  ]);
});

test("mapper: an assistant message with text emits message before usage; thinking and empty text emit none", () => {
  const map = createSessionEventMapper();
  const content = [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "There are " },
    { type: "text", text: "12 packages." },
  ];
  assert.deepEqual(map(assistantEnd({ totalTokens: 9 }, undefined, content)), [
    { type: "message", text: "There are 12 packages." },
    { type: "usage", tokens: 9, ioTokens: 9 },
  ]);
  assert.deepEqual(map(assistantEnd(undefined, undefined, [{ type: "text", text: "  " }])), []);
  assert.deepEqual(map(assistantEnd(undefined, undefined, [{ type: "thinking", thinking: "x" }])), []);
});

test("mapper: token count never becomes NaN and a missing model is omitted", () => {
  const map = createSessionEventMapper();
  assert.deepEqual(map(assistantEnd({ input: 3, output: 4 })), [{ type: "usage", tokens: 7, ioTokens: 7 }]);
  assert.deepEqual(map(assistantEnd({ totalTokens: "x" })), []);
  assert.deepEqual(map({ type: "message_end", message: { role: "assistant", model: 42, usage: { totalTokens: 5 } } }), [
    { type: "usage", tokens: 5, ioTokens: 5 },
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

/** The assistant message a session ends its turn with; undefined keeps the plain text reply. */
type Turn = (prompt: string) => unknown;

class FakeSession implements WorkflowSession {
  messages: unknown[] = [];
  model?: { id: string };
  listeners = new Set<(event: unknown) => void>();
  constructor(
    private readonly reply: string,
    private readonly turn?: Turn,
  ) {}
  subscribe(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: unknown) {
    for (const l of this.listeners) l(event);
  }
  async prompt(text: string) {
    const final = this.turn?.(text);
    if (final !== undefined) {
      this.messages.push(final);
      return;
    }
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

function fakeFactory(sessions: FakeSession[], options: WorkflowSessionOptions[], turn?: Turn) {
  return async (opts: WorkflowSessionOptions) => {
    options.push(opts);
    const session = new FakeSession(`reply${sessions.length}`, turn);
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

const providerError = { role: "assistant", content: [], stopReason: "error", errorMessage: "404 not_found_error" };
const failingTurn: Turn = (prompt) => (prompt.includes("FAIL") ? providerError : undefined);

test("agent: a turn that ends in a provider error rejects with the provider's message", async () => {
  const agent = new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], failingTurn) });
  await assert.rejects(() => agent.run("FAIL: call the model"), { message: "404 not_found_error" });
});

test("agent: a provider error without errorMessage rejects with a fallback message", async () => {
  const turn = () => ({ role: "assistant", content: [], stopReason: "error" });
  const agent = new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], turn) });
  await assert.rejects(() => agent.run("x"), { message: "Model request failed" });
});

test("agent: a structured-output agent whose turn ends in a provider error reports that error", async () => {
  const agent = new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], failingTurn) });
  const schema = Type.Object({ ok: Type.Boolean() });
  await assert.rejects(() => agent.run("FAIL: call the model", { schema }), { message: "404 not_found_error" });
});

test("agent: an aborted turn does not report a provider error", async () => {
  const turn = () => ({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" });
  const agent = new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], turn) });
  assert.equal(await agent.run("x"), "");
});

test("agent: normal stop replies are returned unchanged, including an empty one", async () => {
  const text = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
  const empty = { role: "assistant", content: [], stopReason: "stop" };
  assert.equal(await new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], () => text) }).run("x"), "ok");
  assert.equal(await new WorkflowAgent({ tools: [], createSession: fakeFactory([], [], () => empty) }).run("x"), "");
});

/** A session that emits events but keeps only `transcript`, as omp does after a retry strips a failed turn. */
class EventOnlySession implements WorkflowSession {
  readonly messages: unknown[];
  private readonly listeners = new Set<(event: unknown) => void>();
  constructor(
    private readonly events: readonly unknown[],
    transcript: readonly unknown[],
  ) {
    this.messages = [...transcript];
  }
  subscribe(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt() {
    for (const event of this.events) for (const listener of this.listeners) listener(event);
  }
  abort() {}
  dispose() {}
}

function eventOnlyFactory(events: readonly unknown[], transcript: readonly unknown[]) {
  return async () => ({ session: new EventOnlySession(events, transcript) });
}

const refusalEnd = {
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Refusal (cyber): request declined" },
};
const successEnd = {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
};

test("agent: a refusal seen only as a message_end event rejects with the provider's message", async () => {
  const agent = new WorkflowAgent({ tools: [], createSession: eventOnlyFactory([refusalEnd], []) });
  await assert.rejects(() => agent.run("x"), { message: "Refusal (cyber): request declined" });
});

test("agent: a successful assistant message_end after a provider error clears the error", async () => {
  const agent = new WorkflowAgent({
    tools: [],
    createSession: eventOnlyFactory([refusalEnd, successEnd], [successEnd.message]),
  });
  assert.equal(await agent.run("x"), "ok");
});

test("workflow: a provider error makes agent() return null, log and end failed with the message; a sibling completes", async () => {
  const ends: Array<{ label: string; status: string; error?: string }> = [];
  const result = await runWorkflow(
    `export const meta = {
  name: 'provider_error',
  description: 'One agent hits a provider error'
}

const [bad, good] = await parallel([
  () => agent('FAIL: call the model', { label: 'bad' }),
  () => agent('Reply with exactly: ok', { label: 'good' }),
])
return [bad, good]
`,
    {
      tools: [],
      createSession: fakeFactory([], [], failingTurn),
      onAgentEnd(event) {
        ends.push({ label: event.label, status: event.status, error: event.error });
      },
    },
  );
  const outcome = result.result;
  assert(Array.isArray(outcome));
  assert.equal(outcome[0], null);
  assert.equal(typeof outcome[1], "string");
  assert.ok(result.logs.includes("agent bad failed: 404 not_found_error"));
  assert.deepEqual(
    ends.find((e) => e.label === "bad"),
    {
      label: "bad",
      status: "failed",
      error: "404 not_found_error",
    },
  );
  assert.equal(ends.find((e) => e.label === "good")?.status, "done");
});
