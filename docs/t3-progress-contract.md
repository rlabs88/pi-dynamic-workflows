# t3code progress files

A host that cannot see a background run over its RPC channel can ask the extension to mirror the run to disk.
t3code does this for omp: in an RPC session the `workflow` tool returns at once, `onUpdate` is dropped, and the in-memory run store is only visible to the omp TUI.

The feature is off unless the host sets `T3_WORKFLOW_PROGRESS_DIR` (an absolute path) in the omp environment.
With it unset the extension writes nothing and the tool result is unchanged.
Implementation: `src/progress-file.ts`. Wire types are exported from `src/index.ts`; `schemaVersion` guards drift between this repo and the reader.

## Layout

```text
<root>/<runKey>/progress.json           atomic snapshot, rewritten
<root>/<runKey>/script.js               normalized script, written once at launch
<root>/<runKey>/agents/<agentId>.jsonl  per-agent transcript, append-only
<root>/<runKey>/stop                    sentinel created by the host
```

- `runKey = <runId>-<startedAt in base 36>`, for example `wf_1-mhd3k9x`. `runId` (`wf_N`) restarts with each omp process; the suffix keeps keys unique.
- `agentId = "a" + <AgentRecord.id>` (`^a[0-9]+$`). `index = id - 1`.
- The extension creates `<root>/<runKey>/agents` itself. The host only guarantees `<root>` exists.
- A failure to write the directory never fails the workflow: progress files are disabled for that run and a `progress files disabled: …` log line is added to the run.

## Launch result

When the env var is set, the tool result `details` gain `runKey`, `progressPath` and `transcriptDir`.
This applies to the background launch ACK and to the foreground final result.
Existing keys are unchanged. On omp, whose `xdev` layer wraps tool calls, the details arrive as `details.xdev.inner`.

```json
{ "runId": "wf_1", "background": true, "runKey": "wf_1-mhd3k9x", "progressPath": "<root>/wf_1-mhd3k9x/progress.json", "transcriptDir": "<root>/wf_1-mhd3k9x/agents" }
```

## `progress.json`

Written as `progress.json.<pid>.tmp` plus `rename`, so a reader never sees a partial file.
`seq` increases with every write. The initial snapshot (`status: "running"`, no agents) exists before the tool returns.
Writes follow the run store's notifications (debounced to 50 ms); unchanged snapshots are not rewritten.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `runKey`, `runId`, `name`, `description?` | identity |
| `status` | `running`, `completed`, `failed` or `stopped` |
| `stopReason?` | only with `stopped`: `user` (sentinel, or `x` in the TUI) or `aborted` (session ended, or the host aborted a foreground run) |
| `seq`, `startedAt`, `updatedAt`, `endedAt?` | counters and epoch milliseconds |
| `error?` | failure or stop reason, at most 4 000 characters |
| `result?` | the workflow's return value as JSON text, at most 20 000 characters; only when `completed` |
| `phases` | `{ index, title }` in first-seen order, 0-based |
| `agents` | `WireAgent[]` ordered by `index` |
| `totals` | `{ totalTokens, toolCalls, durationMs }` |
| `handles` | `{ runId, runDir, transcriptDir, scriptPath }` (absolute paths) |

`WireAgent`: `index`, `agentId`, `label`, `state`, `endReason?`, `phaseIndex?`, `phaseTitle?`, `model?`, `attempt` (always 1), `totalTokens`, `toolCalls`, `durationMs?`, `queuedAt`, `startedAt?`, `completedAt?`, `prompt?`, `result?`, `error?`.

- `state` is `queued`, `running`, `completed` or `failed`.
- A user-skipped agent is `failed` with `endReason: "skipped"`. An agent still unfinished when the run ended is `failed` with `endReason: "stopped"`.
- `totalTokens` is input plus output. omp's own `totalTokens` includes cache reads, which would read as hundreds of thousands for a one-line reply, so the TUI figure and this one differ. A usage object without an input/output split falls back to its total.
- `prompt` is the full prompt sent to the subagent once it started, the script's prompt before that; at most 20 000 characters. `result` is the agent's string result or its JSON, at most 20 000 characters.

Once `status` leaves `running` the file is never rewritten, and the terminal snapshot is on disk before the `workflow-notification` message is sent.

`progress.json` stays under 4 MiB (the reader refuses files over 8 MiB). When a snapshot would be larger, settled agents lose most of their `prompt` and `result` first, oldest first, then every agent loses them; the transcripts keep the full text.

## Transcripts

One JSON object per line, appended with a single write, so a reader consumes only `\n`-terminated lines.
Each line carries `{ "v": 1, "seq": <per file, from 1>, "at": <epoch ms> }` plus:

| `kind` | Fields |
|---|---|
| `user` | `text`: the full prompt, written when the agent starts |
| `assistant` | `text`: one per assistant message with non-empty text |
| `tool_start` | `id`, `name`, `args` (JSON text, at most 4 000 characters) |
| `tool_end` | `id`, `name`, `result` (at most 2 000 characters), `isError` |
| `end` | `state: "completed" \| "failed"`, `result?`, `error?` |
| `truncated` | the file reached 4 MiB; nothing follows |

A transcript line is appended before the progress snapshot that reflects it. A reader that reads `progress.json` first and the transcripts second never sees a snapshot ahead of its transcripts.
Agents that never started (still queued when the run ended, or skipped while queued) have no transcript file.
When a run ends with agents still running, the extension writes their `end` line (`failed`) before the terminal snapshot.

## Stop

The host creates `<runKey>/stop` (any content). The extension checks for it every 250 ms while the run is `running` and then stops the run as `/workflows` `x` does.
The run ends `stopped` with `stopReason: "user"` and `error: "Workflow was stopped by the user"`.
Ending the omp session stops background runs with `stopReason: "aborted"` and `error: "Workflow was aborted"`.
Esc on the launching turn does not stop a background run.
