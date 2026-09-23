import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentResult, ModelConfig, ModelsConfig, Tier } from "../core/types.js";
import { estimateCostUsd } from "../core/pricing.js";

export interface PreparedModels {
  runtime: ModelRuntime;
  models: Record<Tier, NonNullable<ReturnType<ModelRuntime["getModel"]>>>;
}

export async function prepareModels(config: ModelsConfig): Promise<PreparedModels> {
  const runtime = await ModelRuntime.create();
  const missing: string[] = [];
  const unavailable: string[] = [];
  const available = await runtime.getAvailable();
  for (const candidate of Object.values(config.models)) {
    const model = runtime.getModel(candidate.provider, candidate.model);
    const id = `${candidate.provider}/${candidate.model}`;
    if (!model) missing.push(id);
    else if (!available.some((item) => item.provider === model.provider && item.id === model.id)) unavailable.push(id);
  }
  if (missing.length) throw new Error(`Models not found in Pi: ${missing.join(", ")}. Check provider/model IDs or Pi models.json.`);
  if (unavailable.length) throw new Error(`Models lack usable Pi credentials: ${unavailable.join(", ")}. Configure provider keys or Pi auth.`);
  const models = {} as PreparedModels["models"];
  for (const tier of ["small", "medium", "strong"] as const) {
    const selectedConfig = config.models[tier];
    const selected = runtime.getModel(selectedConfig.provider, selectedConfig.model);
    if (!selected) throw new Error(`Model disappeared: ${selectedConfig.provider}/${selectedConfig.model}`);
    if (selected.contextWindow < selectedConfig.contextWindow) {
      throw new Error(`Configured context window exceeds Pi's model limit for ${selectedConfig.provider}/${selectedConfig.model}`);
    }
    models[tier] = selected;
  }
  return { runtime, models };
}

export async function runPiAgent(repoPath: string, task: string, prepared: PreparedModels, tier: Tier, prices: ModelConfig): Promise<AgentResult> {
  const metrics: AgentResult["metrics"] = {
    modelsUsed: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    toolCalls: [], estimatedCostUsd: 0,
  };
  const tools = new Map<string, { count: number; errors: number }>();
  const usedModels = new Set<string>();
  const { session } = await createAgentSession({
    cwd: repoPath,
    model: prepared.models[tier],
    modelRuntime: prepared.runtime,
    sessionManager: SessionManager.inMemory(repoPath),
    tools: ["read", "bash", "edit", "write"],
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      usedModels.add(`${event.message.provider}/${event.message.model}`);
      metrics.inputTokens += event.message.usage.input;
      metrics.outputTokens += event.message.usage.output;
      metrics.cacheReadTokens += event.message.usage.cacheRead;
      metrics.cacheWriteTokens += event.message.usage.cacheWrite;
    }
    if (event.type === "tool_execution_end") {
      const item = tools.get(event.toolName) ?? { count: 0, errors: 0 };
      item.count++;
      if (event.isError) item.errors++;
      tools.set(event.toolName, item);
    }
  });
  let error: string | undefined;
  try {
    await session.prompt(task);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    unsubscribe();
    metrics.toolCalls = [...tools].map(([name, value]) => ({ name, ...value }));
    metrics.modelsUsed = [...usedModels];
    metrics.estimatedCostUsd = estimateCostUsd(metrics, prices);
  }
  const summary = session.getLastAssistantText() ?? "";
  const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
  if (!error && lastAssistant?.role === "assistant" && ["error", "aborted", "length", "deferred"].includes(lastAssistant.stopReason)) {
    error = lastAssistant.errorMessage ?? `Pi stopped with ${lastAssistant.stopReason}`;
  }
  const expectedModel = `${prepared.models[tier].provider}/${prepared.models[tier].id}`;
  if (!error && metrics.modelsUsed.some((used) => used !== expectedModel)) {
    error = `Pi used a model outside the selected task tier: ${metrics.modelsUsed.join(", ")}`;
  }
  session.dispose();
  return { success: !error, summary, ...(error ? { error } : {}), metrics };
}
