import type { AgentMetrics, ModelConfig } from "./types.js";

export function estimateCostUsd(metrics: AgentMetrics, prices: ModelConfig): number {
  return (
    metrics.inputTokens * prices.inputPricePerMillion
    + metrics.outputTokens * prices.outputPricePerMillion
    + metrics.cacheReadTokens * (prices.cacheReadPricePerMillion ?? prices.inputPricePerMillion)
    + metrics.cacheWriteTokens * (prices.cacheWritePricePerMillion ?? prices.inputPricePerMillion)
  ) / 1_000_000;
}

export function costEstimateBasis(provider: string): string {
  return provider === "openai-codex"
    ? "OpenAI API 标准价格模拟；使用 ChatGPT 登录时不代表实际订阅扣费"
    : "按配置的每百万 Token 价格估算；不代表供应商实际账单";
}
