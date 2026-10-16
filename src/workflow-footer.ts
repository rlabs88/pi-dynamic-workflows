import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, truncateToWidth } from "@earendil-works/pi-tui";
import type { RunRecord, WorkflowRunSource } from "./run-store.js";
import { formatRunStatusLine } from "./workflow-tool.js";
import { type NormalisedKey, normalizeKey, themeStyle, type WorkflowViewStyle } from "./workflow-view.js";

const WIDGET_KEY = "workflow-footer";
const HINT = "  ↑/↓ select · enter view · x stop";
const TICK_MS = 1000;

export type FooterUI = Pick<ExtensionUIContext, "setWidget" | "onTerminalInput">;

export type FooterEffect =
  | { type: "pass" }
  | { type: "consume" }
  | { type: "open"; runId: string }
  | { type: "stop"; runId: string };

export interface FooterKeyResult {
  /** Highlighted row index, or `undefined` when the prompt owns the keyboard. */
  selected: number | undefined;
  effect: FooterEffect;
}

const PASS: FooterEffect = { type: "pass" };
const CONSUME: FooterEffect = { type: "consume" };

/**
 * Pure key reducer for the footer. Callers guarantee the prompt is idle
 * (focused, empty, no autocomplete) before entering the footer.
 */
export function reduceFooterKey(
  selected: number | undefined,
  rowIds: readonly string[],
  key: NormalisedKey,
): FooterKeyResult {
  if (rowIds.length === 0) return { selected: undefined, effect: PASS };
  if (selected === undefined) {
    return key === "down" ? { selected: 0, effect: CONSUME } : { selected: undefined, effect: PASS };
  }
  const index = Math.min(selected, rowIds.length - 1);
  const runId = rowIds[index];
  switch (key) {
    case "up":
      return index === 0 ? { selected: undefined, effect: CONSUME } : { selected: index - 1, effect: CONSUME };
    case "down":
      return { selected: Math.min(index + 1, rowIds.length - 1), effect: CONSUME };
    case "enter":
      return runId === undefined
        ? { selected: undefined, effect: PASS }
        : { selected: undefined, effect: { type: "open", runId } };
    case "x":
      return runId === undefined
        ? { selected: index, effect: PASS }
        : { selected: index, effect: { type: "stop", runId } };
    case "escape":
      return { selected: undefined, effect: CONSUME };
    default:
      return { selected: undefined, effect: PASS };
  }
}

/** Renders one line per running run, plus the hint row while a row is selected. */
export function renderFooterLines(
  runs: readonly RunRecord[],
  selected: number | undefined,
  now: number,
  width: number,
  style: WorkflowViewStyle,
): string[] {
  const lines = runs.map((run, i) => {
    const isSelected = i === selected;
    const gutter = isSelected ? style.selected("❯ ") : "  ";
    const text = formatRunStatusLine(run, now);
    const body = selected === undefined || isSelected ? text : style.dim(text);
    return truncateToWidth(`${gutter}${body}`, width);
  });
  if (selected !== undefined) lines.push(truncateToWidth(style.dim(HINT), width));
  return lines;
}

interface FocusHost {
  getFocused(): unknown;
}

function isFocusHost(value: unknown): value is FocusHost {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "getFocused") === "function";
}

interface PromptLike {
  getText(): unknown;
  isAutocompleteActive?(): unknown;
  isShowingAutocomplete?(): unknown;
}

function isPromptLike(value: unknown): value is PromptLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "getText") === "function";
}

function autocompleteOpen(prompt: PromptLike): boolean {
  if (typeof prompt.isAutocompleteActive === "function") return prompt.isAutocompleteActive() === true;
  if (typeof prompt.isShowingAutocomplete === "function") return prompt.isShowingAutocomplete() === true;
  return false;
}

/** True when the focused component is the prompt editor, empty, with no autocomplete open. */
function promptIdle(tui: unknown): boolean {
  if (!isFocusHost(tui)) return false;
  const focused = tui.getFocused();
  if (!isPromptLike(focused)) return false;
  if (focused.getText() !== "") return false;
  return !autocompleteOpen(focused);
}

interface RenderTUI {
  requestRender(): void;
}

/**
 * Shows one footer row per running run below the prompt and lets ↓ browse them.
 * Returns a disposer that removes the widget and every subscription.
 */
export function installWorkflowFooter(
  ui: FooterUI,
  source: WorkflowRunSource,
  open: (runId: string) => void,
): () => void {
  let disposed = false;
  let shown = false;
  let selected: number | undefined;
  let tui: RenderTUI | undefined;
  let theme: unknown;
  let tick: NodeJS.Timeout | undefined;

  const runningRuns = (): RunRecord[] => source.list().filter((run) => run.status === "running");

  function requestRender(): void {
    tui?.requestRender();
  }

  function startTick(): void {
    if (tick) return;
    tick = setInterval(requestRender, TICK_MS);
    // A redraw timer must not keep the host process alive after the runs are gone.
    tick.unref();
  }

  function stopTick(): void {
    if (!tick) return;
    clearInterval(tick);
    tick = undefined;
  }

  const component = {
    render(width: number): string[] {
      return renderFooterLines(runningRuns(), selected, Date.now(), width, themeStyle(theme));
    },
    invalidate(): void {},
    dispose(): void {},
  };

  function factory(host: RenderTUI, hostTheme: unknown) {
    tui = host;
    theme = hostTheme;
    return component;
  }

  function sync(): void {
    if (disposed) return;
    const rows = runningRuns();
    if (rows.length === 0) {
      selected = undefined;
      stopTick();
      if (shown) {
        shown = false;
        ui.setWidget(WIDGET_KEY, undefined);
      }
      return;
    }
    if (selected !== undefined) selected = Math.min(selected, rows.length - 1);
    if (!shown) {
      shown = true;
      ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" });
      startTick();
    }
    requestRender();
  }

  const unsubscribeStore = source.subscribe(sync);
  const unsubscribeInput = ui.onTerminalInput((data) => {
    // Kitty terminals report key releases; the press already did the work.
    if (disposed || isKeyRelease(data)) return undefined;
    const rows = runningRuns();
    if (rows.length === 0 || !promptIdle(tui)) {
      if (selected !== undefined) {
        selected = undefined;
        requestRender();
      }
      return undefined;
    }
    const previous = selected;
    const result = reduceFooterKey(
      selected,
      rows.map((run) => run.id),
      normalizeKey(data),
    );
    selected = result.selected;
    if (selected !== previous) requestRender();
    switch (result.effect.type) {
      case "pass":
        return undefined;
      case "consume":
        return { consume: true };
      case "open":
        open(result.effect.runId);
        return { consume: true };
      case "stop":
        source.stopRun(result.effect.runId);
        return { consume: true };
    }
  });

  sync();

  return () => {
    disposed = true;
    unsubscribeInput();
    unsubscribeStore();
    stopTick();
    if (shown) {
      shown = false;
      ui.setWidget(WIDGET_KEY, undefined);
    }
  };
}
