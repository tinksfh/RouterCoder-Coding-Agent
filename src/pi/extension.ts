import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadModelsConfig } from "../core/config.js";
import { createDecisionEngine } from "../core/decision.js";
import { diffSnapshots, inspectRepository, snapshotWorkingTree } from "../repository/git.js";
import { costEstimateBasis, estimateCostUsd } from "../core/pricing.js";
import { redact, writeTrace } from "../telemetry/trace.js";
import { TIERS, type AgentMetrics, type RouterKind, type RunTrace, type Tier } from "../core/types.js";

interface ActiveRun {
  trace: RunTrace;
  started: number;
  beforeTree?: string;
  metrics: AgentMetrics;
  tools: Map<string, { count: number; errors: number }>;
  modelsUsed: Set<string>;
  summary: string;
  error?: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function status(ctx: ExtensionContext, text: string): void {
  if (ctx.mode === "tui") ctx.ui.setStatus("routercoder", text);
}

function newRun(task: string, repoPath: string, router: RouterKind): ActiveRun {
  const started = Date.now();
  return {
    started,
    trace: {
      id: randomUUID(), startedAt: new Date(started).toISOString(), endedAt: "", durationMs: 0,
      status: "failed", task, repoPath, commit: null, router,
      decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
      agent: null, diff: "", error: null,
    },
    metrics: {
      modelsUsed: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, toolCalls: [], estimatedCostUsd: 0,
    },
    tools: new Map(), modelsUsed: new Set(), summary: "",
  };
}

export default async function routerCoderExtension(pi: ExtensionAPI): Promise<void> {
  const configPath = process.env.ROUTERCODER_CONFIG;
  const traceDir = process.env.ROUTERCODER_TRACE_DIR;
  const router = process.env.ROUTERCODER_ROUTER as RouterKind | undefined;
  const tier = process.env.ROUTERCODER_TIER as Tier | undefined;
  if (!configPath || !traceDir || !router || !["jev", "rule", "fixed"].includes(router)) {
    throw new Error("RouterCoder extension requires launcher configuration");
  }
  if (router === "fixed" && (!tier || !TIERS.includes(tier))) {
    throw new Error("RouterCoder fixed routing requires a valid tier");
  }
  const selectedRouter = router;
  const outputDirectory = traceDir;
  const config = await loadModelsConfig(configPath);
  const engine = createDecisionEngine(router, tier);
  let active: ActiveRun | undefined;

  async function finish(run: ActiveRun, ctx: ExtensionContext, failure?: string): Promise<void> {
    const trace = run.trace;
    if (run.beforeTree) {
      try {
        trace.diff = await diffSnapshots(trace.repoPath, run.beforeTree, await snapshotWorkingTree(trace.repoPath));
      } catch (cause) {
        failure ??= `Could not capture task diff: ${errorMessage(cause)}`;
      }
    }
    run.metrics.toolCalls = [...run.tools].map(([name, counts]) => ({ name, ...counts }));
    run.metrics.modelsUsed = [...run.modelsUsed];
    const prices = trace.priceSnapshot;
    if (prices) {
      run.metrics.estimatedCostUsd = estimateCostUsd(run.metrics, prices);
    }
    const selected = trace.selectedModel;
    if (selected && run.metrics.modelsUsed.some((model) => model !== `${selected.provider}/${selected.model}`)) {
      failure ??= `Pi used a model outside the selected task tier: ${run.metrics.modelsUsed.join(", ")}`;
    }
    failure ??= run.error;
    if (!failure && !trace.diff.trim()) failure = "Pi completed without a code change";
    trace.agent = {
      success: !failure, summary: run.summary,
      ...(failure ? { error: failure } : {}), metrics: run.metrics,
    };
    trace.error = failure ?? null;
    trace.status = failure ? "failed" : "success";
    trace.endedAt = new Date().toISOString();
    trace.durationMs = Date.now() - run.started;
    try {
      const path = await writeTrace(outputDirectory, trace);
      ctx.ui.notify(`RouterCoder ${trace.status}; trace: ${path}`, failure ? "warning" : "info");
      status(ctx, `RouterCoder: ready (last ${selected?.tier ?? "failed"})`);
    } catch (cause) {
      ctx.ui.notify(`RouterCoder could not write trace: ${redact(errorMessage(cause))}`, "error");
      status(ctx, "RouterCoder: trace error");
    }
  }

  pi.on("session_start", (_event, ctx) => status(ctx, "RouterCoder: ready"));

  async function beginTask(prompt: string, ctx: ExtensionContext): Promise<boolean> {
    const run = newRun(prompt, ctx.cwd, selectedRouter);
    active = run;
    status(ctx, "RouterCoder: routing...");
    try {
      const context = await inspectRepository(ctx.cwd, prompt, true);
      run.trace.repoPath = context.repoPath;
      run.trace.commit = context.commit;
      run.beforeTree = await snapshotWorkingTree(context.repoPath);
      const decision = await engine.decide(context);
      run.trace.decision = decision;
      const selected = config.models[decision.tier];
      run.trace.selectedModel = { tier: decision.tier, provider: selected.provider, model: selected.model };
      run.trace.priceSnapshot = selected;
      run.trace.costEstimateBasis = costEstimateBasis(selected.provider);
      const model = ctx.modelRegistry.find(selected.provider, selected.model);
      if (!model) throw new Error(`Pi model unavailable: ${selected.provider}/${selected.model}`);
      if (!await pi.setModel(model)) throw new Error(`Pi credentials unavailable: ${selected.provider}/${selected.model}`);
      status(ctx, `RouterCoder: ${decision.tier.toUpperCase()} locked`);
      ctx.ui.notify(`RouterCoder: ${decision.tier.toUpperCase()} (${selected.provider}/${selected.model}); ${redact(decision.reason)}`);
      return true;
    } catch (cause) {
      const message = errorMessage(cause);
      await finish(run, ctx, message);
      active = undefined;
      ctx.ui.notify(`RouterCoder cannot start task: ${redact(message)}`, "error");
      return false;
    }
  }

  pi.on("input", async (event, ctx) => {
    // Steering and queued follow-ups belong to the current Pi run and keep its model.
    if (event.streamingBehavior) return { action: "continue" };
    if (active) {
      await finish(active, ctx, "A new task started before the previous one settled");
      active = undefined;
    }
    const started = await beginTask(event.text, ctx);
    return started ? { action: "continue" } : { action: "handled" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Extension-triggered prompts can bypass the interactive input event.
    if (active) return;
    if (!await beginTask(event.prompt, ctx)) {
      ctx.abort();
      ctx.shutdown();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = active?.trace.selectedModel;
    if (!selected || (event.model.provider === selected.provider && event.model.id === selected.model)) return;
    const locked = ctx.modelRegistry.find(selected.provider, selected.model);
    if (!locked || !await pi.setModel(locked)) {
      if (active) active.error = "Could not restore the task's selected model";
      ctx.abort();
      return;
    }
    ctx.ui.notify(`RouterCoder kept ${selected.tier.toUpperCase()} for this task`, "warning");
  });

  pi.on("message_end", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const message = event.message;
    active.modelsUsed.add(`${message.provider}/${message.model}`);
    active.metrics.inputTokens += message.usage.input;
    active.metrics.outputTokens += message.usage.output;
    active.metrics.cacheReadTokens += message.usage.cacheRead;
    active.metrics.cacheWriteTokens += message.usage.cacheWrite;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text) active.summary = text;
    if (["error", "aborted", "length", "deferred"].includes(message.stopReason)) {
      active.error = message.errorMessage ?? `Pi stopped with ${message.stopReason}`;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    if (!active || !event.compactionEntry.usage) return;
    const usage = event.compactionEntry.usage;
    active.metrics.inputTokens += usage.input;
    active.metrics.outputTokens += usage.output;
    active.metrics.cacheReadTokens += usage.cacheRead;
    active.metrics.cacheWriteTokens += usage.cacheWrite;
    if (ctx.model) active.modelsUsed.add(`${ctx.model.provider}/${ctx.model.id}`);
  });

  pi.on("tool_execution_end", (event) => {
    if (!active) return;
    const counts = active.tools.get(event.toolName) ?? { count: 0, errors: 0 };
    counts.count++;
    if (event.isError) counts.errors++;
    active.tools.set(event.toolName, counts);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return;
    const run = active;
    active = undefined;
    await finish(run, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!active) return;
    const run = active;
    active = undefined;
    await finish(run, ctx, "Pi session closed before task settled");
  });
}
