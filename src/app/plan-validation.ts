import type { ComplexityFactors, Difficulty, PlannedSubtask, PlanningInspection, TaskRequirement } from "../core/types.js";
import { isWorkspaceRelativePath } from "../repository/inspection.js";

type RecordValue = Record<string, unknown>;
const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export class PlanValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("；"));
    this.name = "PlanValidationError";
  }
}

export function parsePlanningJson(text: string): RecordValue {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const value: unknown = JSON.parse((fenced ?? (first >= 0 && last > first ? text.slice(first, last + 1) : text)).trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanValidationError(["规划结果必须是 JSON 对象"]);
  return value as RecordValue;
}

function string(value: unknown, field: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new PlanValidationError([`${field} 必须是非空文本，且不超过 ${max} 字符`]);
  return value.trim();
}

function strings(value: unknown, field: string, min = 0, max = 12): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new PlanValidationError([`${field} 必须包含 ${min}–${max} 项`]);
  const items = value.map((item) => string(item, field, 1000));
  if (new Set(items.map(normalized)).size !== items.length) throw new PlanValidationError([`${field} 中有重复项`]);
  return items;
}

function parseComplexity(raw: RecordValue): { complexityHint?: Difficulty; complexityFactors?: ComplexityFactors } {
  const result: { complexityHint?: Difficulty; complexityFactors?: ComplexityFactors } = {};
  if (raw.complexityHint !== undefined) {
    if (typeof raw.complexityHint !== "string" || !["easy", "medium", "hard"].includes(raw.complexityHint)) {
      throw new PlanValidationError(["complexityHint 必须是 easy、medium 或 hard"]);
    }
    result.complexityHint = raw.complexityHint as Difficulty;
  }
  if (raw.complexityFactors !== undefined) {
    if (!raw.complexityFactors || typeof raw.complexityFactors !== "object" || Array.isArray(raw.complexityFactors)) {
      throw new PlanValidationError(["complexityFactors 必须是对象"]);
    }
    const factors = raw.complexityFactors as RecordValue;
    if (!Array.isArray(factors.confirmedFacts) || factors.confirmedFacts.length > 12) {
      throw new PlanValidationError(["confirmedFacts 必须包含 0–12 项有代码引用的事实"]);
    }
    result.complexityFactors = {
      changeScope: string(factors.changeScope, "复杂度修改范围", 1000),
      dependencies: string(factors.dependencies, "复杂度依赖分析", 1000),
      integrationRisk: string(factors.integrationRisk, "复杂度集成风险", 1000),
      uncertainties: strings(factors.uncertainties, "尚未确认的情况"),
      assumptions: strings(factors.assumptions, "规划假设"),
      confirmedFacts: factors.confirmedFacts.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new PlanValidationError(["代码事实格式无效"]);
        const fact = item as RecordValue;
        return { statement: string(fact.statement, "代码事实", 1000), evidenceIds: strings(fact.evidenceIds, "代码事实引用", 1, 12) };
      }),
    };
  }
  return result;
}

export function parseRequirements(text: string, task: string): TaskRequirement[] {
  const body = parsePlanningJson(text);
  if (!Array.isArray(body.requirements) || body.requirements.length < 1 || body.requirements.length > 24) {
    throw new PlanValidationError(["应提取 1–24 个需求点"]);
  }
  const requirements = body.requirements.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new PlanValidationError(["需求点格式无效"]);
    const raw = item as RecordValue;
    const description = string(raw.description, "需求描述", 1000);
    const sourceQuote = string(raw.sourceQuote, "需求原文", 2000);
    if (!task.replace(/\s+/g, " ").includes(sourceQuote.replace(/\s+/g, " "))) {
      throw new PlanValidationError([`需求 ${i + 1} 的 sourceQuote 不在用户原文中`]);
    }
    return { id: `req-${i + 1}`, description, sourceQuote };
  });
  if (new Set(requirements.map((item) => normalized(item.description))).size !== requirements.length) {
    throw new PlanValidationError(["提取出的需求点重复"]);
  }
  return requirements;
}

export function parseAndValidatePlan(text: string, requirements: TaskRequirement[], inspection: PlanningInspection): {
  rationale: string; subtasks: PlannedSubtask[]; warnings: string[];
} {
  const body = parsePlanningJson(text);
  const rationale = string(body.rationale, "整体拆分理由");
  if (!Array.isArray(body.subtasks) || body.subtasks.length < 1 || body.subtasks.length > 6) {
    throw new PlanValidationError(["规划必须包含 1–6 个子任务"]);
  }
  const subtasks: PlannedSubtask[] = body.subtasks.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new PlanValidationError(["子任务格式无效"]);
    const raw = item as RecordValue;
    return {
      id: string(raw.id, "子任务 ID", 40), description: string(raw.description, "子任务目标"),
      requirementIds: strings(raw.requirementIds, "覆盖需求", 1, 24), dependsOn: strings(raw.dependsOn, "依赖步骤", 0, 5),
      inputs: strings(raw.inputs, "前置成果"), outputs: strings(raw.outputs, "交付成果", 1),
      expectedFiles: strings(raw.expectedFiles, "预计修改文件", 1, 20),
      acceptanceCriteria: strings(raw.acceptanceCriteria, "验收标准", 1, 8), verification: strings(raw.verification, "验收方式", 1, 8),
      rationale: string(raw.rationale, "子任务边界理由"), evidenceIds: strings(raw.evidenceIds, "代码依据", 0, 12),
      ...parseComplexity(raw),
    };
  });
  const errors: string[] = [];
  const warnings: string[] = [];
  const requirementIds = new Set(requirements.map((item) => item.id));
  const evidenceIds = new Set(inspection.evidence.map((item) => item.id));
  const ids = new Map(subtasks.map((item, i) => [item.id, i]));
  const covered = new Map(requirements.map((item) => [item.id, [] as string[]]));
  const goals = new Set<string>();
  const outputs = new Map<string, string>();
  const scopes = new Map<string, string>();
  if (ids.size !== subtasks.length) errors.push("子任务 ID 重复");
  subtasks.forEach((step, index) => {
    if (step.id !== `step-${index + 1}`) errors.push(`第 ${index + 1} 步 ID 必须为 step-${index + 1}`);
    const goal = normalized(step.description);
    if (goals.has(goal)) errors.push(`${step.id} 的目标与其他步骤重复`);
    goals.add(goal);
    if (/^(?:实现功能|修改代码|检查|测试|规划|implement|fix|test|review|plan)$/i.test(goal)) errors.push(`${step.id} 的目标过于笼统`);
    for (const id of step.requirementIds) {
      if (!requirementIds.has(id)) errors.push(`${step.id} 引用了未知需求 ${id}`);
      else covered.get(id)!.push(step.id);
    }
    for (const id of step.dependsOn) {
      const dependency = ids.get(id);
      if (dependency === undefined) errors.push(`${step.id} 依赖不存在的 ${id}`);
      else if (dependency >= index) errors.push(`${step.id} 依赖自身或后续步骤 ${id}，执行顺序无效`);
      else if (!subtasks[dependency].outputs.some((output) => step.inputs.some((input) => normalized(input) === normalized(output)))) {
        errors.push(`${step.id} 没有在 inputs 中声明消费 ${id} 的交付成果`);
      }
    }
    for (const output of step.outputs) {
      const previous = outputs.get(normalized(output));
      if (previous) errors.push(`${step.id} 与 ${previous} 声明了重复交付成果：${output}`);
      outputs.set(normalized(output), step.id);
    }
    for (const path of step.expectedFiles) {
      if (!isWorkspaceRelativePath(path)) errors.push(`${step.id} 的预计文件路径不在工作区内：${path}`);
      const previous = scopes.get(path);
      if (previous) warnings.push(`${step.id} 与 ${previous} 都预计修改 ${path}，需依据各自目标和接口避免重复工作。`);
      scopes.set(path, step.id);
    }
    for (const id of step.evidenceIds) if (!evidenceIds.has(id)) errors.push(`${step.id} 引用了未实际读取的代码依据 ${id}`);
    for (const fact of step.complexityFactors?.confirmedFacts ?? []) for (const id of fact.evidenceIds) {
      if (!evidenceIds.has(id)) errors.push(`${step.id} 的代码事实引用了未实际读取的代码依据 ${id}`);
    }
    if (evidenceIds.size && !step.evidenceIds.length) errors.push(`${step.id} 缺少已读取的代码依据引用`);
  });
  for (const step of subtasks) for (const input of step.inputs) {
    const provider = outputs.get(normalized(input));
    if (provider && !step.dependsOn.includes(provider)) errors.push(`${step.id} 消费 ${provider} 的成果却未声明依赖`);
  }
  for (const [id, steps] of covered) {
    if (!steps.length) errors.push(`需求 ${id} 没有分配给任何子任务`);
    if (steps.length > 1) warnings.push(`需求 ${id} 由 ${steps.join("、")} 共同覆盖，结构检查无法证明这些工作没有语义重复。`);
  }
  if (!inspection.evidence.length) warnings.push("没有已有代码依据；空工作区可正常规划，已有项目需留意理解偏差。");
  if (errors.length) throw new PlanValidationError(errors);
  return { rationale, subtasks, warnings };
}
