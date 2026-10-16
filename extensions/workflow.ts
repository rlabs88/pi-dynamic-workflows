import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, installWorkflowFooter, openWorkflowsView, workflowRuns } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool();
  pi.registerTool(workflowTool);

  let disposeFooter: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    const ui = ctx.ui;
    if (ctx.hasUI === false || !ui) return;
    disposeFooter?.();
    disposeFooter = installWorkflowFooter(ui, workflowRuns, (runId) => openWorkflowsView(ui, workflowRuns, runId));
  });

  // Register /workflows command
  pi.registerCommand("workflows", {
    description: "Browse running and completed workflows",
    handler: async (_args, ctx) => {
      if (ctx.hasUI === false || !ctx.ui) return;
      openWorkflowsView(ctx.ui, workflowRuns);
    },
  });

  // Register keyboard shortcut ctrl+alt+w (free on both pi and omp keybinding tables)
  pi.registerShortcut("ctrl+alt+w", {
    description: "Open workflows view",
    handler: async (ctx) => {
      if (ctx.hasUI === false || !ctx.ui) return;
      openWorkflowsView(ctx.ui, workflowRuns);
    },
  });
}
