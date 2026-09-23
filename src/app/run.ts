import { randomUUID } from "node:crypto";
import { loadModelsConfig } from "../core/config.js";
import { createDecisionEngine } from "../core/decision.js";
import { costEstimateBasis } from "../core/pricing.js";
import type { RouterKind, RunTrace, Tier } from "../core/types.js";
import { prepareModels, runPiAgent } from "../pi/runner.js";
import { collectDiff, inspectRepository } from "../repository/git.js";
import { redact, writeTrace } from "../telemetry/trace.js";

export interface RunOptions {
  repo: string;
  task: string;
  router: RouterKind;
  tier?: Tier;
  config: string;
  traceDir: string;
}

export async function run(options: RunOptions): Promise<{ tracePath: string; success: boolean }> {
  const started = Date.now();
  const trace: RunTrace = {
    id: randomUUID(), startedAt: new Date(started).toISOString(), endedAt: "", durationMs: 0,
    status: "failed", task: options.task, repoPath: options.repo, commit: null,
    router: options.router, decision: null, selectedModel: null, priceSnapshot: null, costEstimateBasis: null,
    agent: null, diff: "", error: null,
  };
  let inspected = false;
  try {
    const context = await inspectRepository(options.repo, options.task);
    inspected = true;
    trace.repoPath = context.repoPath;
    trace.commit = context.commit;
    const config = await loadModelsConfig(options.config);
    const prepared = await prepareModels(config);
    const decision = await createDecisionEngine(options.router, options.tier).decide(context);
    trace.decision = decision;
    const selected = config.models[decision.tier];
    trace.selectedModel = { tier: decision.tier, provider: selected.provider, model: selected.model };
    trace.priceSnapshot = selected;
    trace.costEstimateBasis = costEstimateBasis(selected.provider);
    console.log(`Route: ${decision.tier} (${selected.provider}/${selected.model})`);
    console.log(`Reason: ${redact(decision.reason)}`);
    console.log("Pi is working in the target repository...");
    trace.agent = await runPiAgent(context.repoPath, options.task, prepared, decision.tier, selected);
    trace.diff = await collectDiff(context.repoPath);
    if (!trace.agent.success) throw new Error(trace.agent.error ?? "Pi agent failed");
    if (!trace.diff.trim()) throw new Error("Pi completed without a code change");
    trace.status = "success";
  } catch (error) {
    trace.error = error instanceof Error ? error.message : String(error);
    if (inspected && !trace.diff) {
      try { trace.diff = await collectDiff(trace.repoPath); } catch { /* Preserve the original failure. */ }
    }
  }
  trace.endedAt = new Date().toISOString();
  trace.durationMs = Date.now() - started;
  const tracePath = await writeTrace(options.traceDir, trace);
  if (trace.agent?.summary) console.log(`\nPi result:\n${redact(trace.agent.summary)}`);
  console.log(`\nChanged diff: ${trace.diff ? "yes" : "no"}`);
  if (trace.error) console.error(`Error: ${redact(trace.error)}`);
  console.log(`Trace: ${tracePath}`);
  return { tracePath, success: trace.status === "success" };
}
