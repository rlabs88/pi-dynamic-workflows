import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowTool,
  endWorkflowSession,
  installWorkflowFooter,
  isOmpHost,
  type NotificationDelivery,
  openWorkflowsView,
  renderWorkflowNotification,
  WORKFLOW_NOTIFICATION_TYPE,
  type WorkflowNotificationDetails,
  type WorkflowNotificationMessage,
  type WorkflowNotifier,
  workflowRuns,
} from "../src/index.js";

// pi's typings omit omp's "aside" delivery; this is the only place that widens it.
type SendOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };

// omp fires `session_switch`, which pi's typings omit.
interface OmpSessionEvents {
  on(event: "session_switch", handler: () => void): void;
}

export default function extension(pi: ExtensionAPI) {
  const notifier: WorkflowNotifier = {
    notify(message: WorkflowNotificationMessage, delivery: NotificationDelivery) {
      pi.sendMessage(message, delivery as unknown as SendOptions);
    },
  };
  const workflowTool = createWorkflowTool({ notifier });
  pi.registerTool(workflowTool);

  pi.registerMessageRenderer<WorkflowNotificationDetails>(WORKFLOW_NOTIFICATION_TYPE, (message, { expanded }, theme) =>
    renderWorkflowNotification(message.details, expanded, theme),
  );

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

  // Background runs belong to the session that launched them; tear them down with it.
  pi.on("session_shutdown", () => endWorkflowSession());
  if (isOmpHost()) {
    (pi as unknown as OmpSessionEvents).on("session_switch", () => endWorkflowSession());
  }

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
