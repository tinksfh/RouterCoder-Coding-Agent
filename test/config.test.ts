import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelsConfig } from "../src/core/config.js";
import { parseArgs } from "../src/cli.js";

const yaml = `models:
  small: { provider: test, model: one, contextWindow: 1000, inputPricePerMillion: 1, outputPricePerMillion: 2 }
  medium: { provider: test, model: two, contextWindow: 2000, inputPricePerMillion: 3, outputPricePerMillion: 4 }
  strong: { provider: test, model: three, contextWindow: 3000, inputPricePerMillion: 5, outputPricePerMillion: 6 }
`;

test("model config requires distinct, complete three-tier models", () => {
  const config = parseModelsConfig(yaml);
  assert.equal(config.models.medium.model, "two");
  assert.throws(() => parseModelsConfig(yaml.replace("model: three", "model: two")), /distinct/);
  assert.throws(() => parseModelsConfig(yaml.replace("provider: test, model: one", "provider: replace-with-provider, model: one")), /real provider/);
});

test("CLI enforces fixed tier and required task", () => {
  const options = parseArgs(["run", "--repo", "/tmp/x", "--task", "Fix bug", "--router", "fixed", "--tier", "small"]);
  assert.notEqual(options, "help");
  if (options !== "help") assert.equal(options.tier, "small");
  assert.throws(() => parseArgs(["run", "--repo", "/tmp/x", "--task", "Fix bug", "--router", "fixed"]), /requires --tier/);
  assert.throws(() => parseArgs(["run", "--repo", "/tmp/x"]), /required/);
});
