/** Thinking levels the shared pi session type accepts. omp's `max` is not selectable: the type has no such member. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * True when running inside omp. omp runs on Bun, pi on Node. This is the only host check in the package.
 */
export function isOmpHost(): boolean {
  return typeof process.versions.bun === "string";
}

/** The slice of a host model registry that selection needs. */
export interface ModelLookup<M> {
  find(provider: string, modelId: string): M | undefined;
  hasConfiguredAuth(model: M): boolean;
}

export interface ResolvedAgentModel<M> {
  model: M;
  /** The selector string that matched, exactly as written by the script. */
  selector: string;
  thinkingLevel?: ThinkingLevel;
}

interface ParsedSelector {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Parses `provider/modelId[:thinking]`. The provider ends at the first `/`; the model id keeps any further `/` or `:`.
 * Only a trailing `:level` naming a thinking level is stripped, so `provider/id:free` keeps its suffix.
 */
export function parseModelSelector(selector: string): ParsedSelector | undefined {
  const slash = selector.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = selector.slice(0, slash);
  let modelId = selector.slice(slash + 1);
  let thinkingLevel: ThinkingLevel | undefined;
  const colon = modelId.lastIndexOf(":");
  if (colon >= 0) {
    const suffix = modelId.slice(colon + 1);
    if (isThinkingLevel(suffix)) {
      thinkingLevel = suffix;
      modelId = modelId.slice(0, colon);
    }
  }
  if (modelId.length === 0) return undefined;
  return { provider, modelId, thinkingLevel };
}

/** Returns the first selector that names a model with configured credentials. Throws when none does. */
export function resolveAgentModel<M>(
  selectors: string | readonly string[],
  registry: ModelLookup<M>,
): ResolvedAgentModel<M> {
  const list = typeof selectors === "string" ? [selectors] : selectors;
  if (list.length === 0) throw new Error("No usable model: no selectors given");
  const failures: string[] = [];
  for (const selector of list) {
    const parsed = parseModelSelector(selector);
    if (parsed === undefined) {
      failures.push(`${selector} (invalid selector)`);
      continue;
    }
    const model = registry.find(parsed.provider, parsed.modelId);
    if (model === undefined) {
      failures.push(`${selector} (unknown model)`);
      continue;
    }
    if (!registry.hasConfiguredAuth(model)) {
      failures.push(`${selector} (no credentials)`);
      continue;
    }
    return { model, selector, thinkingLevel: parsed.thinkingLevel };
  }
  throw new Error(`No usable model: ${failures.join(", ")}`);
}

/** Reads `task.agentModelOverrides` from raw settings (unvalidated JSON). Project entries win over global ones. */
export function readTaskModelOverrides(settings: {
  getGlobalSettings(): unknown;
  getProjectSettings(): unknown;
}): Record<string, string> {
  return { ...overridesIn(settings.getGlobalSettings()), ...overridesIn(settings.getProjectSettings()) };
}

function overridesIn(settings: unknown): Record<string, string> {
  if (!isPlainRecord(settings) || !isPlainRecord(settings.task)) return {};
  const raw = settings.task.agentModelOverrides;
  if (!isPlainRecord(raw)) return {};
  const overrides: Record<string, string> = {};
  for (const [agent, selector] of Object.entries(raw)) {
    if (typeof selector === "string" && selector.trim() !== "") overrides[agent] = selector.trim();
  }
  return overrides;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The selector omp's task router uses for a subagent: `agentType`, then its name after the last `:` (plugin-namespaced
 * types such as `quant:quant-analyst`), then the `task` entry. Undefined when no entry matches.
 */
export function routedModelSelector(overrides: Record<string, string>, agentType?: string): string | undefined {
  const names = agentType ? [agentType, agentType.split(":").pop() ?? ""] : [];
  names.push("task");
  for (const name of names) {
    if (name !== "" && Object.hasOwn(overrides, name)) return overrides[name];
  }
  return undefined;
}
