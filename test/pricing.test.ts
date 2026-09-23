import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelsConfig } from "../src/core/config.js";
import { costEstimateBasis, estimateCostUsd } from "../src/core/pricing.js";
import type { AgentMetrics } from "../src/core/types.js";

test("Codex API price simulation uses separate cache rates and records its basis", () => {
  const config = parseModelsConfig(`models:
    small: { provider: openai-codex, model: gpt-5.6-luna, contextWindow: 272000, inputPricePerMillion: 0.2, cacheReadPricePerMillion: 0.02, cacheWritePricePerMillion: 0.25, outputPricePerMillion: 1.2 }
    medium: { provider: openai-codex, model: gpt-6-luna, contextWindow: 272000, inputPricePerMillion: 0.1, outputPricePerMillion: 0.5 }
    strong: { provider: openai-codex, model: gpt-6-sol, contextWindow: 272000, inputPricePerMillion: 2, outputPricePerMillion: 10 }
  `);
  const metrics: AgentMetrics = {
    modelsUsed: [], inputTokens: 1_000_000, outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    toolCalls: [], estimatedCostUsd: 0,
  };
  assert.equal(estimateCostUsd(metrics, config.models.small), 1.67);
  assert.match(costEstimateBasis(config.models.small.provider), /模拟/);
  assert.throws(() => parseModelsConfig(`models:
    small: { provider: openai-codex, model: gpt-5.6-luna, contextWindow: 272000, inputPricePerMillion: 0.2, cacheReadPricePerMillion: -1, outputPricePerMillion: 1.2 }
    medium: { provider: openai-codex, model: gpt-6-luna, contextWindow: 272000, inputPricePerMillion: 0.1, outputPricePerMillion: 0.5 }
    strong: { provider: openai-codex, model: gpt-6-sol, contextWindow: 272000, inputPricePerMillion: 2, outputPricePerMillion: 10 }
  `), /cacheReadPricePerMillion/);
});
