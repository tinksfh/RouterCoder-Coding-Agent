import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAndValidatePlan, parseRequirements } from "../src/app/plan-validation.js";
import { assertDependenciesCompleted, describeTaskPlan, subtaskExecutionPrompt } from "../src/app/task-plan.js";
import type { PlanningInspection, SubtaskTrace, TaskPlan } from "../src/core/types.js";
import { inspectPlanningCode } from "../src/repository/inspection.js";
import { diffWorkspace, disposeSnapshot, inspectWorkspace, snapshotWorkspace } from "../src/repository/workspace.js";

const task = "Add todo storage and implement a CLI with tests";
const requirements = parseRequirements(JSON.stringify({ requirements: [
  { description: "Persist todo items", sourceQuote: "todo storage" },
  { description: "Expose CLI with tests", sourceQuote: "a CLI with tests" },
] }), task);
const inspection: PlanningInspection = { evidence: [{ id: "evidence-1", path: "src/store.py", startLine: 1, endLine: 1,
  excerpt: "def load(): pass", sha256: "test-hash" }], filesConsidered: 1, truncated: false, notes: [] };
const valid = () => ({ rationale: "先提供存储契约，再交付使用该契约的 CLI。", subtasks: [
  { id: "step-1", description: "Provide persistent todo storage", requirementIds: ["req-1"], dependsOn: [], inputs: [],
    outputs: ["load/save todo storage API"], expectedFiles: ["src/store.py"], acceptanceCriteria: ["Items survive a reload"],
    verification: ["python -m unittest tests.test_store"], rationale: "将序列化实现和存储契约测试放在一起。", evidenceIds: ["evidence-1"] },
  { id: "step-2", description: "Provide a tested todo CLI", requirementIds: ["req-2"], dependsOn: ["step-1"], inputs: ["load/save todo storage API"],
    outputs: ["add/list CLI backed by storage"], expectedFiles: ["cli.py", "tests/test_cli.py"], acceptanceCriteria: ["CLI commands use persistent items"],
    verification: ["python -m unittest tests.test_cli"], rationale: "命令、参数错误和命令集成测试构成一个可验收结果。", evidenceIds: ["evidence-1"] },
] });

test("requirements must quote the original task and cannot contain duplicate entries", () => {
  assert.equal(requirements.length, 2);
  assert.throws(() => parseRequirements('{"requirements":[{"description":"Add login","sourceQuote":"login"}]}', task), /原文/);
  assert.throws(() => parseRequirements(JSON.stringify({ requirements: [
    { description: "Duplicate", sourceQuote: "todo" }, { description: "Duplicate", sourceQuote: "CLI" },
  ] }), task), /重复/);
});

test("functional boundaries validate coverage, real evidence and explicit dependency contracts", () => {
  const parsed = parseAndValidatePlan(JSON.stringify(valid()), requirements, inspection);
  assert.equal(parsed.subtasks.length, 2);
  assert.deepEqual(parsed.subtasks[1].dependsOn, ["step-1"]);
  // Multiple files and shared requirements can be valid; exact repeated deliverables cannot.
  const shared = valid();
  shared.subtasks[1].requirementIds.push("req-1");
  shared.subtasks[1].expectedFiles.push("src/store.py");
  assert.equal(parseAndValidatePlan(JSON.stringify(shared), requirements, inspection).warnings.length, 2);
});

test("invalid coverage, duplicates, order, interface contracts and evidence stop a split plan", () => {
  const cases: [string, (plan: ReturnType<typeof valid>) => void, RegExp][] = [
    ["uncovered", (plan) => { plan.subtasks.pop(); }, /没有分配/],
    ["unknown requirement", (plan) => { plan.subtasks[1].requirementIds = ["req-9"]; }, /未知需求/],
    ["forward edge", (plan) => { plan.subtasks[0].dependsOn = ["step-2"]; }, /后续步骤/],
    ["self edge", (plan) => { plan.subtasks[0].dependsOn = ["step-1"]; }, /自身/],
    ["missing dependency", (plan) => { plan.subtasks[1].dependsOn = ["step-9"]; }, /不存在/],
    ["unbound input", (plan) => { plan.subtasks[1].inputs = []; }, /声明消费/],
    ["undeclared dependency", (plan) => { plan.subtasks[1].dependsOn = []; }, /未声明依赖/],
    ["duplicate output", (plan) => { plan.subtasks[1].outputs = [...plan.subtasks[0].outputs]; }, /重复交付/],
    ["duplicate goal", (plan) => { plan.subtasks[1].description = plan.subtasks[0].description; }, /目标.*重复/],
    ["unread evidence", (plan) => { plan.subtasks[0].evidenceIds = ["evidence-99"]; }, /未实际读取/],
    ["absent evidence", (plan) => { plan.subtasks[0].evidenceIds = []; }, /缺少.*代码依据/],
    ["path escape", (plan) => { plan.subtasks[0].expectedFiles = ["../outside.py"]; }, /不在工作区/],
    ["no acceptance", (plan) => { plan.subtasks[0].acceptanceCriteria = []; }, /验收标准/],
    ["no verification", (plan) => { plan.subtasks[0].verification = []; }, /验收方式/],
    ["no boundary reason", (plan) => { plan.subtasks[0].rationale = ""; }, /边界理由/],
  ];
  for (const [name, mutate, expected] of cases) {
    const plan = valid();
    mutate(plan);
    assert.throws(() => parseAndValidatePlan(JSON.stringify(plan), requirements, inspection), expected, name);
  }
});

test("code inspection reads source and tests, respects Git ignores and stays read-only", async () => {
  const repo = await mkdtemp(join(tmpdir(), "routercoder-inspection-"));
  const outside = await mkdtemp(join(tmpdir(), "routercoder-outside-"));
  let snapshot;
  try {
    await mkdir(join(repo, "src"));
    await mkdir(join(repo, "tests"));
    await mkdir(join(repo, "node_modules"));
    await writeFile(join(repo, "src/store.py"), "def load_todos():\n    return []\n");
    await writeFile(join(repo, "tests/test_store.py"), "def test_todos():\n    assert load_todos() == []\n");
    await writeFile(join(repo, "pyproject.toml"), "[project]\nname = 'todo'\n");
    await writeFile(join(repo, ".gitignore"), "ignored.py\n");
    await writeFile(join(repo, "ignored.py"), "ignored_marker = True\n");
    await writeFile(join(repo, ".env"), "SECRET_VALUE=never-send\n");
    await writeFile(join(repo, "node_modules/skip.js"), "skip_marker\n");
    await writeFile(join(outside, "escape.py"), "outside_marker\n");
    await symlink(join(outside, "escape.py"), join(repo, "linked.py"));
    execFileSync("git", ["init", "-q", repo]);
    const context = await inspectWorkspace(repo, task);
    snapshot = await snapshotWorkspace(repo);
    const read = await inspectPlanningCode(context, requirements);
    assert.ok(read.evidence.some((item) => item.path === "src/store.py" && item.excerpt.includes("load_todos")));
    assert.ok(read.evidence.some((item) => item.path === "tests/test_store.py"));
    assert.ok(read.evidence.every((item) => item.sha256.length === 64 && item.endLine >= item.startLine));
    assert.doesNotMatch(JSON.stringify(read.evidence), /outside_marker|ignored_marker|SECRET_VALUE|skip_marker/);
    assert.equal(await diffWorkspace(snapshot), "");
    assert.equal(await readFile(join(repo, "src/store.py"), "utf8"), "def load_todos():\n    return []\n");
  } finally {
    if (snapshot) await disposeSnapshot(snapshot);
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("empty directories produce no invented code evidence", async () => {
  const repo = await mkdtemp(join(tmpdir(), "routercoder-empty-planning-"));
  try {
    const read = await inspectPlanningCode(await inspectWorkspace(repo, task), requirements);
    assert.deepEqual(read.evidence, []);
    assert.match(read.notes.join(" "), /空工作区/);
    const plan = valid();
    plan.subtasks.forEach((step) => { step.evidenceIds = []; });
    assert.equal(parseAndValidatePlan(JSON.stringify(plan), requirements, read).subtasks.length, 2);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("execution checks successful prerequisites and passes their real summaries and contracts", () => {
  const parsed = parseAndValidatePlan(JSON.stringify(valid()), requirements, inspection);
  const plan: TaskPlan = { ...parsed, source: "model", plannerModel: "mock/strong", requirements, inspection,
    validation: { status: "passed", attempts: 1, errors: [], warnings: [] },
    metrics: { modelsUsed: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, toolCalls: [] } };
  assert.throws(() => assertDependenciesCompleted(plan.subtasks[1], []), /尚未成功/);
  const previous = { plan: plan.subtasks[0], status: "success", agent: { summary: "Implemented load_todos/save_todos in src/store.py" } } as SubtaskTrace;
  const prompt = subtaskExecutionPrompt(task, plan, 1, [previous]);
  assert.match(prompt, /Implemented load_todos/);
  assert.match(prompt, /load\/save todo storage API/);
  assert.match(prompt, /req-2/);
  assert.match(describeTaskPlan(plan), /拆分理由/);
});
