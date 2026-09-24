import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateCostUsd } from "../core/pricing.js";
import type { AgentMetrics, PlannedSubtask, TaskContext, TaskPlan } from "../core/types.js";
import type { PreparedModels } from "../pi/runner.js";
import type { ModelConfig } from "../core/types.js";

function emptyMetrics(): AgentMetrics {
  return {
    modelsUsed: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, toolCalls: [], estimatedCostUsd: 0,
  };
}

function singleTask(context: TaskContext, model: string, metrics: AgentMetrics, error?: string): TaskPlan {
  return {
    source: error ? "fallback" : "direct", plannerModel: model,
    subtasks: [{ id: "step-1", description: context.task, acceptanceCriteria: [] }],
    metrics, ...(error ? { error } : {}),
  };
}

function parsePlan(text: string): PlannedSubtask[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const source = fenced ?? (first >= 0 && last > first ? text.slice(first, last + 1) : text);
  const parsed: unknown = JSON.parse(source.trim());
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { subtasks?: unknown }).subtasks)) {
    throw new Error("Planner returned no subtasks array");
  }
  const tasks = (parsed as { subtasks: unknown[] }).subtasks;
  if (tasks.length < 1 || tasks.length > 6) throw new Error("Planner must return 1–6 subtasks");
  return tasks.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("Planner returned an invalid subtask");
    const raw = item as Record<string, unknown>;
    const description = raw.description;
    const criteria = raw.acceptanceCriteria;
    if (typeof description !== "string" || !description.trim() || description.length > 2000) {
      throw new Error("Planner returned an invalid subtask description");
    }
    if (!Array.isArray(criteria) || criteria.length > 8 || criteria.some((value) => typeof value !== "string" || !value.trim() || value.length > 500)) {
      throw new Error("Planner returned invalid acceptance criteria");
    }
    return { id: `step-${index + 1}`, description: description.trim(), acceptanceCriteria: criteria as string[] };
  });
}

/** Plan once with a fixed model. Jev is reserved for choosing each execution model. */
export async function planTask(context: TaskContext, prepared: PreparedModels, plannerPrice: ModelConfig): Promise<TaskPlan> {
  const model = prepared.models.strong;
  const modelId = `${model.provider}/${model.id}`;
  const metrics = emptyMetrics();
  if (context.workspaceKind === "existing" && context.task.length < 110
    && !/\b(build|create|implement|develop|multiple|several|across|system|application|website)\b|创建|开发|实现|搭建|多个|跨模块|完整|系统|网站|应用/i.test(context.task)) {
    return singleTask(context, "none", metrics);
  }
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.repoPath, agentDir: getAgentDir(), noExtensions: true,
      noSkills: true, noPromptTemplates: true,
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: context.repoPath, model, modelRuntime: prepared.runtime,
      sessionManager: SessionManager.inMemory(context.repoPath), resourceLoader,
      noTools: "all", tools: [],
    }));
    unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      if (!metrics.modelsUsed.includes(`${message.provider}/${message.model}`)) metrics.modelsUsed.push(`${message.provider}/${message.model}`);
      metrics.inputTokens += message.usage.input;
      metrics.outputTokens += message.usage.output;
      metrics.cacheReadTokens += message.usage.cacheRead;
      metrics.cacheWriteTokens += message.usage.cacheWrite;
    });
    await session.prompt([
      "将用户的 coding 任务拆成按顺序执行、可验收的子任务。简单任务只返回一个子任务；复杂任务最多六个。",
      "覆盖从空目录创建项目和修改现有仓库两种情况。各子任务应产生明确的代码或配置结果，不能只写规划或泛泛的检查。",
      "不要执行任务。只输出一个 JSON 对象，格式：{\"subtasks\":[{\"description\":\"...\",\"acceptanceCriteria\":[\"...\"]}]}。不要输出 Markdown。",
      `任务与工作区信息：${JSON.stringify({ task: context.task, workspaceKind: context.workspaceKind, languages: context.languages, trackedFiles: context.trackedFiles, sampleFiles: context.sampleFiles })}`,
    ].join("\n"));
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (last?.role === "assistant" && ["error", "aborted", "length", "deferred"].includes(last.stopReason)) {
      throw new Error(last.errorMessage ?? `Planner stopped with ${last.stopReason}`);
    }
    const subtasks = parsePlan(session.getLastAssistantText() ?? "");
    return { source: "model", plannerModel: modelId, subtasks, metrics };
  } catch (error) {
    return singleTask(context, modelId, metrics, error instanceof Error ? error.message : String(error));
  } finally {
    unsubscribe?.();
    metrics.estimatedCostUsd = estimateCostUsd(metrics, plannerPrice);
    session?.dispose();
  }
}
