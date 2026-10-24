import type { PlannedSubtask, SubtaskTrace, TaskContext, TaskPlan } from "../core/types.js";

export function assertDependenciesCompleted(step: PlannedSubtask, completed: SubtaskTrace[]): void {
  for (const id of step.dependsOn) {
    if (!completed.some((item) => item.plan.id === id && item.status === "success")) {
      throw new Error(`${step.id} 的前置子任务 ${id} 尚未成功完成`);
    }
  }
}

export function subtaskRoutingText(step: PlannedSubtask): string {
  return [step.description, `交付成果：${step.outputs.join("；")}`, `验收标准：${step.acceptanceCriteria.join("；")}`,
    `验收方式：${step.verification.join("；")}`, `预计文件：${step.expectedFiles.join("、")}`,
    `前置依赖：${step.dependsOn.join("、") || "无"}；所需成果：${step.inputs.join("；") || "无"}`].join("\n");
}

/** Keep advisory labels out of the task text, so baseline/rule routing cannot accidentally see them. */
export function subtaskRoutingContext(context: TaskContext, plan: TaskPlan, step: PlannedSubtask): TaskContext {
  const { plannerAnalysis: _previousAnalysis, ...workspace } = context;
  if (!step.complexityHint && !step.complexityFactors) return { ...workspace, task: subtaskRoutingText(step) };
  const evidenceIds = new Set([
    ...step.evidenceIds, ...(step.complexityFactors?.confirmedFacts.flatMap((fact) => fact.evidenceIds) ?? []),
  ]);
  return { ...workspace, task: subtaskRoutingText(step), plannerAnalysis: {
    plannerModel: plan.plannerModel, evidenceBasis: "planning_snapshot",
    ...(step.complexityHint ? { complexityHint: step.complexityHint } : {}),
    ...(step.complexityFactors ? { complexityFactors: step.complexityFactors } : {}),
    evidence: plan.inspection.evidence.filter((item) => evidenceIds.has(item.id)),
  } };
}

export function subtaskExecutionPrompt(task: string, plan: TaskPlan, index: number, completed: SubtaskTrace[]): string {
  const step = plan.subtasks[index];
  if (!step) throw new Error("子任务索引超出规划范围");
  assertDependenciesCompleted(step, completed);
  const requirements = plan.requirements.filter((item) => step.requirementIds.includes(item.id));
  const dependencies = completed.filter((item) => step.dependsOn.includes(item.plan.id)).map((item) => ({
    id: item.plan.id, outputs: item.plan.outputs, summary: item.agent?.summary.slice(-4000) ?? "",
  }));
  return [
    `用户总目标：${task}`,
    `当前子任务（${step.id}/${plan.subtasks.length}）：${step.description}`,
    `本步覆盖需求：${JSON.stringify(requirements)}`,
    `边界理由：${step.rationale}`,
    `前置成果与接口：${JSON.stringify({ inputs: step.inputs, dependencies })}`,
    `本步交付成果：${step.outputs.join("；")}`,
    `预计修改范围（规划线索，实施前检查实际代码）：${step.expectedFiles.join("、") || "未拆分原任务"}`,
    `规划时读取的相关位置：${JSON.stringify(plan.inspection.evidence.filter((item) => step.evidenceIds.includes(item.id))
      .map(({ id, path, startLine, endLine }) => ({ id, path, startLine, endLine })))}`,
    `验收标准：\n${step.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    `验收方式：\n${step.verification.map((item) => `- ${item}`).join("\n")}`,
    "只完成当前子任务，保留前面子任务的结果；遵守前置接口与交付契约，不提前实现后续子任务或增加用户未要求的功能。",
  ].join("\n\n");
}

export function describeTaskPlan(plan: TaskPlan): string {
  return [
    `需求 ${plan.requirements.length} 项；代码依据 ${plan.inspection.evidence.length} 段；规划检查：${plan.validation.status}`,
    ...plan.requirements.map((item) => `${item.id}：${item.description}`),
    `拆分理由：${plan.rationale}`,
    ...plan.subtasks.flatMap((step) => [
      `${step.id}：${step.description}`,
      `  需求：${step.requirementIds.join("、")}；依赖：${step.dependsOn.join("、") || "无"}`,
      `  产出：${step.outputs.join("；")}；文件：${step.expectedFiles.join("、") || "待执行时确认"}`,
      `  边界：${step.rationale}`,
      `  验收：${step.verification.join("；")}`,
      ...(step.complexityHint ? [`  复杂度初判：${step.complexityHint}（仅供 Jev 参考）`] : []),
      ...(step.complexityFactors ? [
        `  范围：${step.complexityFactors.changeScope}`,
        `  依赖分析：${step.complexityFactors.dependencies}`,
        `  集成风险：${step.complexityFactors.integrationRisk}`,
        `  已确认事实：${step.complexityFactors.confirmedFacts.map((fact) => `${fact.statement} [${fact.evidenceIds.join("、")}]`).join("；") || "无"}`,
        `  假设：${step.complexityFactors.assumptions.join("；") || "无"}`,
        `  未确认：${step.complexityFactors.uncertainties.join("；") || "无"}`,
      ] : []),
    ]),
    ...plan.validation.warnings.map((warning) => `规划提示：${warning}`),
  ].join("\n");
}
