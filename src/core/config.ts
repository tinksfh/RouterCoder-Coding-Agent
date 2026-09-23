import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { TIERS, type ModelConfig, type ModelsConfig, type Tier } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModel(value: unknown, tier: Tier): ModelConfig {
  if (!isRecord(value)) throw new Error(`Missing models.${tier} configuration`);
  const provider = value.provider;
  const model = value.model;
  const contextWindow = value.contextWindow;
  const inputPricePerMillion = value.inputPricePerMillion;
  const outputPricePerMillion = value.outputPricePerMillion;
  const cacheReadPricePerMillion = value.cacheReadPricePerMillion;
  const cacheWritePricePerMillion = value.cacheWritePricePerMillion;
  if (typeof provider !== "string" || !provider.trim() || provider.startsWith("replace-")) {
    throw new Error(`Set a real provider for models.${tier}`);
  }
  if (typeof model !== "string" || !model.trim() || model.startsWith("replace-")) {
    throw new Error(`Set a real model ID for models.${tier}`);
  }
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0) {
    throw new Error(`models.${tier}.contextWindow must be a positive integer`);
  }
  for (const [name, price] of Object.entries({ inputPricePerMillion, outputPricePerMillion, ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion }), ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion }) })) {
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw new Error(`models.${tier}.${name} must be a non-negative number`);
    }
  }
  return {
    provider,
    model,
    contextWindow: contextWindow as number,
    inputPricePerMillion: inputPricePerMillion as number,
    outputPricePerMillion: outputPricePerMillion as number,
    ...(cacheReadPricePerMillion === undefined ? {} : { cacheReadPricePerMillion: cacheReadPricePerMillion as number }),
    ...(cacheWritePricePerMillion === undefined ? {} : { cacheWritePricePerMillion: cacheWritePricePerMillion as number }),
  };
}

export function parseModelsConfig(input: string): ModelsConfig {
  const parsed: unknown = parse(input);
  if (!isRecord(parsed) || !isRecord(parsed.models)) {
    throw new Error("Configuration must contain a models mapping");
  }
  const rawModels = parsed.models;
  const models = Object.fromEntries(TIERS.map((tier) => [tier, readModel(rawModels[tier], tier)])) as Record<Tier, ModelConfig>;
  const ids = TIERS.map((tier) => `${models[tier].provider}/${models[tier].model}`);
  if (new Set(ids).size !== 3) throw new Error("Small, medium and strong must use distinct models");
  return { models };
}

export async function loadModelsConfig(path: string): Promise<ModelsConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Model config not found: ${path}. Copy configs/models.example.yaml to configs/models.yaml and fill in your models.`);
    }
    throw error;
  }
  return parseModelsConfig(source);
}
