import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadModelsConfig } from "../src/core/config.js";
import { prepareModels } from "../src/pi/runner.js";
import routerCoderExtension from "../src/pi/extension.js";

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, "..");

async function exerciseInteractivePlan(agentDir: string, config: string, traceDir: string): Promise<void> {
  const variables = { PI_CODING_AGENT_DIR: agentDir, ROUTERCODER_CONFIG: config, ROUTERCODER_TRACE_DIR: traceDir,
    ROUTERCODER_ROUTER: "fixed", ROUTERCODER_TIER: "small" };
  const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  Object.assign(process.env, variables);
  const directory = await mkdtemp(join(tmpdir(), "routercoder-tui-plan-"));
  try {
    const prepared = await prepareModels(await loadModelsConfig(config));
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
    const notices: string[] = [];
    const statuses: string[] = [];
    const queued: string[] = [];
    const displayed: string[] = [];
    const switches: string[] = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => { handlers.set(name, handler); },
      setModel: async (model: { provider: string; id: string }) => { switches.push(`${model.provider}/${model.id}`); return true; },
      sendUserMessage: (text: string) => { queued.push(text); },
      sendMessage: (message: { content: string }) => { displayed.push(message.content); },
    } as unknown as ExtensionAPI;
    const ctx = { cwd: directory, mode: "tui", ui: {
      notify: (text: string) => { notices.push(text); },
      setStatus: (_key: string, text: string) => { statuses.push(text); },
    }, modelRegistry: { find: (provider: string, id: string) => prepared.runtime.getModel(provider, id) } } as unknown as ExtensionContext;
    const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
    await routerCoderExtension(pi);
    const first = await emit("input", { source: "interactive", text: "Create a two-part tool" });
    assert.equal(first.action, "transform");
    assert.match(first.text, /step-1\/2/);
    assert.deepEqual(await readdir(directory), [], "Planning cannot create code files");
    assert.ok(displayed.some((text) => text.includes("拆分理由") && text.includes("step-2")));
    assert.ok(statuses.some((text) => text.includes("只读")));
    for (const [index, file] of ["storage.js", "cli.js"].entries()) {
      await writeFile(join(directory, file), `export const ready${index} = true;\n`);
      await emit("tool_execution_end", { toolName: "write", isError: false });
      await emit("message_end", { message: { role: "assistant", provider: "mock", model: "small", stopReason: "stop",
        usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: `Delivered ${file}` }] } });
      await emit("agent_settled");
      if (index === 0) {
        assert.equal(queued.length, 1);
        const next = await emit("input", { source: "extension", text: queued[0] });
        assert.equal(next.action, "transform");
        assert.match(next.text, /step-2\/2/);
        assert.match(next.text, /Delivered storage.js/);
      }
    }
    const path = notices.find((text) => text.includes("; trace:"))?.match(/; trace: (.+)$/)?.[1];
    assert.ok(path, notices.join("\n"));
    const trace = JSON.parse(await readFile(path, "utf8"));
    assert.equal(trace.status, "success", trace.error);
    assert.equal(trace.subtasks.length, 2);
    assert.deepEqual(switches, ["mock/small", "mock/small"]);
    assert.equal(trace.subtasks[0].agent.summary, "Delivered storage.js");
    assert.equal(trace.plan.validation.status, "passed");
    assert.equal(trace.quality.requirementReview.score, 100);
    // A stale internal continuation must never reach the execution model.
    assert.equal((await emit("input", { source: "extension", text: queued[0] })).action, "handled");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function messageText(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value)
    ? value.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
}

function stream(res: ServerResponse, model: string, messages: { role: string; content?: unknown }[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const base = { id: "chatcmpl-routercoder-test", object: "chat.completion.chunk", created: 1, model };
  const write = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({ ...base, choices, ...(usage ? { usage } : {}) })}\n\n`);
  const prompt = messageText(messages.filter((message) => message.role === "user").at(-1)?.content);
  const history = messages.map((message) => messageText(message.content)).join("\n");
  let response: unknown;
  if (prompt.startsWith("ROUTERCODER_REQUIREMENTS")) {
    const task = prompt.split("用户原文：")[1];
    response = { requirements: [{ description: task, sourceQuote: task.includes("Invented requirement quote") ? "not present in task" : task }] };
  } else if (prompt.startsWith("ROUTERCODER_PLAN")) {
    const planningPrompt = messages.map((message) => messageText(message.content)).find((text) => text.startsWith("ROUTERCODER_PLAN\n"))!;
    const inspection = JSON.parse(planningPrompt.match(/只读代码依据：([^\n]+)/)![1]);
    const twoSteps = history.includes("Create a two-part tool");
    response = { rationale: "存储接口与 CLI 可分别验收，先交付依赖接口。", subtasks: Array.from({ length: twoSteps ? 2 : 1 }, (_, i) => ({
      id: `step-${i + 1}`, description: twoSteps ? (i === 0 ? "Provide storage API" : "Provide CLI backed by storage") : "Fix addition with a concrete code change",
      requirementIds: ["req-1"], dependsOn: i === 0 ? [] : ["step-1"], inputs: i === 0 ? [] : ["storage API"],
      outputs: twoSteps ? [i === 0 ? "storage API" : "CLI commands"] : ["correct addition function"],
      expectedFiles: [twoSteps ? (i === 0 ? "storage.js" : "cli.js") : "src/math.js"],
      acceptanceCriteria: ["Requested behavior is available"], verification: ["Check the exported function returns the required result"],
      rationale: "该步交付一个可独立检查的能力。", evidenceIds: inspection.evidence.length ? [inspection.evidence[0].id] : [],
    })) };
    if (history.includes("Reject split twice") || (history.includes("Repair the split once") && !prompt.startsWith("ROUTERCODER_PLAN_REPAIR"))) {
      (response as { subtasks: { requirementIds: string[] }[] }).subtasks[0].requirementIds = ["req-missing"];
    }
  } else if (prompt.includes("你是独立的代码结果评估器")) {
    response = { score: 100, confidence: 0.9, evidence: ["Mock-only review of the fixture patch"] };
  }
  if (response) {
    write([{ index: 0, delta: { role: "assistant", content: JSON.stringify(response) }, finish_reason: null }]);
    write([{ index: 0, delta: {}, finish_reason: "stop" }]);
  } else if (messages.some((message) => message.role === "tool")) {
    write([{ index: 0, delta: { role: "assistant", content: "Fixed the addition bug." }, finish_reason: null }]);
    write([{ index: 0, delta: {}, finish_reason: "stop" }]);
  } else {
    const twoSteps = prompt.includes("Create a two-part tool");
    const file = twoSteps ? (prompt.includes("step-2/2") ? "cli.js" : "storage.js") : "src/math.js";
    const content = twoSteps ? (file === "storage.js" ? "export const items = [];\n" : "import { items } from './storage.js';\nconsole.log(items);\n")
      : "export function add(a, b) {\n  return a + b;\n}\n";
    write([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: file, content }) } }] }, finish_reason: null }]);
    write([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
  }
  write([], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  res.end("data: [DONE]\n\n");
}

test("CLI runs Pi in a temporary repository for all tiers and records traces", { timeout: 90_000 }, async () => {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; tools?: unknown[]; messages: { role: string; content?: unknown }[] };
      if (messageText(body.messages.filter((message) => message.role === "user").at(-1)?.content).startsWith("ROUTERCODER_")) {
        assert.equal(body.tools?.length ?? 0, 0, "Planning has no mutation or shell tools");
      }
      stream(res, body.model, body.messages);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No mock server port");
    const agentDir = await mkdtemp(join(tmpdir(), "routercoder-pi-test-"));
    const traceDir = join(agentDir, "traces");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "mock-only",
      models: ["small", "medium", "strong"].map((id) => ({ id, contextWindow: 128000, maxTokens: 4096 })),
    } } }));
    const config = join(agentDir, "models.yaml");
    await writeFile(config, `models:\n${["small", "medium", "strong"].map((tier) => `  ${tier}: { provider: mock, model: ${tier}, contextWindow: 128000, inputPricePerMillion: 1, outputPricePerMillion: 2 }`).join("\n")}\n`);
    for (const tier of ["small", "medium", "strong"] as const) {
      const { stdout: repoText } = await exec(process.execPath, ["scripts/create-demo-repo.mjs"], { cwd: project });
      const repo = repoText.trim();
      const args = ["--import", "tsx", "src/cli.ts", "run", "--repo", repo, "--task", "Fix the addition test", "--config", config, "--trace-dir", traceDir];
      if (tier === "strong") args.push("--router", "jev");
      else args.push("--router", "fixed", "--tier", tier);
      const { stdout, stderr } = await exec(process.execPath, args, {
        cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, JEV_API_KEY: "" }, timeout: 30_000,
      });
      assert.equal(stderr, "", `${tier}: ${stderr}`);
      assert.match(stdout, new RegExp(`Route: ${tier}`));
      const tracePath = stdout.match(/^Trace: (.+)$/m)?.[1];
      assert.ok(tracePath, stdout);
      const trace = JSON.parse(await readFile(tracePath, "utf8"));
      assert.equal(trace.status, "success", JSON.stringify(trace.error));
      assert.equal(trace.selectedModel.model, tier);
      assert.deepEqual(new Set(trace.agent.metrics.modelsUsed), new Set(["mock/strong", `mock/${tier}`]));
      assert.equal(trace.plan.validation.status, "passed");
      assert.ok(trace.plan.inspection.evidence.some((item: { path: string }) => item.path === "test/math.test.js"));
      assert.match(trace.diff, /return a \+ b/);
      assert.equal(trace.agent.metrics.toolCalls.find((item: { name: string }) => item.name === "write")?.count, 1);
      if (tier === "strong") assert.equal(trace.decision.fallback, true);
      const { stdout: answer } = await exec(process.execPath, ["--input-type=module", "-e", "import('./src/math.js').then(({add}) => console.log(add(1, 2)))"], { cwd: repo });
      assert.equal(answer.trim(), "3");
    }
    const plainDirectory = await mkdtemp(join(tmpdir(), "routercoder-plain-test-"));
    await mkdir(join(plainDirectory, "src"));
    await writeFile(join(plainDirectory, "src", "math.js"), "export function add(a, b) { return a - b; }\n");
    const { stdout: plainOutput, stderr: plainError } = await exec(process.execPath,
      ["--import", "tsx", "src/cli.ts", "run", "--repo", plainDirectory,
        "--task", "Fix the addition test", "--router", "fixed", "--tier", "small",
        "--config", config, "--trace-dir", traceDir], {
        cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 30_000,
      });
    assert.equal(plainError, "");
    const plainTracePath = plainOutput.match(/^Trace: (.+)$/m)?.[1];
    assert.ok(plainTracePath, plainOutput);
    const plainTrace = JSON.parse(await readFile(plainTracePath, "utf8"));
    assert.equal(plainTrace.commit, null);
    assert.equal(plainTrace.status, "success", JSON.stringify(plainTrace.error));
    assert.match(plainTrace.diff, /return a \+ b/);
    for (const task of ["Create a two-part tool", "Repair the split once", "Reject split twice", "Invented requirement quote"]) {
      const directory = await mkdtemp(join(tmpdir(), "routercoder-planning-case-"));
      const { stdout: output } = await exec(process.execPath,
        ["--import", "tsx", "src/cli.ts", "run", "--workspace", directory, "--task", task,
          "--router", "fixed", "--tier", "small", "--config", config, "--trace-dir", traceDir], {
          cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 30_000,
        });
      const path = output.match(/^Trace: (.+)$/m)?.[1];
      assert.ok(path, output);
      const trace = JSON.parse(await readFile(path, "utf8"));
      assert.equal(trace.status, "success", JSON.stringify(trace.error));
      if (task === "Create a two-part tool") {
        assert.equal(trace.subtasks.length, 2);
        assert.deepEqual(trace.subtasks[1].plan.dependsOn, ["step-1"]);
        assert.equal(trace.subtasks.every((step: { decision: { tier: string }; status: string }) => step.decision.tier === "small" && step.status === "success"), true);
        assert.match(await readFile(join(directory, "cli.js"), "utf8"), /storage.js/);
        assert.equal(trace.agent.metrics.toolCalls.find((item: { name: string }) => item.name === "write").count, 2);
        assert.equal(trace.selectedModel, null);
      } else if (task === "Repair the split once") {
        assert.equal(trace.plan.validation.status, "passed");
        assert.equal(trace.plan.validation.attempts, 2);
        assert.match(trace.plan.validation.errors.join(" "), /未知需求/);
      } else {
        assert.equal(trace.plan.source, "fallback");
        assert.equal(trace.plan.subtasks[0].description, task);
        assert.equal(trace.plan.validation.status, "fallback");
        assert.equal(trace.plan.validation.attempts, task === "Reject split twice" ? 2 : 0);
      }
      assert.equal(trace.plan.inspection.evidence.length, 0);
    }
    await exerciseInteractivePlan(agentDir, config, traceDir);
    const badConfig = join(agentDir, "bad-models.yaml");
    await writeFile(badConfig, (await readFile(config, "utf8")).replace("model: small", "model: unavailable"));
    const { stdout: badRepoText } = await exec(process.execPath, ["scripts/create-demo-repo.mjs"], { cwd: project });
    const secret = "test-only-secret-1234567890";
    try {
      await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "run", "--repo", badRepoText.trim(),
        "--task", `Fix the addition test ${secret}`, "--router", "fixed", "--tier", "small",
        "--config", badConfig, "--trace-dir", traceDir], {
        cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TEST_API_KEY: secret }, timeout: 30_000,
      });
      assert.fail("An unknown model should fail before Pi runs");
    } catch (error) {
      const output = (error as { stdout: string; stderr: string }).stdout;
      assert.match((error as { stderr: string }).stderr, /Models not found in Pi/);
      const tracePath = output.match(/^Trace: (.+)$/m)?.[1];
      assert.ok(tracePath);
      const traceText = await readFile(tracePath, "utf8");
      assert.doesNotMatch(traceText, /test-only-secret-1234567890/);
      assert.match(traceText, /\[REDACTED\]/);
      assert.equal(JSON.parse(traceText).status, "failed");
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
