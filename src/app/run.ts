import { randomUUID } from "node:crypto";
import { loadModelsConfig } from "../core/config.js";
import { createDecisionEngine } from "../core/decision.js";
import { costEstimateBasis } from "../core/pricing.js";
import type { AgentMetrics, AgentResult, RouterKind, RunTrace, SubtaskTrace, Tier } from "../core/types.js";
import { prepareModels, runPiAgent } from "../pi/runner.js";
import { diffWorkspace, disposeSnapshot, inspectWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from "../repository/workspace.js";
import { redact, writeTrace } from "../telemetry/trace.js";
import { evaluateTask } from "./evaluation.js";
import { planTask } from "./planning.js";

export interface RunOptions {
  repo: string;
  task: string;
  router: RouterKind;
  tier?: Tier;
  config: string;
  traceDir: string;
}

export function combinedMetrics(trace: RunTrace): AgentMetrics {
  const parts = [trace.plan?.metrics, ...(trace.subtasks ?? []).map((step) => step.agent?.metrics), trace.quality?.requirementReview?.metrics ?? trace.quality?.reviewAttempt?.metrics]
    .filter((item): item is AgentMetrics => Boolean(item));
  const toolCalls = new Map<string, { count: number; errors: number }>();
  for (const part of parts) {
    for (const call of part.toolCalls) {
      const current = toolCalls.get(call.name) ?? { count: 0, errors: 0 };
      current.count += call.count;
      current.errors += call.errors;
      toolCalls.set(call.name, current);
    }
  }
  return {
    modelsUsed: [...new Set(parts.flatMap((part) => part.modelsUsed))],
    inputTokens: parts.reduce((sum, part) => sum + part.inputTokens, 0),
    outputTokens: parts.reduce((sum, part) => sum + part.outputTokens, 0),
    cacheReadTokens: parts.reduce((sum, part) => sum + part.cacheReadTokens, 0),
    cacheWriteTokens: parts.reduce((sum, part) => sum + part.cacheWriteTokens, 0),
    toolCalls: [...toolCalls].map(([name, value]) => ({ name, ...value })),
    estimatedCostUsd: parts.reduce((sum, part) => sum + part.estimatedCostUsd, 0),
  };
}

export async function run(options: RunOptions): Promise<{ tracePath: string; success: boolean }> {
  const started = Date.now();
  const trace: RunTrace = {
    id: randomUUID(), startedAt: new Date(started).toISOString(), endedAt: "", durationMs: 0,
    status: "failed", task: options.task, repoPath: options.repo, commit: null,
    router: options.router, decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
    agent: null, diff: "", error: null, plan: null, subtasks: [], quality: null,
  };
  let snapshot: WorkspaceSnapshot | undefined;
  try {
    const context = await inspectWorkspace(options.repo, options.task);
    trace.repoPath = context.repoPath;
    trace.commit = context.commit;
    const config = await loadModelsConfig(options.config);
    const prepared = await prepareModels(config);
    snapshot = await snapshotWorkspace(context.repoPath);
    trace.plan = await planTask(context, prepared, config.models.strong);
    if (trace.plan.error) console.error(`Planning fallback: ${redact(trace.plan.error)}`);
    console.log(`Plan: ${trace.plan.subtasks.length} subtask(s)`);
    const engine = createDecisionEngine(options.router, options.tier);
    for (const planned of trace.plan.subtasks) {
      const stepStarted = Date.now();
      const step: SubtaskTrace = {
        plan: planned, startedAt: new Date(stepStarted).toISOString(), endedAt: "", durationMs: 0,
        decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
        agent: null, diff: "", status: "failed", error: null,
      };
      trace.subtasks!.push(step);
      let stepSnapshot: WorkspaceSnapshot | undefined;
      try {
        const updated = await inspectWorkspace(context.repoPath, [planned.description, ...planned.acceptanceCriteria].join("\n"));
        stepSnapshot = await snapshotWorkspace(context.repoPath);
        step.decision = await engine.decide(updated);
        const selected = config.models[step.decision.tier];
        step.selectedModel = { tier: step.decision.tier, provider: selected.provider, model: selected.model };
        step.priceSnapshot = selected;
        step.costEstimateBasis = costEstimateBasis(selected.provider);
        if (trace.plan.subtasks.length === 1) {
          trace.decision = step.decision;
          trace.selectedModel = step.selectedModel;
          trace.priceSnapshot = selected;
          trace.costEstimateBasis = costEstimateBasis(selected.provider);
        }
        console.log(trace.plan.subtasks.length === 1
          ? `Route: ${step.decision.tier} (${selected.provider}/${selected.model})`
          : `Route ${planned.id}: ${step.decision.tier} (${selected.provider}/${selected.model})`);
        console.log(`Reason: ${redact(step.decision.reason)}`);
        const prompt = [
          `用户总目标：${options.task}`,
          `当前子任务（${planned.id}/${trace.plan.subtasks.length}）：${planned.description}`,
          planned.acceptanceCriteria.length ? `当前子任务验收点：\n${planned.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
          "只完成当前子任务，保留工作区中前面子任务的结果。",
        ].filter(Boolean).join("\n\n");
        step.agent = await runPiAgent(context.repoPath, prompt, prepared, step.decision.tier, selected);
        step.diff = await diffWorkspace(stepSnapshot);
        if (!step.agent.success) throw new Error(step.agent.error ?? "Pi agent failed");
        if (!step.diff.trim()) throw new Error("Pi completed without a code change");
        step.status = "success";
      } catch (error) {
        step.error = error instanceof Error ? error.message : String(error);
        if (stepSnapshot && !step.diff) {
          try { step.diff = await diffWorkspace(stepSnapshot); } catch { /* Preserve the original error. */ }
        }
      } finally {
        if (stepSnapshot) {
          try { await disposeSnapshot(stepSnapshot); }
          catch (error) {
            step.error ??= error instanceof Error ? error.message : String(error);
            step.status = "failed";
            if (step.agent) step.agent = { ...step.agent, success: false, error: step.error };
          }
        }
        step.endedAt = new Date().toISOString();
        step.durationMs = Date.now() - stepStarted;
      }
      if (step.status === "failed") {
        trace.error = `${planned.id}: ${step.error ?? "unknown error"}`;
        break;
      }
    }
    if (snapshot) {
      trace.diff = await diffWorkspace(snapshot);
    }
    trace.quality = await evaluateTask(context.repoPath, options.task, trace.diff, trace.plan.subtasks, prepared, config.models.strong);
    if (!trace.error && trace.quality.status === "failed") trace.error = "Automatic quality assessment failed";
    if (!trace.error) trace.status = "success";
  } catch (error) {
    trace.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (snapshot) {
      try { trace.diff = await diffWorkspace(snapshot); } catch (error) {
        trace.error ??= error instanceof Error ? error.message : String(error);
        trace.status = "failed";
      }
      try { await disposeSnapshot(snapshot); }
      catch (error) {
        trace.error ??= error instanceof Error ? error.message : String(error);
        trace.status = "failed";
      }
    }
  }
  const lastStep = trace.subtasks?.at(-1);
  const agent: AgentResult = {
    success: trace.status === "success", summary: lastStep?.agent?.summary ?? "",
    ...(trace.error ? { error: trace.error } : {}), metrics: combinedMetrics(trace),
  };
  trace.agent = agent;
  trace.endedAt = new Date().toISOString();
  trace.durationMs = Date.now() - started;
  const tracePath = await writeTrace(options.traceDir, trace);
  if (agent.summary) console.log(`\nPi result:\n${redact(agent.summary)}`);
  console.log(`\nChanged diff: ${trace.diff ? "yes" : "no"}`);
  console.log(`Quality: ${trace.quality?.score ?? "unverified"} (${trace.quality?.status ?? "not run"})`);
  console.log(`Estimated cost (excluding Jev): $${agent.metrics.estimatedCostUsd.toFixed(6)}`);
  if (trace.error) console.error(`Error: ${redact(trace.error)}`);
  console.log(`Trace: ${tracePath}`);
  return { tracePath, success: trace.status === "success" };
}
