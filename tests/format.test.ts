import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, formatTokens, isAgentFinished } from "../src/format.js";

test("formatDuration floors to seconds across unit boundaries", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_900), "59s");
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(102_000), "1m 42s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(formatDuration(3_720_000), "1h 2m");
});

test("formatTokens switches to k at 1000 and M at one million", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(48_900), "48.9k");
  assert.equal(formatTokens(999_999), "999.9k");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("isAgentFinished is false for queued, running and stopped", () => {
  for (const s of ["queued", "running", "stopped"] as const) assert.equal(isAgentFinished(s), false);
  for (const s of ["done", "failed", "skipped", "error"] as const) assert.equal(isAgentFinished(s), true);
});
