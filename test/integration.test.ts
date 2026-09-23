import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const project = resolve(import.meta.dirname, "..");

function stream(res: ServerResponse, model: string, hasToolResult: boolean): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const base = { id: "chatcmpl-routercoder-test", object: "chat.completion.chunk", created: 1, model };
  const write = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({ ...base, choices, ...(usage ? { usage } : {}) })}\n\n`);
  if (hasToolResult) {
    write([{ index: 0, delta: { role: "assistant", content: "Fixed the addition bug." }, finish_reason: null }]);
    write([{ index: 0, delta: {}, finish_reason: "stop" }]);
  } else {
    write([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_write_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "src/math.js", content: "export function add(a, b) {\n  return a + b;\n}\n" }) } }] }, finish_reason: null }]);
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
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: { role: string }[] };
      stream(res, body.model, body.messages.some((message) => message.role === "tool"));
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
      const { stdout: repoText } = await exec("bash", ["scripts/create-demo-repo.sh"], { cwd: project });
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
      assert.deepEqual(trace.agent.metrics.modelsUsed, [`mock/${tier}`]);
      assert.match(trace.diff, /return a \+ b/);
      assert.equal(trace.agent.metrics.toolCalls.find((item: { name: string }) => item.name === "write")?.count, 1);
      if (tier === "strong") assert.equal(trace.decision.fallback, true);
      const { stdout: answer } = await exec(process.execPath, ["--input-type=module", "-e", "import('./src/math.js').then(({add}) => console.log(add(1, 2)))"], { cwd: repo });
      assert.equal(answer.trim(), "3");
    }
    const badConfig = join(agentDir, "bad-models.yaml");
    await writeFile(badConfig, (await readFile(config, "utf8")).replace("model: small", "model: unavailable"));
    const { stdout: badRepoText } = await exec("bash", ["scripts/create-demo-repo.sh"], { cwd: project });
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
