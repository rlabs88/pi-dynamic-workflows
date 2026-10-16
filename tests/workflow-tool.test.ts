import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type RunRecord, workflowRuns } from "../src/run-store.js";
import { createWorkflowTool, formatRunStatusLine } from "../src/workflow-tool.js";

type Tool = ToolDefinition;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function makeCtx(): ExtensionContext {
  return { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;
}

function toolWith(run: (prompt: string) => Promise<string>): Tool {
  return createWorkflowTool({ concurrency: 4, agent: { run: (prompt: string) => run(prompt) as never } });
}

function render(tool: Tool, result: unknown, isPartial: boolean): string[] {
  const component = tool.renderResult?.(result as never, { isPartial, expanded: false }, theme, {} as never);
  assert(component);
  return component.render(200).map((l) => l.trimEnd());
}

const header = (name: string) => `export const meta = { name: '${name}', description: 'd' }\n`;

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();
  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("meta.phases is optional metadata")));
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("Phase names may be conditional or built in a loop")));
});

test("completed tool row shows the status line and the agent tree with real counts", async () => {
  const tool = toolWith(async (p) => p);
  const result = await tool.execute(
    "id",
    {
      script: `${header("done_row")}phase('Scan')\nreturn await parallel([() => agent('a', {label:'alpha'}), () => agent('b', {label:'beta'})])`,
    },
    undefined,
    undefined,
    makeCtx(),
  );
  const lines = render(tool, result, false);
  assert.match(lines[0], /^✔ Completed in \d+s · 2 agents · 0 tokens$/);
  assert.equal(lines[1], "◆ Workflow: done_row (2/2 done)");
  assert.ok(lines.some((l) => l.includes("✓ Scan 2/2")));
  assert.ok(lines.some((l) => l.includes("alpha")) && lines.some((l) => l.includes("beta")));
});

test("running tool row header counts from the real snapshot", async () => {
  const gate = Promise.withResolvers<void>();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  });
  const headers: string[] = [];
  await tool.execute(
    "id",
    { script: `${header("run_row")}phase('Scan')\nreturn await parallel([() => agent('fast'), () => agent('slow')])` },
    undefined,
    (update) => {
      headers.push(render(tool, update, true)[0]);
      if (headers.at(-1)?.includes("1/2 done")) gate.resolve();
    },
    makeCtx(),
  );
  assert.ok(headers.includes("◆ Workflow: run_row (1/2 done, 1 running)"), headers.join("\n"));
});

test("a failing workflow throws an error starting with ✘ Failed in and keeping the message", async () => {
  const tool = toolWith(async () => "ok");
  await assert.rejects(
    tool.execute(
      "id",
      { script: `${header("fail_row")}await agent('Reply ok', {label:'one'}); throw new Error("boom")` },
      undefined,
      undefined,
      makeCtx(),
    ),
    (error: Error) => {
      assert.match(error.message, /^✘ Failed in \d+s · 1 agents · 0 tokens\nboom$/);
      return true;
    },
  );
  assert.equal(workflowRuns.list()[0].status, "failed");
});

test("a host-aborted workflow throws ✘ Stopped in … followed by Workflow was aborted", async () => {
  const controller = new AbortController();
  const tool = toolWith(async () => {
    controller.abort();
    return "ok";
  });
  await assert.rejects(
    tool.execute(
      "id",
      { script: `${header("stop_row")}await agent('x'); await agent('y')` },
      controller.signal,
      undefined,
      makeCtx(),
    ),
    (error: Error) => {
      assert.match(error.message, /^✘ Stopped in \d+s · 1 agents · 0 tokens\nWorkflow was aborted$/);
      return true;
    },
  );
  assert.equal(workflowRuns.list()[0].status, "stopped");
});

test("a zero-agent workflow is recorded failed, not completed", async () => {
  const tool = toolWith(async () => "ok");
  await assert.rejects(
    tool.execute("id", { script: `${header("zero_agents")}return 1` }, undefined, undefined, makeCtx()),
    (error: Error) => {
      assert.match(error.message, /^✘ Failed in \d+s · 0 agents · 0 tokens\nworkflow scripts must call agent\(\)/);
      return true;
    },
  );
  const run = workflowRuns.list()[0];
  assert.equal(run.name, "zero_agents");
  assert.equal(run.status, "failed");
});

test("status line counts finished agents (not stopped ones) as done and says tokens", () => {
  const agent = (id: number, status: RunRecord["agents"][number]["status"], tokens = 0) => ({
    id,
    label: `a${id}`,
    status,
    promptPreview: "",
    queuedAt: 0,
    tokens,
    toolCalls: [],
    toolCallCount: 0,
    text: "",
    truncated: false,
  });
  const run: RunRecord = {
    id: "r",
    name: "wf",
    description: "",
    status: "running",
    startedAt: 0,
    phases: [],
    logs: [],
    agents: [agent(1, "done", 1500), agent(2, "skipped"), agent(3, "stopped"), agent(4, "failed"), agent(5, "running")],
  };
  assert.equal(formatRunStatusLine(run, 5000), "◯ wf  ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱  3/5 · 5s · ↓ 1.5k tokens");
});

test("a stop from /workflows throws ✘ Stopped in … followed by the user-stop message", async () => {
  const tool = toolWith(async () => {
    workflowRuns.stopRun(workflowRuns.list()[0].id);
    return "ok";
  });
  const host = new AbortController();
  await assert.rejects(
    tool.execute(
      "id",
      { script: `${header("user_stop")}await agent('x'); await agent('y')` },
      host.signal,
      undefined,
      makeCtx(),
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /^✘ Stopped in \d+s · 1 agents · 0 tokens\nWorkflow was stopped by the user from \/workflows$/,
      );
      return true;
    },
  );
  assert.equal(workflowRuns.list()[0].status, "stopped");
});

test("completed result lists failed agents under Agent errors, after the result", async () => {
  const tool = toolWith(async (p) => {
    if (p === "FAIL") throw new Error("404 not_found_error");
    return "ok";
  });
  const result = await tool.execute(
    "id",
    {
      script: `${header("agent_errors_done")}return await parallel([() => agent('FAIL', {label:'bad'}), () => agent('ok', {label:'good'})])`,
    },
    undefined,
    undefined,
    makeCtx(),
  );
  const [part] = result.content;
  assert.equal(part.type, "text");
  assert.match(part.text, /Result:\n[\s\S]*\]\n\nAgent errors:\n- agent bad failed: 404 not_found_error$/);
});

test("a run with no failed agents has no Agent errors section", async () => {
  const tool = toolWith(async (p) => p);
  const result = await tool.execute(
    "id",
    { script: `${header("no_agent_errors")}return await agent('ok', {label:'good'})` },
    undefined,
    undefined,
    makeCtx(),
  );
  const [part] = result.content;
  assert.equal(part.type, "text");
  assert.doesNotMatch(part.text, /Agent errors:/);
});

test("a failed run's error lists failed agents after the status line and message", async () => {
  const tool = toolWith(async (p) => {
    if (p === "FAIL") throw new Error("404 not_found_error");
    return "ok";
  });
  await assert.rejects(
    tool.execute(
      "id",
      { script: `${header("agent_errors_fail")}await agent('FAIL', {label:'bad'}); throw new Error("boom")` },
      undefined,
      undefined,
      makeCtx(),
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /^✘ Failed in \d+s · 1 agents · 0 tokens\nboom\n\nAgent errors:\n- agent bad failed: 404 not_found_error$/,
      );
      return true;
    },
  );
});

test("a long agent error is capped at 500 characters on its Agent errors line", async () => {
  const tool = toolWith(async (p) => {
    if (p === "FAIL") throw new Error("x".repeat(600));
    return "ok";
  });
  const result = await tool.execute(
    "id",
    { script: `${header("agent_errors_long")}return await agent('FAIL', {label:'bad'})` },
    undefined,
    undefined,
    makeCtx(),
  );
  const [part] = result.content;
  assert.equal(part.type, "text");
  const line = part.text.split("\n").find((l) => l.startsWith("- agent bad failed: "));
  assert.equal(line?.length, 2 + 500);
});

test("F1: stopping a run with queued agents never marks one running, and a skipped agent stays skipped", async () => {
  const tool = createWorkflowTool({
    concurrency: 1,
    agent: {
      run: ((prompt: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(`r:${prompt}`), 10_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Subagent was aborted"));
          });
        })) as never,
    },
  });
  const pending = tool.execute(
    "id",
    { script: `${header("queued_race")}return await parallel([1,2,3,4,5,6,7,8].map(i => () => agent('t'+i)))` },
    undefined,
    undefined,
    makeCtx(),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const runId = workflowRuns.list()[0].id;
  workflowRuns.stopAgent(runId, 3);
  workflowRuns.stopRun(runId);
  await pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  const agents = workflowRuns.list().find((r) => r.id === runId)?.agents ?? [];
  assert.equal(agents.length, 8);
  assert.deepEqual(
    agents.filter((a) => a.status === "running").map((a) => a.id),
    [],
  );
  assert.equal(agents[2].status, "skipped");
});

test("P3-2: an agent left running by a failed script stays stopped when it later finishes", async () => {
  let finish = () => {};
  const tool = createWorkflowTool({
    concurrency: 2,
    agent: {
      run: ((prompt: string, opts: { onEvent?: (event: unknown) => void }) =>
        new Promise((resolve) => {
          finish = () => {
            opts.onEvent?.({ type: "usage", tokens: 500 });
            resolve(`r:${prompt}`);
          };
        })) as never,
    },
  });
  await assert.rejects(
    tool.execute(
      "id",
      { script: `${header("fail_bg")}agent('t1'); throw new Error("boom")` },
      undefined,
      undefined,
      makeCtx(),
    ),
  );
  const run = workflowRuns.list()[0];
  assert.equal(run.status, "failed");
  const before = formatRunStatusLine(run, run.endedAt);
  assert.equal(run.agents[0].status, "stopped");
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.agents[0].status, "stopped");
  assert.equal(run.agents[0].tokens, 0);
  assert.equal(formatRunStatusLine(run, run.endedAt), before);
  assert.match(before, / 0\/1 · /);
});
