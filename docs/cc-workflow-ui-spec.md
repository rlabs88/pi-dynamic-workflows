# Workflow UI behavior spec (reference: Claude Code 2.1.301)

This spec records how Claude Code's dynamic-workflow terminal UI behaves, and
which parts this fork implements. It describes behavior and layout only. No
Claude Code source is copied.

Evidence came from two passes on 2026-10-15:

- **Static**: the JavaScript embedded in the `claude` 2.1.301 binary, read
  with REA (evidence `ev_0f41cfe1…`) and by hand.
- **Runtime**: 70 tmux frames of the real TUI driven through
  `ax cc --jm dpf`, five workflow runs (complete, live, stopped, failed).

Tags: **[obs]** seen on screen, **[code]** seen in code only, **[inf]** inferred.

## 1. Surfaces

| Surface | Where | Content |
|---|---|---|
| Tool row | transcript, under the workflow tool call | running: `Running in background · /workflows to monitor and save`; done: `✔ Completed in 7s · 3 agents · 147k tokens`; stopped: `✘ Stopped in 17s · 2 agents · 99.3k tokens`; failed: `✘ Failed in …` [obs] |
| Status line | below the editor, while a run is active | `◯ {name}  ▰▰▰▰▱▱▱▱…(20 cells)  {done}/{total} · {elapsed} · ↓ {tokens} tokens` [obs] |
| `/workflows` | dialog below the transcript | run list → workflow detail (phases → agents → agent) [obs] |

The model-facing progress text (a 4-cell braille bar) is separate from what
the user sees and is not part of this spec [code].

## 2. `/workflows` run list

```text
 Dynamic workflows                         1 running · 3 completed
 ❯ ⏺ slow-live-abort          14s · 2 agents · 99.3k tok
   ✔ slow-inspect             52s · 4 agents · 196k tok
   ✘ forced-failure           3s · 1 agent · 49k tok
 ↑↓ select · enter view · x stop · esc close
```

- Row: status glyph, name, right-aligned `{duration} · {n} agents · {n} tok`.
  Glyphs: `⏺` running, `✔` completed, `✘` failed or stopped [obs].
- Opens straight into detail when exactly one run exists [obs].
- Empty: `No dynamic workflows in this session.` [obs]
- `x` stops the selected run, shown only while it runs [obs].

## 3. Workflow detail

Header (three lines): a top rule, the bold name, then the description with
right-aligned stats `{done}/{total} agents · {elapsed}[ · done| · stopped| · failed]`.
Elapsed ticks once per second while running [obs].

### 3.1 Phases level, split with agents (width ≥ 64)

```text
╭ Phases ─────────┬ Inspect · 2 agents ─────────────────────────────╮
│ ❯ ✔ Inspect 2/2 │  ✔ A: math.js summary   model · 48.9k tok    3s │
│   ⠋ Missing 0/1 │                                                 │
╰─────────────────┴─────────────────────────────────────────────────╯
↑↓ select · x stop workflow · esc back
```

- Phase row: `❯` when selected, mark `✔` done / `✘` failed / 1-based number
  otherwise, title, `{done}/{total}` [obs].
- Phases are the runtime `phase()` titles in order; agents without a phase go
  to a synthetic `Agents` phase [code].
- The right pane lists the selected phase's agents [obs].

### 3.2 Agents level

Same split. Focus moves to the right pane (`❯` on the agent row). Agent row:
glyph, label, right-aligned `model · {n} tok · {stats}` and duration. Width
pressure drops the model first, then stats [code]. `f` cycles a status filter
and the pane title gains `· showing {status}` [obs].

### 3.3 Agent level, split agents │ card

```text
╭ Slow reads · 3 agents ──┬ summary: math.js ─────────────────────────╮
│ ❯ ✔ summary: math.js    │ ✔ Completed · model                       │
│   ✔ summary: stats.js   │ 49.3k tok · 2 tool calls · 40s            │
│                         │                                           │
│                         │ Prompt                                    │
│                         │     Step 1: Bash: for i in 1 2 3; …       │
│                         │ Activity · ⏎ expand                       │
│                         │   ⏺ Bash(for i in 1 2 3; do sleep 12; done)│
│                         │   ⏺ Read(/tmp/sandbox/math.js)            │
│                         │ Outcome                                   │
│                         │   math.js exports add and mul.            │
╰─────────────────────────┴───────────────────────────────────────────╯
↑↓ agent · j/k scroll · ⏎ expand · esc back
```

Agent card sections [obs + code]:

| Part | Content |
|---|---|
| Header | `{glyph} {Queued\|Running\|Completed\|Failed\|Skipped\|Stopped} · {model}` |
| Stats | `{tokens} tok · {n} tool calls · {duration}`, plus `idle {t}` after 30 s without progress |
| Prompt | the prompt the agent received; 2 lines collapsed |
| Activity | tool calls as `Name(args)`; the last 3 when collapsed, `· last 3 of N` in the title; all of them with inputs and results when expanded |
| Outcome | 20 lines collapsed: final text, pretty-printed JSON when it parses, the error for failed agents, `Still running…`, `Waiting for an agent slot.`, `The workflow stopped before this agent finished.`, `Skipped by user.` |

Collapsed sections end with `… N more lines`. `⏎` toggles expand [obs].

### 3.4 Narrow terminals (< 64 columns)

Single column: the selected level fills the width with a title row and a
`↑ a–b of n ↓` scroll indicator [code].

## 4. Keymap

| Key | List | Phases | Agents | Agent |
|---|---|---|---|---|
| `↑` `↓` | select run | select phase | select agent | previous / next agent |
| `j` `k` | — | select phase | select agent | scroll card |
| `enter` `→` | open run | to agents | to agent | expand / collapse |
| `esc` `←` | close | back to list or close | back | back |
| `x` | stop run | stop workflow | — | stop this agent |
| `f` | — | — | cycle filter | — |
| `p` | — | pause / resume | — | — |
| `r` | — | — | — | restart agent |
| `s` | save script | save script | save script | save script |

Bare keys only. Keys pressed with ctrl or meta are ignored [obs].

## 5. Stop and failure

- Stopping a run: the header shows `· stopped`; unfinished agents show `◌` and
  `stopped`; the tool row shows `✘ Stopped in …` [obs].
- Script error: the run is `✘ Failed`; agents that finished keep `✔` [obs].
- A failed agent: `✘`, and Outcome shows the error text [code].

## 6. Persistence

Claude Code writes run snapshots and per-agent JSONL transcripts under
`~/.claude/projects/<slug>/` and reopens finished runs read-only [code].

## 7. Fork scope

| Item | Status in this fork |
|---|---|
| Tool row: running, done, stopped, failed | Implemented. Upstream's phase tree is kept as the running display and gains a `/workflows` hint. |
| Status line below the editor with the 20-cell bar | Implemented. |
| `/workflows` list, auto-open when one run, empty state | Implemented. |
| `ctrl+alt+w` shortcut for `/workflows` | Addition: Claude Code has no key for it; `/workflows` works on both hosts while the tool is running. |
| Detail levels phases → agents → agent, split ≥ 64 cols, narrow single column | Implemented. |
| Agent card: header, stats, Prompt, Activity, Outcome, expand, scroll | Implemented. |
| Prompt section content | Collapsed: the task string the script passed to `agent()`. Expanded: the full prompt sent to the subagent, including the injected `Workflow phase:` and `Task label:` lines. |
| Agent counts in header and phase rows | Finished = done, failed, or skipped by the user. Agents cut off by a run stop are not counted, so a stopped run reads like Claude Code's `0/2 agents · stopped`. |
| Live output in Outcome while an agent runs | Deviation: Claude Code shows `Still running…`; this fork shows the agent's latest streamed text, dim (last 20 lines when collapsed), and `Still running…` only before any text arrives. |
| Live updates (1 s elapsed, event-driven redraw) | Implemented. |
| `x` stop run, stop workflow, stop agent | Implemented. A stopped agent counts as skipped and returns `null` to the script. |
| `f` filter | Implemented. |
| `p` pause / resume, `r` restart agent | Gap: the runtime has no pause or retry points. |
| `s` save script, saved `/name` workflows | Gap: no saved-workflow feature in this fork. |
| Launch permission dialog | Gap. |
| Background execution (tool returns at once) | Gap: the tool blocks until the run ends, as upstream does. `/workflows` and the status line stay usable during the run. |
| Disk persistence across sessions | Gap: runs are kept in memory for the session (last 10). |
