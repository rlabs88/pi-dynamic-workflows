import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { workflowRuns } from "../src/run-store.js";
import {
  endWorkflowSession,
  MAX_NOTIFICATION_RESULT_CHARS,
  type NotificationDelivery,
  type WorkflowNotificationMessage,
  type WorkflowNotifier,
} from "../src/workflow-notify.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

type Sent = { message: WorkflowNotificationMessage; delivery: NotificationDelivery };
type Launch = { content: { type: string; text: string }[]; details: { runId: string; background: boolean } };

/** A test-local hang guard: a launch that blocks fails this test instead of hanging the run. */
const LAUNCH_TIMEOUT_MS = 2000;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const header = (name: string) => `export const meta = { name: '${name}', description: 'd' }\n`;

function makeCtx(hasUI = true): ExtensionContext {
  return { cwd: process.cwd(), hasUI } as unknown as ExtensionContext;
}

/** Records notifications and resolves `received(n)` once n have arrived; no polling. */
function recorder() {
  const sent: Sent[] = [];
  let waiter: { count: number; resolve: () => void } | undefined;
  const notifier: WorkflowNotifier = {
    notify: (message, delivery) => {
      sent.push({ message, delivery });
      if (waiter && sent.length >= waiter.count) waiter.resolve();
    },
  };
  const received = (count = 1): Promise<void> => {
    if (sent.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiter = { count, resolve };
    return promise;
  };
  return { sent, notifier, received };
}

/** Resolves once the run leaves `running`, driven by the run store's own subscription. */
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

function toolWith(run: (prompt: string) => Promise<string>, notifier?: WorkflowNotifier): ToolDefinition {
  return createWorkflowTool({
    concurrency: 4,
    agent: { run: (prompt: string) => run(prompt) as never },
    ...(notifier ? { notifier } : {}),
  });
}

function render(tool: ToolDefinition, result: unknown): string[] {
  const component = tool.renderResult?.(result as never, { isPartial: false, expanded: false }, theme, {} as never);
  assert(component);
  return component.render(200).map((line) => line.trimEnd());
}

test("a workflow with a notifier returns at once and reports the background launch", {
  timeout: LAUNCH_TIMEOUT_MS,
}, async () => {
  const gate = Promise.withResolvers<void>();
  const { sent, notifier, received } = recorder();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  }, notifier);

  const result = (await tool.execute(
    "id",
    { script: `${header("bg_launch")}await agent('slow')` },
    undefined,
    undefined,
    makeCtx(),
  )) as unknown as Launch;

  assert.equal(result.details.background, true);
  assert.match(result.content[0].text, /^Workflow launched in background\. Task ID: \S+ \(bg_launch\)\./);
  assert.equal(sent.length, 0, "nothing is delivered before the run ends");
  assert.equal(workflowRuns.list().find((r) => r.id === result.details.runId)?.status, "running");

  gate.resolve();
  await received(1);
  assert.match(sent[0].message.content, /<status>completed<\/status>/);
  assert.match(sent[0].message.content, /<summary>Dynamic workflow "bg_launch" completed<\/summary>/);
  assert.match(sent[0].message.content, new RegExp(`<task-id>${result.details.runId}</task-id>`));
  assert.notEqual(sent[0].delivery.deliverAs, "nextTurn", "a finished run wakes the session");
});

test("aborting the launching turn leaves a background run running", { timeout: LAUNCH_TIMEOUT_MS }, async () => {
  const gate = Promise.withResolvers<void>();
  const { sent, notifier, received } = recorder();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  }, notifier);
  const turn = new AbortController();

  const result = (await tool.execute(
    "id",
    { script: `${header("bg_esc")}await agent('slow')` },
    turn.signal,
    undefined,
    makeCtx(),
  )) as unknown as Launch;
  turn.abort();
  assert.equal(workflowRuns.list().find((r) => r.id === result.details.runId)?.status, "running");

  gate.resolve();
  await received(1);
  assert.match(sent[0].message.content, /<status>completed<\/status>/);
});

test("without a UI the tool waits for the run and returns its result even with a notifier", {
  timeout: LAUNCH_TIMEOUT_MS,
}, async () => {
  const { sent, notifier } = recorder();
  const tool = toolWith(async () => "done-value", notifier);

  const result = (await tool.execute(
    "id",
    { script: `${header("fg_print")}return await agent('x')` },
    undefined,
    undefined,
    makeCtx(false),
  )) as unknown as { content: { text: string }[] };

  assert.match(result.content[0].text, /Result:\n"done-value"/);
  assert.equal(sent.length, 0, "a foreground run answers in its tool result, not a notification");
});

test("a failed background run notifies with status failed and the error", { timeout: LAUNCH_TIMEOUT_MS }, async () => {
  const { sent, notifier, received } = recorder();
  const tool = toolWith(async () => "ok", notifier);

  await tool.execute(
    "id",
    { script: `${header("bg_fail")}await agent('Reply ok', {label:'one'}); throw new Error("boom")` },
    undefined,
    undefined,
    makeCtx(),
  );

  await received(1);
  assert.match(sent[0].message.content, /<status>failed<\/status>/);
  assert.match(sent[0].message.content, /<summary>Dynamic workflow "bg_fail" failed: boom<\/summary>/);
  assert.equal(sent[0].message.details.status, "failed");
});

test("a user stop from /workflows notifies quietly for the next turn, reported as killed", {
  timeout: LAUNCH_TIMEOUT_MS,
}, async () => {
  const gate = Promise.withResolvers<void>();
  const { sent, notifier, received } = recorder();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  }, notifier);

  const result = (await tool.execute(
    "id",
    { script: `${header("bg_stop")}await agent('slow')` },
    undefined,
    undefined,
    makeCtx(),
  )) as unknown as Launch;
  workflowRuns.stopRun(result.details.runId);
  gate.resolve();

  await received(1);
  assert.deepEqual(sent[0].delivery, { deliverAs: "nextTurn" });
  assert.match(sent[0].message.content, /<status>killed<\/status>/);
  assert.match(sent[0].message.content, /was stopped<\/summary>/);
});

test("a result longer than the notification limit is cut with a note", { timeout: LAUNCH_TIMEOUT_MS }, async () => {
  const { sent, notifier, received } = recorder();
  const tool = toolWith(async () => "x".repeat(MAX_NOTIFICATION_RESULT_CHARS + 1000), notifier);

  await tool.execute(
    "id",
    { script: `${header("bg_long")}return await agent('big')` },
    undefined,
    undefined,
    makeCtx(),
  );

  await received(1);
  const body = sent[0].message.content;
  assert.ok(
    body.includes(`${"x".repeat(MAX_NOTIFICATION_RESULT_CHARS)}\n[result truncated: 1000 more characters not shown]`),
    "result is cut at the limit and says how much was dropped",
  );
  assert.ok(!body.includes("x".repeat(MAX_NOTIFICATION_RESULT_CHARS + 1)));
});

test("ending the session stops background runs and suppresses their notification", {
  timeout: LAUNCH_TIMEOUT_MS,
}, async () => {
  const gate = Promise.withResolvers<void>();
  const { sent, notifier } = recorder();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  }, notifier);

  const result = (await tool.execute(
    "id",
    { script: `${header("bg_teardown")}await agent('slow')` },
    undefined,
    undefined,
    makeCtx(),
  )) as unknown as Launch;
  endWorkflowSession();
  gate.resolve();

  await untilRunEnds(result.details.runId);
  // The notify path runs as promise continuations after the status flips; one macrotask flushes them.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, "a torn-down session receives no notification");
  assert.equal(workflowRuns.list().find((r) => r.id === result.details.runId)?.status, "stopped");
});

test("a background launch row says it runs in the background and points to /workflows", {
  timeout: LAUNCH_TIMEOUT_MS,
}, async () => {
  const gate = Promise.withResolvers<void>();
  const { notifier, received } = recorder();
  const tool = toolWith(async (p) => {
    if (p === "slow") await gate.promise;
    return p;
  }, notifier);

  const result = await tool.execute(
    "id",
    { script: `${header("bg_row")}await agent('slow')` },
    undefined,
    undefined,
    makeCtx(),
  );
  const lines = render(tool, result);
  assert.ok(
    lines.some((line) => line.includes("Running in background · /workflows to monitor and save")),
    lines.join("\n"),
  );

  gate.resolve();
  await received(1);
});
