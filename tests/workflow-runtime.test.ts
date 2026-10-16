import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  const r = result.result;
  assert(r && typeof r === "object" && "scan" in r);
  const rObj = r as Record<string, unknown>;
  assert.equal(rObj.scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  const r = result.result;
  assert(r && typeof r === "object" && "scan" in r);
  const rObj = r as Record<string, unknown>;
  assert.equal(rObj.scan, "result:Catalog Date.now(), Math.random(), and new Date() usage");
});

test("two agents with the same label get distinct ids and each end event carries its own result", async () => {
  const ends: Array<{ id: number; label: string; result: unknown; status: string }> = [];

  const result = await runWorkflow(
    `export const meta = {
  name: 'same_label_test',
  description: 'Two agents with the same label'
}

const a = await agent('first', { label: 'dup' })
const b = await agent('second', { label: 'dup' })
return { a, b }
`,
    {
      agent: fakeAgent,
      onAgentEnd(event) {
        ends.push({
          id: event.id,
          label: event.label,
          result: event.result,
          status: event.status,
        });
      },
    },
  );

  // Two agents, same label, but distinct ids
  assert.equal(result.agentCount, 2);
  assert.equal(ends.length, 2);
  assert.notEqual(ends[0].id, ends[1].id);
  assert.equal(ends[0].label, "dup");
  assert.equal(ends[1].label, "dup");
  // Each carries its own result
  assert.equal(ends[0].result, "result:first");
  assert.equal(ends[1].result, "result:second");
  assert.equal(ends[0].status, "done");
  assert.equal(ends[1].status, "done");
});

test("a user-stopped agent returns null with status skipped while concurrent siblings complete", async () => {
  const ends: Array<{ label: string; status: string; result: unknown }> = [];
  const stops = new Map<number, () => void>();
  let slowStarted: () => void = () => {};
  const slowRunning = new Promise<void>((r) => {
    slowStarted = r;
  });
  const result = await runWorkflow(
    `export const meta = { name: 'user_stop_test', description: 'Stop one agent, keep the others' }
return await parallel([
  () => agent('fast1', { label: 'fast1' }),
  () => agent('slow', { label: 'slow' }),
  () => agent('fast2', { label: 'fast2' }),
])
`,
    {
      concurrency: 3,
      agent: {
        async run(prompt: string, opts: { signal?: AbortSignal }) {
          if (prompt.includes("slow")) {
            slowStarted();
            await new Promise<void>((_, reject) =>
              opts.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }),
            );
          } else {
            await slowRunning;
          }
          return `result:${prompt}`;
        },
      },
      onAgentControl(id, stop) {
        stops.set(id, stop);
      },
      onAgentStart(event) {
        if (event.label === "slow") void slowRunning.then(() => stops.get(event.id)?.());
      },
      onAgentEnd(event) {
        ends.push({ label: event.label, status: event.status, result: event.result });
      },
    },
  );

  assert.deepEqual(result.result, ["result:fast1", null, "result:fast2"]);
  assert.deepEqual(
    ends.find((e) => e.label === "slow"),
    { label: "slow", status: "skipped", result: null },
  );
  assert.equal(ends.filter((e) => e.status === "done").length, 2);
});

test("an agent stopped while queued ends skipped at once, never starts, and is not ended twice", async () => {
  const started: string[] = [];
  const ends: Array<{ label: string; status: string }> = [];
  const logs: string[] = [];
  const stops = new Map<number, () => void>();
  const prompts: string[] = [];
  let endsRightAfterStop: typeof ends = [];
  const result = await runWorkflow(
    `export const meta = { name: 'queued_stop', description: 'Stop a queued agent' }
return await parallel([() => agent('t1', { label: 'one' }), () => agent('t2', { label: 'two' })])
`,
    {
      concurrency: 1,
      agent: {
        async run(prompt: string) {
          prompts.push(prompt);
          await Promise.resolve();
          // agent 2 is queued behind this one: stop it now, while agent 1 still holds the slot
          stops.get(2)?.();
          endsRightAfterStop = [...ends];
          return `r:${prompt}`;
        },
      },
      onLog(message) {
        logs.push(message);
      },
      onAgentControl(id, stop) {
        stops.set(id, stop);
      },
      onAgentStart(event) {
        started.push(event.label);
      },
      onAgentEnd(event) {
        ends.push({ label: event.label, status: event.status });
      },
    },
  );

  assert.deepEqual(endsRightAfterStop, [{ label: "two", status: "skipped" }]);
  assert.deepEqual(logs, ["agent two stopped by user"]);
  assert.deepEqual(result.result, ["r:t1", null]);
  assert.deepEqual(started, ["one"]);
  assert.deepEqual(prompts, ["t1"]);
  assert.deepEqual(ends, [
    { label: "two", status: "skipped" },
    { label: "one", status: "done" },
  ]);
});
