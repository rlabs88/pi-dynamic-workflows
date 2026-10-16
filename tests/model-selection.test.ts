import assert from "node:assert/strict";
import test from "node:test";
import { type AgentRunEvent, WorkflowAgent, type WorkflowSession, type WorkflowSessionOptions } from "../src/agent.js";
import { parseModelSelector, resolveAgentModel } from "../src/model-selector.js";
import { runWorkflow } from "../src/workflow.js";

interface FakeModel {
  id: string;
  provider: string;
}

const haiku: FakeModel = { id: "claude-haiku-5-5", provider: "anthropic" };
const grok: FakeModel = { id: "grok-4.7", provider: "cursor" };
const parent: FakeModel = { id: "parent-model", provider: "anthropic" };

// Only anthropic models have credentials; cursor/grok is listed but unauthenticated.
const registry = {
  find(provider: string, modelId: string): FakeModel | undefined {
    return [haiku, grok].find((model) => model.provider === provider && model.id === modelId);
  },
  hasConfiguredAuth(model: FakeModel): boolean {
    return model.provider === "anthropic";
  },
};

class RecordingSession implements WorkflowSession {
  messages: unknown[] = [];
  disposed = false;
  constructor(readonly model?: { readonly id: string }) {}
  subscribe() {
    return () => {};
  }
  async prompt() {
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
  }
  abort() {}
  dispose() {
    this.disposed = true;
  }
}

/** Pi path: the session runs on the model the runner resolved and passed in. */
function recordingFactory(seen: WorkflowSessionOptions[]) {
  return async (opts: WorkflowSessionOptions) => {
    seen.push(opts);
    return { session: new RecordingSession(opts.model) };
  };
}

/** Omp path: the host resolves `modelPattern` itself; `resolved` stands in for what it picked. */
function ompFactory(seen: WorkflowSessionOptions[], resolved: FakeModel | undefined, fallback?: string) {
  return async (opts: WorkflowSessionOptions) => {
    seen.push(opts);
    return { session: new RecordingSession(resolved), modelFallbackMessage: fallback };
  };
}

test("parse: the provider ends at the first slash and the model id keeps later slashes and colons", () => {
  assert.deepEqual(parseModelSelector("openrouter/deepseek/deepseek-v4-flash:free"), {
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash:free",
    thinkingLevel: undefined,
  });
});

test("parse: a trailing thinking level is stripped from the model id", () => {
  assert.deepEqual(parseModelSelector("anthropic/claude-haiku-5-5:high"), {
    provider: "anthropic",
    modelId: "claude-haiku-5-5",
    thinkingLevel: "high",
  });
  assert.deepEqual(parseModelSelector("anthropic/claude-haiku-5-5:off"), {
    provider: "anthropic",
    modelId: "claude-haiku-5-5",
    thinkingLevel: "off",
  });
});

test("parse: selectors without a provider or a model id are invalid", () => {
  for (const selector of ["claude-haiku-5-5", "/claude-haiku-5-5", "anthropic/", "anthropic/:high"]) {
    assert.equal(parseModelSelector(selector), undefined, selector);
  }
});

test("resolve: a single selector resolves to its model", () => {
  const resolved = resolveAgentModel("anthropic/claude-haiku-5-5", registry);
  assert.equal(resolved.model, haiku);
  assert.equal(resolved.selector, "anthropic/claude-haiku-5-5");
  assert.equal(resolved.thinkingLevel, undefined);
});

test("resolve: the first selector with a model and credentials wins, carrying its thinking level", () => {
  const resolved = resolveAgentModel(["nope/missing", "cursor/grok-4.7", "anthropic/claude-haiku-5-5:low"], registry);
  assert.equal(resolved.model, haiku);
  assert.equal(resolved.selector, "anthropic/claude-haiku-5-5:low");
  assert.equal(resolved.thinkingLevel, "low");
});

test("resolve: when nothing is usable, the error names each rejected selector and its reason", () => {
  assert.throws(() => resolveAgentModel(["nope/missing", "cursor/grok-4.7", "bad"], registry), {
    message: "No usable model: nope/missing (unknown model), cursor/grok-4.7 (no credentials), bad (invalid selector)",
  });
});

test("resolve: an empty selector list is rejected", () => {
  assert.throws(() => resolveAgentModel([], registry), { message: "No usable model: no selectors given" });
});

test("pi: a selected model and thinking level replace the session defaults", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const events: AgentRunEvent[] = [];
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { modelRegistry: registry as never, model: parent as never, thinkingLevel: "high" },
    createSession: recordingFactory(seen),
  });
  const result = await agent.run("hi", {
    model: ["cursor/grok-4.7", "anthropic/claude-haiku-5-5:low"],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result, "done");
  assert.equal(seen[0]?.model, haiku);
  assert.equal(seen[0]?.thinkingLevel, "low");
  const start = events.find((event) => event.type === "start");
  assert.equal(start?.type === "start" ? start.model : undefined, "claude-haiku-5-5");
});

test("pi: a selector without a thinking level keeps the session's thinking level", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { modelRegistry: registry as never, model: parent as never, thinkingLevel: "high" },
    createSession: recordingFactory(seen),
  });
  await agent.run("hi", { model: "anthropic/claude-haiku-5-5" });
  assert.equal(seen[0]?.model, haiku);
  assert.equal(seen[0]?.thinkingLevel, "high");
});

test("pi: without a model the session keeps the parent model", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { modelRegistry: registry as never, model: parent as never },
    createSession: recordingFactory(seen),
  });
  await agent.run("hi");
  assert.equal(seen[0]?.model, parent);
  assert.equal(seen[0]?.thinkingLevel, undefined);
});

test("pi: unusable selectors reject before any session or start event", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const events: AgentRunEvent[] = [];
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { modelRegistry: registry as never, model: parent as never },
    createSession: recordingFactory(seen),
  });
  await assert.rejects(agent.run("hi", { model: "nope/missing", onEvent: (event) => events.push(event) }), {
    message: "No usable model: nope/missing (unknown model)",
  });
  assert.equal(seen.length, 0);
  assert.equal(
    events.some((event) => event.type === "start"),
    false,
  );
});

test("pi: selecting a model without a model registry rejects", async () => {
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { model: parent as never },
    createSession: recordingFactory([]),
  });
  await assert.rejects(agent.run("hi", { model: "anthropic/claude-haiku-5-5" }), {
    message: "Model selection needs a modelRegistry",
  });
});

test("omp: the selector goes to the host as modelPattern, and no model key is set", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const events: AgentRunEvent[] = [];
  const agent = new WorkflowAgent({
    host: "omp",
    tools: [],
    session: { model: parent as never },
    createSession: ompFactory(seen, haiku),
  });
  const result = await agent.run("hi", {
    model: ["anthropic/claude-haiku-5-5", "cursor/grok-4.7"],
    onEvent: (event) => events.push(event),
  });
  assert.equal(result, "done");
  const opts = seen[0];
  assert.ok(opts);
  assert.deepEqual(opts.modelPattern, ["anthropic/claude-haiku-5-5", "cursor/grok-4.7"]);
  assert.equal("model" in opts, false);
  const start = events.find((event) => event.type === "start");
  assert.equal(start?.type === "start" ? start.model : undefined, "claude-haiku-5-5");
});

test("omp: a single selector string is passed through as modelPattern without a registry", async () => {
  const seen: WorkflowSessionOptions[] = [];
  const agent = new WorkflowAgent({ host: "omp", tools: [], createSession: ompFactory(seen, haiku) });
  await agent.run("hi", { model: "anthropic/claude-haiku-5-5" });
  assert.equal(seen[0]?.modelPattern, "anthropic/claude-haiku-5-5");
});

test("omp: a selector the host cannot match fails the agent, disposes the session, and emits no start", async () => {
  const session = new RecordingSession();
  const events: AgentRunEvent[] = [];
  const agent = new WorkflowAgent({
    host: "omp",
    tools: [],
    session: { model: parent as never },
    createSession: async () => ({ session, modelFallbackMessage: 'Model "nope/missing" not found' }),
  });
  await assert.rejects(agent.run("hi", { model: "nope/missing", onEvent: (event) => events.push(event) }), {
    message: 'Model "nope/missing" not found',
  });
  assert.equal(session.disposed, true);
  assert.equal(
    events.some((event) => event.type === "start"),
    false,
  );
});

test("omp: a fallback the host reports while still matching is forwarded to onNotice, not failed", async () => {
  const notices: string[] = [];
  const agent = new WorkflowAgent({
    host: "omp",
    tools: [],
    createSession: ompFactory([], grok, "Fallback: nope/missing -> cursor/grok-4.7"),
  });
  const result = await agent.run("hi", {
    model: ["nope/missing", "cursor/grok-4.7"],
    onNotice: (message) => notices.push(message),
  });
  assert.equal(result, "done");
  assert.deepEqual(notices, ["Fallback: nope/missing -> cursor/grok-4.7"]);
});

test("workflow: agent() passes the model selector through to the runner", async () => {
  const seen: unknown[] = [];
  const runner = {
    async run(_prompt: string, opts?: unknown) {
      seen.push(opts);
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'pass_model', description: 'model pass-through' };
return { value: await agent('x', { model: ['anthropic/claude-haiku-5-5', 'cursor/grok-4.7'] }) };`,
    { agent: runner },
  );
  // The script runs in its own VM realm, so strict deep equality rejects its arrays and objects; compare JSON.
  const first = seen[0];
  assert.ok(typeof first === "object" && first !== null && "model" in first);
  assert.equal(JSON.stringify(first.model), JSON.stringify(["anthropic/claude-haiku-5-5", "cursor/grok-4.7"]));
});

test("workflow: an unusable model fails only its agent while siblings complete", async () => {
  const ends: Array<{ label: string; status: string; error?: string; result: unknown }> = [];
  const agent = new WorkflowAgent({
    host: "pi",
    tools: [],
    session: { modelRegistry: registry as never, model: parent as never },
    createSession: recordingFactory([]),
  });
  const result = await runWorkflow(
    `export const meta = { name: 'model_fallback', description: 'one bad model' };
const bad = agent('bad', { label: 'bad model', model: 'nope/missing' });
const good = agent('good', { label: 'good model', model: 'anthropic/claude-haiku-5-5' });
return { bad: await bad, good: await good };`,
    { agent, onAgentEnd: (event) => ends.push(event) },
  );
  assert.equal(JSON.stringify(result.result), JSON.stringify({ bad: null, good: "done" }));
  const failed = ends.find((event) => event.label === "bad model");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "No usable model: nope/missing (unknown model)");
});

test("workflow: on omp an unmatched selector fails only its agent while siblings complete", async () => {
  const ends: Array<{ label: string; status: string; error?: string; result: unknown }> = [];
  const agent = new WorkflowAgent({
    host: "omp",
    tools: [],
    session: { model: parent as never },
    createSession: async (opts) => {
      if ([opts.modelPattern].flat().includes("nope/missing")) {
        return { session: new RecordingSession(), modelFallbackMessage: 'Model "nope/missing" not found' };
      }
      return { session: new RecordingSession(haiku) };
    },
  });
  const result = await runWorkflow(
    `export const meta = { name: 'omp_model_fallback', description: 'one unmatched model on omp' };
const bad = agent('bad', { label: 'bad model', model: 'nope/missing' });
const good = agent('good', { label: 'good model', model: 'anthropic/claude-haiku-5-5' });
return { bad: await bad, good: await good };`,
    { agent, onAgentEnd: (event) => ends.push(event) },
  );
  assert.equal(JSON.stringify(result.result), JSON.stringify({ bad: null, good: "done" }));
  const failed = ends.find((event) => event.label === "bad model");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, 'Model "nope/missing" not found');
});

test("workflow: agent() rejects an empty model list, an empty selector, and a non-string selector", async () => {
  const runner = {
    async run() {
      return "ok";
    },
  };
  for (const model of ["[]", "''", "[42]", "42"]) {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'bad_model', description: 'invalid model' };
return { value: await agent('x', { model: ${model} }) };`,
        { agent: runner },
      ),
      /agent model/,
      model,
    );
  }
});
