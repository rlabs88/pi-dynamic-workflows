import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunEvent, AgentRunOptions } from "../src/agent.js";
import {
  SNAPSHOT_BYTE_CAP,
  T3_WORKFLOW_PROGRESS_DIR_ENV,
  TRANSCRIPT_BYTE_CAP,
  WIRE_TEXT_CAP,
  type WireProgress,
  type WireTranscriptLine,
} from "../src/progress-file.js";
import { workflowRuns } from "../src/run-store.js";
import { endWorkflowSession, type WorkflowNotificationMessage, type WorkflowNotifier } from "../src/workflow-notify.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

interface LaunchDetails {
  runId: string;
  background?: boolean;
  runKey?: string;
  progressPath?: string;
  transcriptDir?: string;
}
type Launch = { details: LaunchDetails };
type Runner = (prompt: string, options: AgentRunOptions) => Promise<unknown>;

const header = (name: string) => `export const meta = { name: '${name}', description: 'd' }\n`;

function makeCtx(hasUI = true): ExtensionContext {
  return { cwd: process.cwd(), hasUI } as unknown as ExtensionContext;
}

/**
 * Runs `body` with T3_WORKFLOW_PROGRESS_DIR pointing at a fresh directory, restoring the environment after.
 * The progress sink unrefs its stop-poll timer (production must not keep omp alive), so a test that only awaits
 * promises would let the event loop drain and be cancelled; a ref'd interval holds it open for the body.
 */
async function withProgressRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "t3-progress-"));
  const previous = process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
  process.env[T3_WORKFLOW_PROGRESS_DIR_ENV] = root;
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await body(root);
  } finally {
    clearInterval(keepAlive);
    if (previous === undefined) delete process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
    else process.env[T3_WORKFLOW_PROGRESS_DIR_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Collects notifications; `received` resolves once one has arrived. */
function recorder(onNotify?: (message: WorkflowNotificationMessage) => void) {
  const sent: WorkflowNotificationMessage[] = [];
  let resolveFirst: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const notifier: WorkflowNotifier = {
    notify: (message) => {
      onNotify?.(message);
      sent.push(message);
      resolveFirst();
    },
  };
  return { sent, notifier, received: first };
}

function toolWith(runner: Runner, notifier?: WorkflowNotifier): ToolDefinition {
  return createWorkflowTool({
    concurrency: 4,
    agent: { run: runner as never },
    ...(notifier ? { notifier } : {}),
  });
}

function untilRunEnds(runId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const isRunning = () => workflowRuns.list().find((r) => r.id === runId)?.status === "running";
  const unsubscribe = workflowRuns.subscribe(() => {
    if (isRunning()) return;
    unsubscribe();
    resolve();
  });
  if (!isRunning()) {
    unsubscribe();
    resolve();
  }
  return promise;
}

async function launch(tool: ToolDefinition, script: string, hasUI = true): Promise<Launch> {
  return (await tool.execute("id", { script }, undefined, undefined, makeCtx(hasUI))) as unknown as Launch;
}

function readProgress(progressPath: string): WireProgress {
  return JSON.parse(readFileSync(progressPath, "utf8")) as WireProgress;
}

/** Whole `\n`-terminated lines only, as the host reads them. */
function readTranscript(transcriptDir: string, agentId: string): WireTranscriptLine[] {
  const text = readFileSync(join(transcriptDir, `${agentId}.jsonl`), "utf8");
  assert.ok(text === "" || text.endsWith("\n"), "the file ends on a whole line");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireTranscriptLine);
}

function launched(
  result: Launch,
): Required<Pick<LaunchDetails, "runKey" | "progressPath" | "transcriptDir">> & LaunchDetails {
  const { runKey, progressPath, transcriptDir } = result.details;
  assert.ok(runKey && progressPath && transcriptDir, "launch details carry the progress handles");
  return { ...result.details, runKey, progressPath, transcriptDir };
}

/** A runner that reports a full agent lifecycle the way a real session would. */
const scriptedAgent: Runner = async (prompt, options) => {
  const emit = (event: AgentRunEvent) => options.onEvent?.(event);
  emit({ type: "start", prompt: `full: ${prompt}`, model: "haiku-5-5" });
  emit({ type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } });
  emit({ type: "tool_end", id: "t1", name: "bash", result: "contracts\nshared", isError: false });
  emit({ type: "message", text: "two packages" });
  emit({ type: "usage", tokens: 432_000, ioTokens: 40, model: "haiku-5-5" });
  return `answer to ${prompt}`;
};

/** A runner that never finishes on its own: it ends when its signal aborts. */
const blockedAgent: Runner = (_prompt, options) => {
  const { promise, reject } = Promise.withResolvers<never>();
  options.signal?.addEventListener("abort", () => reject(new Error("Subagent was aborted")), { once: true });
  return promise;
};

/** Resolves on the run store's next change notification (its own debounce timer; no test-side waiting). */
function nextStoreNotify(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = workflowRuns.subscribe(() => {
    unsubscribe();
    resolve();
  });
  return promise;
}

test("without the env var no files are written and the launch details are unchanged", async () => {
  const previous = process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
  delete process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
  try {
    const { notifier, received } = recorder();
    const result = await launch(toolWith(scriptedAgent, notifier), `${header("no_env")}await agent('x')`);
    await received;
    assert.deepEqual(Object.keys(result.details).sort(), ["background", "runId"]);
  } finally {
    if (previous !== undefined) process.env[T3_WORKFLOW_PROGRESS_DIR_ENV] = previous;
  }
});

test("a background launch returns the handles with a running snapshot and the script already on disk", async () => {
  await withProgressRoot(async (root) => {
    const { notifier, received } = recorder();
    const source = `${header("launch_files")}await agent('x')`;
    const result = launched(await launch(toolWith(blockedAgent, notifier), source));

    assert.equal(result.background, true);
    assert.equal(
      result.runKey,
      `${result.runId}-${workflowRuns
        .list()
        .find((r) => r.id === result.runId)
        ?.startedAt.toString(36)}`,
    );
    assert.equal(result.progressPath, join(root, result.runKey, "progress.json"));
    assert.equal(result.transcriptDir, join(root, result.runKey, "agents"));

    const progress = readProgress(result.progressPath);
    assert.equal(progress.schemaVersion, 1);
    assert.equal(progress.status, "running");
    assert.equal(progress.name, "launch_files");
    assert.equal(progress.description, "d");
    assert.equal(progress.runKey, result.runKey);
    assert.deepEqual(progress.handles, {
      runId: result.runId,
      runDir: join(root, result.runKey),
      transcriptDir: result.transcriptDir,
      scriptPath: join(root, result.runKey, "script.js"),
    });
    assert.equal(readFileSync(progress.handles.scriptPath, "utf8"), source.trim());
    assert.equal(existsSync(join(root, result.runKey, "stop")), false);

    workflowRuns.stopRun(result.runId);
    await received;
  });
});

test("a fenced script is written to script.js without the fence", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const result = launched(
      await launch(toolWith(scriptedAgent, notifier), `\`\`\`js\n${header("fenced")}await agent('x')\n\`\`\``),
    );
    await received;
    const script = readFileSync(readProgress(result.progressPath).handles.scriptPath, "utf8");
    assert.ok(script.startsWith("export const meta"), script);
  });
});

test("a finished run shows phases, indices, io-token totals, tool counts, durations, prompt and result", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const tool = toolWith(async (prompt, options) => {
      const value = await scriptedAgent(prompt, options);
      return prompt === "beta" ? "r".repeat(WIRE_TEXT_CAP + 500) : value;
    }, notifier);
    const result = launched(
      await launch(
        tool,
        `${header("lifecycle")}phase('Scan')\nconst a = await agent('alpha', {label:'first'})\nphase('Merge')\nconst b = await agent('beta', {label:'second'})\nreturn { a, n: 2 }`,
      ),
    );
    await received;

    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "completed");
    assert.equal(progress.stopReason, undefined);
    assert.deepEqual(progress.phases, [
      { index: 0, title: "Scan" },
      { index: 1, title: "Merge" },
    ]);
    assert.deepEqual(
      progress.agents.map((a) => [a.index, a.agentId, a.label, a.state, a.phaseIndex, a.phaseTitle]),
      [
        [0, "a1", "first", "completed", 0, "Scan"],
        [1, "a2", "second", "completed", 1, "Merge"],
      ],
    );
    const [first, second] = progress.agents;
    assert.equal(first.totalTokens, 40, "input plus output, not the 432000 including cache reads");
    assert.equal(first.toolCalls, 1);
    assert.equal(first.model, "haiku-5-5");
    assert.equal(first.prompt, "full: alpha");
    assert.equal(first.result, "answer to alpha");
    assert.ok(first.startedAt !== undefined && first.completedAt !== undefined);
    assert.equal(first.durationMs, (first.completedAt ?? 0) - (first.startedAt ?? 0));
    assert.equal(second.result?.length, WIRE_TEXT_CAP, "result is capped");
    assert.deepEqual(progress.totals.totalTokens, 80);
    assert.equal(progress.totals.toolCalls, 2);
    assert.equal(progress.endedAt !== undefined, true);
    assert.deepEqual(JSON.parse(progress.result ?? "null"), { a: "answer to alpha", n: 2 });
  });
});

test("a run with many large agents keeps progress.json under the cap, shortening settled agents only", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const tool = toolWith(async (prompt, options) => {
      options.onEvent?.({ type: "start", prompt: "p".repeat(WIRE_TEXT_CAP), model: "haiku-5-5" });
      return `${prompt}:${"r".repeat(WIRE_TEXT_CAP)}`;
    }, notifier);
    const result = launched(
      await launch(tool, `${header("big")}for (let i = 0; i < 150; i++) await agent('a' + i)\nreturn 1`),
    );
    await received;

    assert.ok(statSync(result.progressPath).size <= SNAPSHOT_BYTE_CAP, "the snapshot respects the cap");
    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "completed");
    assert.equal(progress.agents.length, 150);
    assert.ok(progress.agents.every((a) => a.state === "completed"));
    assert.ok(progress.agents[0].result !== undefined && progress.agents[0].result.length < WIRE_TEXT_CAP);
    const transcript = readTranscript(result.transcriptDir, "a1");
    assert.equal(transcript.at(-1)?.kind, "end", "the transcript keeps the full text");
  });
});

test("every snapshot read while events stream parses, and seq never decreases", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const tool = toolWith(async (prompt, options) => {
      options.onEvent?.({ type: "start", prompt });
      for (let i = 0; i < 12; i++) {
        options.onEvent?.({ type: "tool_start", id: `t${i}`, name: "bash", args: { i } });
        options.onEvent?.({ type: "tool_end", id: `t${i}`, name: "bash", result: "ok", isError: false });
        await nextStoreNotify();
      }
      return "done";
    }, notifier);
    const result = launched(
      await launch(tool, `${header("atomic")}await parallel([() => agent('a'), () => agent('b'), () => agent('c')])`),
    );

    let finished = false;
    void received.then(() => {
      finished = true;
    });
    const seqs: number[] = [];
    while (!finished) {
      seqs.push(readProgress(result.progressPath).seq);
      await new Promise((resolve) => setImmediate(resolve));
    }
    seqs.push(readProgress(result.progressPath).seq);

    assert.ok(seqs.length > 10, `reader observed ${seqs.length} snapshots`);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.ok(new Set(seqs).size > 3, "the snapshot changed while the run streamed");
    assert.equal(readdirSync(dirname(result.progressPath)).filter((n) => n.endsWith(".tmp")).length, 0);
  });
});

test("a transcript holds user, tool_start, tool_end, assistant, end in order with per-file seq", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const result = launched(await launch(toolWith(scriptedAgent, notifier), `${header("order")}await agent('p')`));
    await received;

    const lines = readTranscript(result.transcriptDir, "a1");
    assert.deepEqual(
      lines.map((l) => l.kind),
      ["user", "tool_start", "tool_end", "assistant", "end"],
    );
    assert.deepEqual(
      lines.map((l) => l.seq),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(lines[0], { ...lines[0], v: 1, kind: "user", text: "full: p" });
    assert.deepEqual(lines[1], { ...lines[1], kind: "tool_start", id: "t1", name: "bash", args: '{"command":"ls"}' });
    assert.deepEqual(lines[2], {
      ...lines[2],
      kind: "tool_end",
      id: "t1",
      name: "bash",
      result: "contracts\nshared",
      isError: false,
    });
    assert.deepEqual(lines[3], { ...lines[3], kind: "assistant", text: "two packages" });
    assert.deepEqual(lines[4], { ...lines[4], kind: "end", state: "completed", result: "answer to p" });
  });
});

test("a transcript past 4 MiB ends with exactly one truncated line and the run still completes", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const tool = toolWith(async (prompt, options) => {
      options.onEvent?.({ type: "start", prompt });
      const result = "x".repeat(5000);
      for (let i = 0; i < 2300; i++) {
        options.onEvent?.({ type: "tool_start", id: `t${i}`, name: "read", args: {} });
        options.onEvent?.({ type: "tool_end", id: `t${i}`, name: "read", result, isError: false });
      }
      return "done";
    }, notifier);
    const result = launched(await launch(tool, `${header("big")}await agent('p')`));
    await received;

    const file = join(result.transcriptDir, "a1.jsonl");
    assert.ok(statSync(file).size <= TRANSCRIPT_BYTE_CAP + 200, "no line lands past the cap");
    const lines = readTranscript(result.transcriptDir, "a1");
    assert.equal(lines.filter((l) => l.kind === "truncated").length, 1);
    assert.equal(lines.at(-1)?.kind, "truncated");
    const tail = lines.filter((l) => l.kind === "tool_end");
    assert.ok(
      tail.every((l) => l.kind === "tool_end" && l.result.length <= 2000),
      "tool results are capped at 2000",
    );
    assert.equal(readProgress(result.progressPath).status, "completed");
  });
});

test("a failed agent shows as failed with its error; a throwing script fails the run", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const tool = toolWith(async (prompt, options) => {
      options.onEvent?.({ type: "start", prompt });
      throw new Error("model exploded");
    }, notifier);
    const result = launched(
      await launch(tool, `${header("fails")}await agent('x', {label:'doomed'})\nthrow new Error('script broke')`),
    );
    await received;

    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "failed");
    assert.equal(progress.error, "script broke");
    assert.equal(progress.stopReason, undefined);
    assert.equal(progress.agents[0].state, "failed");
    assert.equal(progress.agents[0].endReason, undefined);
    assert.equal(progress.agents[0].error, "model exploded");
    const end = readTranscript(result.transcriptDir, "a1").at(-1);
    assert.deepEqual(end && { ...end, at: 0, seq: 0 }, {
      v: 1,
      seq: 0,
      at: 0,
      kind: "end",
      state: "failed",
      error: "model exploded",
    });
  });
});

test("the stop sentinel stops the run: stopped/user, unfinished agents failed with endReason stopped", async () => {
  await withProgressRoot(async (root) => {
    const { sent, notifier, received } = recorder();
    const tool = toolWith(blockedAgent, notifier);
    const result = launched(
      await launch(tool, `${header("sentinel")}await parallel([() => agent('a'), () => agent('b')])`),
    );
    // The extension polls for this file on a real 250 ms timer; the test waits on the resulting notification.
    writeFileSync(join(root, result.runKey, "stop"), "user");
    await received;

    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "stopped");
    assert.equal(progress.stopReason, "user");
    assert.equal(progress.error, "Workflow was stopped by the user");
    assert.deepEqual(
      progress.agents.map((a) => [a.state, a.endReason]),
      [
        ["failed", "stopped"],
        ["failed", "stopped"],
      ],
    );
    assert.match(sent[0].content, /<status>killed<\/status>/);
    const end = readTranscript(result.transcriptDir, "a1").at(-1);
    assert.equal(end?.kind, "end");
  });
});

test("a user-skipped agent ends failed with endReason skipped while the run completes", async () => {
  await withProgressRoot(async () => {
    const { notifier, received } = recorder();
    const gate = Promise.withResolvers<void>();
    const tool = toolWith(async (prompt, options) => {
      if (prompt !== "skipme") return "kept";
      options.onEvent?.({ type: "start", prompt });
      gate.resolve();
      return blockedAgent(prompt, options);
    }, notifier);
    const result = launched(
      await launch(tool, `${header("skip")}return await parallel([() => agent('skipme'), () => agent('other')])`),
    );
    await gate.promise;
    workflowRuns.stopAgent(result.runId, 1);
    await received;

    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "completed");
    assert.deepEqual(
      progress.agents.map((a) => [a.state, a.endReason]),
      [
        ["failed", "skipped"],
        ["completed", undefined],
      ],
    );
    const end = readTranscript(result.transcriptDir, "a1").at(-1);
    assert.equal(end?.kind === "end" && end.state, "failed");
  });
});

test("ending the session stops a background run as stopped/aborted without a notification", async () => {
  await withProgressRoot(async () => {
    const { sent, notifier } = recorder();
    const result = launched(await launch(toolWith(blockedAgent, notifier), `${header("teardown")}await agent('a')`));
    const ended = untilRunEnds(result.runId);
    endWorkflowSession();
    await ended;

    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "stopped");
    assert.equal(progress.stopReason, "aborted");
    assert.equal(progress.agents[0].endReason, "stopped");
    assert.equal(sent.length, 0);
  });
});

test("the terminal snapshot is on disk before the notification fires, and is never rewritten", async () => {
  await withProgressRoot(async () => {
    const seenAtNotify: WireProgress[] = [];
    let progressPath = "";
    const { notifier, received } = recorder(() => seenAtNotify.push(readProgress(progressPath)));
    const result = launched(
      await launch(toolWith(scriptedAgent, notifier), `${header("order_final")}return await agent('p')`),
    );
    progressPath = result.progressPath;
    await received;

    assert.equal(seenAtNotify.length, 1);
    assert.equal(seenAtNotify[0].status, "completed");
    assert.equal(seenAtNotify[0].agents[0].state, "completed");
    const before = readFileSync(progressPath, "utf8");
    const notified = nextStoreNotify();
    workflowRuns.log(result.runId, "late log");
    await notified;
    assert.equal(readFileSync(progressPath, "utf8"), before, "a terminal snapshot is final");
  });
});

test("a foreground run (no UI) returns the handles and leaves a completed snapshot", async () => {
  await withProgressRoot(async () => {
    const result = launched(await launch(toolWith(scriptedAgent), `${header("fg")}return await agent('p')`, false));
    assert.equal(result.background, undefined);
    const progress = readProgress(result.progressPath);
    assert.equal(progress.status, "completed");
    assert.equal(progress.agents[0].result, "answer to p");
  });
});

test("an unwritable progress root does not stop the workflow and is logged on the run", async () => {
  const previous = process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
  const blocker = mkdtempSync(join(tmpdir(), "t3-progress-blocker-"));
  const file = join(blocker, "file");
  writeFileSync(file, "x");
  process.env[T3_WORKFLOW_PROGRESS_DIR_ENV] = join(file, "nested");
  try {
    const result = (await launch(
      toolWith(scriptedAgent),
      `${header("unwritable")}return await agent('p')`,
      false,
    )) as Launch;
    assert.equal(result.details.runKey, undefined);
    const run = workflowRuns.list().find((r) => r.name === "unwritable");
    assert.ok(run?.logs.some((l) => l.startsWith("progress files disabled:")));
    assert.equal(run?.status, "completed");
  } finally {
    if (previous === undefined) delete process.env[T3_WORKFLOW_PROGRESS_DIR_ENV];
    else process.env[T3_WORKFLOW_PROGRESS_DIR_ENV] = previous;
    rmSync(blocker, { recursive: true, force: true });
  }
});
