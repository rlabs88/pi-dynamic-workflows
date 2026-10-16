# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi) and omp, with a `/workflows` drill-down view.

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
# pi
pi install git:github.com/rlabs88/pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows

# omp (local checkout; omp loads the same entry through package.json "omp.extensions")
git clone https://github.com/rlabs88/pi-dynamic-workflows
omp install /path/to/pi-dynamic-workflows
```

Then restart the session (or run `/reload` in pi).

The extension registers a `workflow` tool, activates it on session start, and adds the `/workflows` command and the `ctrl+alt+w` shortcut.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and the tool row shows `✘ Stopped in …`.

### Drill-down view

While a workflow runs, a status line below the editor shows its progress:

```text
◯ e2e_drill  ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱  2/3 · 35s · ↓ 26.0k tokens
```

Open `/workflows` or press `ctrl+alt+w` (during or after a run) to browse runs. The view opens on the run list, or directly on the run when there is only one. Drill down from phases to agents to one agent's card. Captured from a live pi session (one agent was stopped with `x`):

```text
╭ Read · 3 agents ──────────────┬ read math.js ────────────────────────────────────────────────────────────────────────────────────────╮
│ ❯ ✔ read math.js          35s │ ✔ Completed · deepseek/deepseek-v4-flash                                                             │
│   ✔ read stats.js         32s │ 35.6k tok · 3 tool calls · 35s                                                                       │
│   ✘ read strings.js       37s │                                                                                                      │
│                               │ Prompt                                                                                               │
│                               │   Run the bash command `sleep 25`, then read math.js and reply with one line describing its exports. │
│                               │                                                                                                      │
│                               │ Activity · ⏎ expand                                                                                  │
│                               │   ✔ bash(command: sleep 25, timeout: 40)                                                             │
│                               │   ✔ bash(command: ls)                                                                                │
│                               │   ✔ read(path: math.js)                                                                              │
│                               │                                                                                                      │
│                               │ Outcome                                                                                              │
│                               │   math.js exports two functions, `add` and `mul`, which perform addition and multiplication.         │
╰───────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────╯
↑↓ agent · ⏎ expand · esc back
```

The agent card shows:

- **Prompt**: the task the script passed to `agent()`, 2 lines when collapsed. Expanded, it shows the full prompt the subagent received, including the injected phase and label lines.
- **Activity**: tool calls; expand for arguments and results.
- **Outcome**: the final output (JSON is pretty-printed), the error for a failed agent, or the agent's streamed text while it runs.
- Tokens, tool-call count, and duration in the header. The card updates live.

| Key | Effect |
| --- | --- |
| `↑` `↓` | Move the selection (at the card level: previous or next agent) |
| `enter` `→` | Open: run → phases → agents → agent card; on a card, expand or collapse |
| `esc` `←` | Back one level; close from the top |
| `j` `k` | Scroll the agent card; at the phases and agents levels, move the selection |
| `pageup` `pagedown` | Scroll the agent card by a page |
| `x` | Stop the selected run, the whole workflow (phases level), or one agent (card level). A stopped agent returns `null` to the script. |
| `f` | Filter agents by status (agents level) |

Runs are kept in memory for the current session (last 10). The layout splits into two panes at 64 columns or wider and falls back to one column below that. [`docs/cc-workflow-ui-spec.md`](docs/cc-workflow-ui-spec.md) records the Claude Code behavior this follows and the parts not implemented.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

### Choosing models

On omp, `opts.model` takes whatever `omp --model` takes: `provider/modelId[:thinking]`, a model name such as `grok-4.7`, or a role such as `@deepseek_flash`. Omp resolves it the same way it resolves its own flag. An array is an ordered fallback list: the first entry that resolves to a model with credentials is used.

On pi, only exact `provider/modelId[:thinking]` entries are accepted. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

```js
const verdict = await agent('Check the release notes.', {
  label: 'release check',
  model: ['anthropic/claude-haiku-5-5', 'cursor/grok-4.7'],
})
```

Use only model ids the host lists. If no selector resolves, that agent returns `null` and the run log names the failure. Omit `model` to follow omp's `task.agentModelOverrides` routing: the entry for `agentType` (its name after the last `:` too), then the `task` entry. With no matching entry, the parent session's model is used. An explicit `model` always wins.

### Cursor backend

`opts.backend: "cursor"` runs that subagent as a local Cursor SDK agent instead of the host session. `opts.model` takes Cursor model ids such as `composer-2.5` or `grok-4.7` (the `cursor/` prefix is optional), and an array is an ordered fallback list. `opts.modelParams` is an object of string values forwarded to the Cursor model, such as `{ effort: 'high' }`; it is rejected unless `backend` is `"cursor"`. Set `CURSOR_API_KEY` for the Cursor SDK. `@cursor/sdk` loads on the first Cursor agent, so host-only runs do not pay for it. Cursor agents report through the same run store, so their rows and cards appear in `/workflows` like any other agent.

```js
const check = await agent('Describe the exports of math.js.', {
  label: 'cursor check',
  backend: 'cursor',
  model: 'grok-4.7',
  modelParams: { effort: 'high' },
})
```

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory subagent session
  → session events (tool calls, text, usage) feed the run store
  → the tool row, status line, and /workflows view render from the store
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal turn. On omp each subagent registers under its own agent id, so parallel subagents do not replace each other.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime. |
| `src/workflow-tool.ts` | The `workflow` tool: prompt guidelines, tool row rendering, status line, abort handling. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory subagent runner, and the session event mapper. |
| `src/cursor-backend.ts` | Cursor SDK backend: lazily loads `@cursor/sdk` and maps its run messages to agent events. |
| `src/run-store.ts` | In-memory run store: per-agent prompt, tool calls, output, tokens, status; stop controls. |
| `src/workflow-view.ts` | The `/workflows` drill-down view: pure renderer, key reducer, and TUI component. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `src/format.ts` | Shared duration and token formatting, and the "agent finished" rule used by every surface. |
| `extensions/workflow.ts` | The extension entrypoint for pi and omp (`workflow` tool, `/workflows`, `ctrl+alt+w`). |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Parser unit tests live in `tests/workflow-parser.test.ts` and cover both accepted and rejected script shapes.

## Status

This is a prototype. It implements the core workflow primitive (script, subagents, parallel/pipeline, phases, abort, structured output) and the `/workflows` drill-down view. It does not implement persisted or resumable runs, pause/resume, agent restart, or saving scripts as reusable workflows.

## License

MIT
