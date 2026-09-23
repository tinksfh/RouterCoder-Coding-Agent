import assert from "node:assert/strict";
import { test } from "node:test";
import { FixedDecisionEngine, JevDecisionEngine, RuleDecisionEngine } from "../src/core/decision.js";
import type { Difficulty, TaskContext } from "../src/core/types.js";

const context: TaskContext = {
  task: "Fix the addition bug", repoPath: "/tmp/example", commit: "abc",
  trackedFiles: 3, languages: ["JavaScript"],
};

function mockJev(choice: Difficulty, confidence: number): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.questions.difficulty.type, "choice");
    assert.deepEqual(Object.keys(request.questions.difficulty.criteria), ["easy", "medium", "hard"]);
    return Response.json({
      model: "jev-test",
      answers: { difficulty: { type: "choice", choice, confidence, probabilities: { easy: 0.1, medium: 0.2, hard: 0.7 } } },
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  };
}

test("Jev maps every coding difficulty to one model tier", async () => {
  for (const [difficulty, tier] of [["easy", "small"], ["medium", "medium"], ["hard", "strong"]] as const) {
    const result = await new JevDecisionEngine("test-key", "jev-test", mockJev(difficulty, 0.9)).decide(context);
    assert.equal(result.tier, tier);
    assert.equal(result.fallback, false);
    assert.deepEqual(result.jevUsage, { inputTokens: 12, outputTokens: 3 });
  }
});

test("low confidence and Jev failures route to strong", async () => {
  const low = await new JevDecisionEngine("test-key", "jev-test", mockJev("easy", 0.59)).decide(context);
  assert.equal(low.tier, "strong");
  assert.equal(low.fallback, true);
  const failed = await new JevDecisionEngine("test-key", "jev-test", async () => new Response("down", { status: 503 })).decide(context);
  assert.equal(failed.tier, "strong");
  assert.match(failed.reason, /503/);
  const missing = await new JevDecisionEngine(undefined).decide(context);
  assert.equal(missing.tier, "strong");
});

test("fixed and rule decisions work without Jev", async () => {
  assert.equal((await new FixedDecisionEngine("medium").decide(context)).tier, "medium");
  assert.equal((await new RuleDecisionEngine().decide({ ...context, task: "Fix a README typo" })).tier, "small");
  assert.equal((await new RuleDecisionEngine().decide({ ...context, task: "Refactor architecture across modules" })).tier, "strong");
});
