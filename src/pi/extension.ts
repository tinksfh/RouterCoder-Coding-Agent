import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { combinedMetrics } from "../app/run.js";
import { evaluateTask } from "../app/evaluation.js";
import { planTask } from "../app/planning.js";
import { loadModelsConfig } from "../core/config.js";
import { createDecisionEngine } from "../core/decision.js";
import { costEstimateBasis, estimateCostUsd } from "../core/pricing.js";
import type { AgentMetrics, RouterKind, RunTrace, SubtaskTrace, Tier } from "../core/types.js";
import { TIERS } from "../core/types.js";
import { prepareModels } from "./runner.js";
import { diffWorkspace, disposeSnapshot, inspectWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from "../repository/workspace.js";
import { redact, writeTrace } from "../telemetry/trace.js";

interface ActiveStep {
  trace: SubtaskTrace;
  snapshot?: WorkspaceSnapshot;
  started: number;
  metrics: AgentMetrics;
  tools: Map<string, { count: number; errors: number }>;
  modelsUsed: Set<string>;
  summary: string;
  error?: string;
}

interface ActiveTask {
  trace: RunTrace;
  started: number;
  snapshot?: WorkspaceSnapshot;
  current?: ActiveStep;
  nextIndex: number;
  finalization?: Promise<void>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function status(ctx: ExtensionContext, value: string): void {
  if (ctx.mode === "tui") ctx.ui.setStatus("routercoder", value);
}

function emptyMetrics(): AgentMetrics {
  return {
    modelsUsed: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, toolCalls: [], estimatedCostUsd: 0,
  };
}

function newTask(task: string, repoPath: string, router: RouterKind): ActiveTask {
  const started = Date.now();
  return {
    started, nextIndex: 0,
    trace: {
      id: randomUUID(), startedAt: new Date(started).toISOString(), endedAt: "", durationMs: 0,
      status: "failed", task, repoPath, commit: null, router,
      decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
      agent: null, diff: "", error: null, plan: null, subtasks: [], quality: null,
    },
  };
}

function stepPrompt(task: ActiveTask, index: number): string {
  const plan = task.trace.plan;
  if (!plan) throw new Error("Task plan missing");
  const step = plan.subtasks[index];
  return [
    `用户总目标：${task.trace.task}`,
    `当前子任务（${step.id}/${plan.subtasks.length}）：${step.description}`,
    step.acceptanceCriteria.length ? `当前子任务验收点：\n${step.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
    "只完成当前子任务，保留工作区中前面子任务的结果。",
  ].filter(Boolean).join("\n\n");
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
  const config = await loadModelsConfig(configPath);
  const prepared = await prepareModels(config);
  const engine = createDecisionEngine(router, tier);
  let active: ActiveTask | undefined;

  async function finishStep(task: ActiveTask, failure?: string): Promise<boolean> {
    const step = task.current;
    if (!step) return false;
    task.current = undefined;
    const trace = step.trace;
    if (step.snapshot) {
      try { trace.diff = await diffWorkspace(step.snapshot); }
      catch (cause) { failure ??= `Could not capture subtask diff: ${errorMessage(cause)}`; }
      finally {
        try { await disposeSnapshot(step.snapshot); }
        catch (cause) { failure ??= `Could not release subtask snapshot: ${errorMessage(cause)}`; }
      }
    }
    step.metrics.toolCalls = [...step.tools].map(([name, counts]) => ({ name, ...counts }));
    step.metrics.modelsUsed = [...step.modelsUsed];
    const selected = trace.selectedModel;
    if (selected) {
      step.metrics.estimatedCostUsd = estimateCostUsd(step.metrics, trace.priceSnapshot ?? config.models[selected.tier]);
      if (step.metrics.modelsUsed.some((model) => model !== `${selected.provider}/${selected.model}`)) {
        failure ??= `Pi used a model outside the selected subtask tier: ${step.metrics.modelsUsed.join(", ")}`;
      }
    }
    failure ??= step.error;
    if (!failure && !trace.diff.trim()) failure = "Pi completed without a code change";
    trace.agent = {
      success: !failure, summary: step.summary,
      ...(failure ? { error: failure } : {}), metrics: step.metrics,
    };
    trace.status = failure ? "failed" : "success";
    trace.error = failure ?? null;
    trace.endedAt = new Date().toISOString();
    trace.durationMs = Date.now() - step.started;
    if (failure) task.trace.error = `${trace.plan.id}: ${failure}`;
    return !failure;
  }

  function finishTask(task: ActiveTask, ctx: ExtensionContext): Promise<void> {
    task.finalization ??= completeTask(task, ctx);
    return task.finalization;
  }

  async function completeTask(task: ActiveTask, ctx: ExtensionContext): Promise<void> {
    const trace = task.trace;
    if (task.snapshot) {
      try { trace.diff = await diffWorkspace(task.snapshot); }
      catch (cause) { trace.error ??= `Could not capture task diff: ${errorMessage(cause)}`; }
    }
    if (trace.plan) {
      try {
        trace.quality = await evaluateTask(trace.repoPath, trace.task, trace.diff, trace.plan.subtasks, prepared, config.models.strong);
      } catch (cause) { trace.error ??= `Automatic quality assessment failed to run: ${errorMessage(cause)}`; }
    }
    if (!trace.error && trace.quality?.status === "failed") trace.error = "Automatic quality assessment failed";
    if (task.snapshot) {
      try { trace.diff = await diffWorkspace(task.snapshot); }
      catch (cause) { trace.error ??= `Could not capture final task diff: ${errorMessage(cause)}`; }
      finally {
        try { await disposeSnapshot(task.snapshot); }
        catch (cause) { trace.error ??= `Could not release task snapshot: ${errorMessage(cause)}`; }
      }
    }
    trace.status = trace.error ? "failed" : "success";
    trace.agent = {
      success: trace.status === "success",
      summary: trace.subtasks?.at(-1)?.agent?.summary ?? "",
      ...(trace.error ? { error: trace.error } : {}),
      metrics: combinedMetrics(trace),
    };
    trace.endedAt = new Date().toISOString();
    trace.durationMs = Date.now() - task.started;
    try {
      const path = await writeTrace(traceDir!, trace);
      ctx.ui.notify(`RouterCoder ${trace.status}; quality ${trace.quality?.score ?? "unverified"}; trace: ${path}`, trace.status === "success" ? "info" : "warning");
      status(ctx, `RouterCoder: ready (last ${trace.status})`);
    } catch (cause) {
      ctx.ui.notify(`RouterCoder could not write trace: ${redact(errorMessage(cause))}`, "error");
      status(ctx, "RouterCoder: trace error");
    }
    if (active === task) active = undefined;
  }

  async function beginStep(task: ActiveTask, ctx: ExtensionContext): Promise<string> {
    const plan = task.trace.plan;
    if (!plan) throw new Error("Task plan missing");
    const planned = plan.subtasks[task.nextIndex];
    if (!planned) throw new Error("Subtask index out of range");
    const started = Date.now();
    const stepTrace: SubtaskTrace = {
      plan: planned, startedAt: new Date(started).toISOString(), endedAt: "", durationMs: 0,
      decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
      agent: null, diff: "", status: "failed", error: null,
    };
    task.trace.subtasks!.push(stepTrace);
    const step: ActiveStep = {
      trace: stepTrace, started, metrics: emptyMetrics(), tools: new Map(), modelsUsed: new Set(), summary: "",
    };
    task.current = step;
    status(ctx, `RouterCoder: routing ${task.nextIndex + 1}/${plan.subtasks.length}`);
    const context = await inspectWorkspace(task.trace.repoPath, [planned.description, ...planned.acceptanceCriteria].join("\n"));
    step.snapshot = await snapshotWorkspace(context.repoPath);
    stepTrace.decision = await engine.decide(context);
    const selected = config.models[stepTrace.decision.tier];
    stepTrace.selectedModel = { tier: stepTrace.decision.tier, provider: selected.provider, model: selected.model };
    stepTrace.priceSnapshot = selected;
    stepTrace.costEstimateBasis = costEstimateBasis(selected.provider);
    if (plan.subtasks.length === 1) {
      task.trace.decision = stepTrace.decision;
      task.trace.selectedModel = stepTrace.selectedModel;
      task.trace.priceSnapshot = selected;
      task.trace.costEstimateBasis = costEstimateBasis(selected.provider);
    }
    const model = ctx.modelRegistry.find(selected.provider, selected.model);
    if (!model || !await pi.setModel(model)) throw new Error(`Pi model unavailable: ${selected.provider}/${selected.model}`);
    status(ctx, `RouterCoder: ${task.nextIndex + 1}/${plan.subtasks.length} ${stepTrace.decision.tier.toUpperCase()} locked`);
    ctx.ui.notify(`RouterCoder ${planned.id}: ${stepTrace.decision.tier.toUpperCase()} (${selected.provider}/${selected.model}); ${redact(stepTrace.decision.reason)}`);
    return stepPrompt(task, task.nextIndex);
  }

  async function beginTask(prompt: string, ctx: ExtensionContext): Promise<string | null> {
    const task = newTask(prompt, ctx.cwd, router!);
    active = task;
    status(ctx, "RouterCoder: planning...");
    try {
      const context = await inspectWorkspace(ctx.cwd, prompt);
      task.trace.repoPath = context.repoPath;
      task.trace.commit = context.commit;
      task.snapshot = await snapshotWorkspace(context.repoPath);
      task.trace.plan = await planTask(context, prepared, config.models.strong);
      if (task.trace.plan.error) ctx.ui.notify(`RouterCoder planning fallback: ${redact(task.trace.plan.error)}`, "warning");
      ctx.ui.notify(`RouterCoder plan: ${task.trace.plan.subtasks.length} subtask(s)`);
      return await beginStep(task, ctx);
    } catch (cause) {
      if (task.current) await finishStep(task, errorMessage(cause));
      task.trace.error ??= errorMessage(cause);
      await finishTask(task, ctx);
      return null;
    }
  }

  pi.on("session_start", (_event, ctx) => status(ctx, "RouterCoder: ready"));

  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior) return { action: "continue" };
    const prefix = active ? `ROUTERCODER_STEP:${active.trace.id}:` : "";
    if (event.source === "extension" && event.text.startsWith("ROUTERCODER_STEP:")) {
      if (!prefix || event.text !== `${prefix}${active!.nextIndex}`) return { action: "handled" };
      try {
        const prompt = await beginStep(active!, ctx);
        return { action: "transform", text: prompt, images: event.images };
      } catch (cause) {
        const task = active!;
        if (task.current) await finishStep(task, errorMessage(cause));
        task.trace.error ??= errorMessage(cause);
        await finishTask(task, ctx);
        return { action: "handled" };
      }
    }
    if (event.source === "extension") return { action: "continue" };
    if (active) {
      const previous = active;
      if (previous.finalization) await previous.finalization;
      else {
        if (previous.current) await finishStep(previous, "New user task interrupted the previous task");
        previous.trace.error ??= "New user task interrupted the previous task";
        await finishTask(previous, ctx);
      }
    }
    const prompt = await beginTask(event.text, ctx);
    return prompt ? { action: "transform", text: prompt, images: event.images } : { action: "handled" };
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = active?.current?.trace.selectedModel;
    if (!selected || (event.model.provider === selected.provider && event.model.id === selected.model)) return;
    const locked = ctx.modelRegistry.find(selected.provider, selected.model);
    if (!locked || !await pi.setModel(locked)) {
      if (active?.current) active.current.error = "Could not restore the subtask's selected model";
      ctx.abort();
      return;
    }
    ctx.ui.notify(`RouterCoder kept ${selected.tier.toUpperCase()} for this subtask`, "warning");
  });

  pi.on("message_end", (event) => {
    const step = active?.current;
    if (!step || event.message.role !== "assistant") return;
    const message = event.message;
    step.modelsUsed.add(`${message.provider}/${message.model}`);
    step.metrics.inputTokens += message.usage.input;
    step.metrics.outputTokens += message.usage.output;
    step.metrics.cacheReadTokens += message.usage.cacheRead;
    step.metrics.cacheWriteTokens += message.usage.cacheWrite;
    const value = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (value) step.summary = value;
    if (["error", "aborted", "length", "deferred"].includes(message.stopReason)) {
      step.error = message.errorMessage ?? `Pi stopped with ${message.stopReason}`;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    const step = active?.current;
    if (!step || !event.compactionEntry.usage) return;
    const usage = event.compactionEntry.usage;
    step.metrics.inputTokens += usage.input;
    step.metrics.outputTokens += usage.output;
    step.metrics.cacheReadTokens += usage.cacheRead;
    step.metrics.cacheWriteTokens += usage.cacheWrite;
    if (ctx.model) step.modelsUsed.add(`${ctx.model.provider}/${ctx.model.id}`);
  });

  pi.on("tool_execution_end", (event) => {
    const step = active?.current;
    if (!step) return;
    const counts = step.tools.get(event.toolName) ?? { count: 0, errors: 0 };
    counts.count++;
    if (event.isError) counts.errors++;
    step.tools.set(event.toolName, counts);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const task = active;
    if (!task?.current) return;
    if (!await finishStep(task)) {
      await finishTask(task, ctx);
      return;
    }
    task.nextIndex++;
    const plan = task.trace.plan;
    if (plan && task.nextIndex < plan.subtasks.length) {
      status(ctx, `RouterCoder: preparing ${task.nextIndex + 1}/${plan.subtasks.length}`);
      pi.sendUserMessage(`ROUTERCODER_STEP:${task.trace.id}:${task.nextIndex}`);
      return;
    }
    await finishTask(task, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const task = active;
    if (!task) return;
    if (task.finalization) {
      await task.finalization;
      return;
    }
    if (task.current) await finishStep(task, "Pi session closed before subtask settled");
    task.trace.error ??= "Pi session closed before task settled";
    await finishTask(task, ctx);
  });
}
