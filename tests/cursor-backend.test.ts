import assert from "node:assert/strict";
import test from "node:test";
import type { SDKCustomToolResult, SDKJsonValue, SDKMessage } from "@cursor/sdk";
import { Type } from "typebox";
import type { AgentRunEvent } from "../src/agent.js";
import {
  type CursorAgentOptions,
  type CursorRun,
  CursorSdkAgent,
  type CursorSdkModule,
  createCursorEventMapper,
} from "../src/cursor-backend.js";
import { runWorkflow } from "../src/workflow.js";

interface ScriptedRun {
  readonly messages?: readonly SDKMessage[];
  readonly status?: string;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
  /** Custom tool calls the agent makes before its run starts. */
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, SDKJsonValue> }[];
  /** Runs once the event stream is being consumed, so an abort reaches the run's listener. */
  readonly onStream?: () => void;
  /** Keeps the run open until it is cancelled. */
  readonly hang?: boolean;
}

function fakeRun(script: ScriptedRun, onCancel: () => void): CursorRun {
  let cancelled = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async *stream() {
      script.onStream?.();
      for (const message of script.messages ?? []) yield message;
      if (script.hang) await gate;
    },
    async wait() {
      if (script.hang) await gate;
      return {
        status: cancelled ? "cancelled" : (script.status ?? "finished"),
        result: script.result,
        error: script.error,
      };
    },
    cancel() {
      cancelled = true;
      onCancel();
      release();
    },
  };
}

function fakeCursorSdk(runs: readonly ScriptedRun[] = [], models: readonly string[] = ["composer-2.5", "grok-4.7"]) {
  const pending = [...runs];
  const created: CursorAgentOptions[] = [];
  const sent: string[] = [];
  const results: SDKCustomToolResult[] = [];
  let cancelCount = 0;
  const sdk: CursorSdkModule = {
    Agent: {
      async create(agentOptions) {
        created.push(agentOptions);
        return {
          async send(message) {
            sent.push(message);
            const script = pending.shift() ?? {};
            for (const call of script.toolCalls ?? []) {
              const tool = agentOptions.local.customTools[call.name];
              if (!tool) throw new Error(`no custom tool ${call.name}`);
              results.push(await tool.execute(call.args, { toolCallId: "call-1" }));
            }
            return fakeRun(script, () => {
              cancelCount++;
            });
          },
          close() {},
        };
      },
    },
    Cursor: {
      models: {
        async list() {
          return models.map((id) => ({ id }));
        },
      },
    },
    AuthenticationError: class AuthenticationError extends Error {},
  };
  return { sdk, created, sent, results, cancels: () => cancelCount };
}

const fakeHost = {
  async run(prompt: string): Promise<string> {
    return `host:${prompt}`;
  },
};

function text(value: string): SDKMessage {
  return {
    type: "assistant",
    agent_id: "agent",
    run_id: "run",
    message: { role: "assistant", content: [{ type: "text", text: value }] },
  };
}

function toolCall(callId: string, status: "running" | "completed" | "error"): SDKMessage {
  let result: unknown;
  if (status === "completed") result = "file contents";
  if (status === "error") result = "ENOENT";
  return {
    type: "tool_call",
    agent_id: "agent",
    run_id: "run",
    call_id: callId,
    name: "read",
    status,
    args: { path: "math.js" },
    result,
  };
}

function usage(totalTokens: number): SDKMessage {
  return {
    type: "usage",
    agent_id: "agent",
    run_id: "run",
    usage: { inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens },
  };
}

test("cursor mapper accumulates assistant deltas into each text event", () => {
  const map = createCursorEventMapper("cursor-sdk/composer-2.5");
  assert.deepEqual(map(text("Hel")), [{ type: "text", text: "Hel" }]);
  assert.deepEqual(map(text("lo")), [{ type: "text", text: "Hello" }]);
  assert.deepEqual(map(text("")), []);
});

test("cursor mapper emits tool_start once per call_id and tool_end with isError on error", () => {
  const map = createCursorEventMapper("cursor-sdk/composer-2.5");
  const events = [
    ...map(toolCall("c1", "running")),
    ...map(toolCall("c1", "completed")),
    ...map(toolCall("c2", "running")),
    ...map(toolCall("c2", "error")),
  ];
  assert.deepEqual(events, [
    { type: "tool_start", id: "c1", name: "read", args: { path: "math.js" } },
    { type: "tool_end", id: "c1", name: "read", result: "file contents", isError: false },
    { type: "tool_start", id: "c2", name: "read", args: { path: "math.js" } },
    { type: "tool_end", id: "c2", name: "read", result: "ENOENT", isError: true },
  ]);
});

test("cursor mapper reports usage under the cursor-sdk model label", () => {
  const map = createCursorEventMapper("cursor-sdk/composer-2.5");
  assert.deepEqual(map(usage(42)), [{ type: "usage", tokens: 42, model: "cursor-sdk/composer-2.5" }]);
  assert.deepEqual(map(usage(0)), []);
});

test("cursor agent returns the accumulated deltas when the run has no final result", async () => {
  const fake = fakeCursorSdk([{ messages: [text("ok"), text("ay")] }]);
  const events: AgentRunEvent[] = [];
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  const result = await agent.run("hi", {
    model: "composer-2.5",
    onEvent: (event) => {
      events.push(event);
    },
  });
  assert.equal(result, "okay");
  assert.deepEqual(
    events.flatMap((event) => (event.type === "text" ? [event.text] : [])),
    ["ok", "okay"],
  );
});

test("cursor model strips the cursor prefix from a selector", async () => {
  const fake = fakeCursorSdk();
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await agent.run("hi", { model: "cursor/grok-4.7" });
  assert.deepEqual(fake.created[0]?.model, { id: "grok-4.7" });
});

test("cursor model takes the first available entry of a fallback list", async () => {
  const fake = fakeCursorSdk();
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await agent.run("hi", { model: ["cursor/nope-model", "grok-4.7"] });
  assert.deepEqual(fake.created[0]?.model, { id: "grok-4.7" });
});

test("cursor model names the tried ids when none is available", async () => {
  const fake = fakeCursorSdk();
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await assert.rejects(() => agent.run("hi", { model: "nope-model" }), {
    message: /nope-model[\s\S]*Available: composer-2\.5, grok-4\.7/,
  });
});

test("cursor model defaults to default and forwards modelParams", async () => {
  const fake = fakeCursorSdk();
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await agent.run("hi", { modelParams: { effort: "high" } });
  assert.deepEqual(fake.created[0]?.model, { id: "default", params: [{ id: "effort", value: "high" }] });
});

test("a failed cursor run fails only its own agent in a workflow", async () => {
  const fake = fakeCursorSdk([{ status: "error", error: { message: "boom" } }]);
  const ends: { label: string; status: string; error?: string }[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'failed_cursor', description: 'One cursor agent fails' }
const bad = await agent('bad', { label: 'bad', backend: 'cursor', model: 'composer-2.5' })
const good = await agent('good', { label: 'good' })
return { bad, good }`,
    {
      agent: fakeHost,
      backends: { cursor: new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk }) },
      onAgentEnd: (event) => {
        ends.push({ label: event.label, status: event.status, error: event.error });
      },
    },
  );
  // Objects built inside the workflow script come from another realm; compare their JSON form.
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { bad: null, good: "host:good" });
  assert(result.logs.includes("agent bad failed: boom"));
  assert.deepEqual(
    ends.find((event) => event.label === "bad"),
    { label: "bad", status: "failed", error: "boom" },
  );
});

test("stopping a cursor agent cancels its run and marks the agent skipped", async () => {
  const stops: (() => void)[] = [];
  const fake = fakeCursorSdk([{ hang: true, onStream: () => stops[0]?.() }]);
  const statuses: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'slow_cursor', description: 'One cursor agent is stopped' }
const slow = await agent('slow', { label: 'slow', backend: 'cursor', model: 'composer-2.5' })
return { slow }`,
    {
      agent: fakeHost,
      backends: { cursor: new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk }) },
      onAgentControl: (_id, stop) => {
        stops.push(stop);
      },
      onAgentEnd: (event) => {
        statuses.push(event.status);
      },
    },
  );
  assert.equal(fake.cancels(), 1);
  assert.deepEqual(statuses, ["skipped"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { slow: null });
});

test("structured output captures valid arguments and returns them", async () => {
  const schema = Type.Object({ exports: Type.Array(Type.String()) });
  const fake = fakeCursorSdk([{ toolCalls: [{ name: "structured_output", args: { exports: ["add"] } }] }]);
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  const result = await agent.run("list", { model: "grok-4.7", schema });
  assert.deepEqual(result, { exports: ["add"] });
});

test("structured output rejects invalid arguments with an isError result", async () => {
  const schema = Type.Object({ exports: Type.Array(Type.String()) });
  const fake = fakeCursorSdk([{ toolCalls: [{ name: "structured_output", args: { exports: {} } }] }]);
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await assert.rejects(() => agent.run("list", { model: "grok-4.7", schema }), {
    message: "Subagent finished without calling structured_output",
  });
  assert.equal(fake.results[0]?.isError, true);
});

test("structured output errors when the agent never calls the tool", async () => {
  const schema = Type.Object({ exports: Type.Array(Type.String()) });
  const fake = fakeCursorSdk([{}]);
  const agent = new CursorSdkAgent({ cwd: "/tmp", loadSdk: async () => fake.sdk });
  await assert.rejects(() => agent.run("list", { model: "grok-4.7", schema }), {
    message: "Subagent finished without calling structured_output",
  });
});

test("unknown agent backends are rejected with a TypeError", async () => {
  const script = `export const meta = { name: 'bad_backend', description: 'Unknown backend' }
return await agent('x', { backend: 'codex' })`;
  await assert.rejects(runWorkflow(script, { agent: fakeHost }), TypeError);
});

test("modelParams without the cursor backend are rejected with a TypeError", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_model_params', description: 'modelParams without cursor' }
return await agent('x', { modelParams: { effort: 'high' } })`,
      { agent: fakeHost },
    ),
    TypeError,
  );
});
