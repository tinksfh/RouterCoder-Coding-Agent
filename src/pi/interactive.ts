import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelsConfig } from "../core/config.js";
import { DEFAULT_CONFIG, DEFAULT_TRACE_DIR } from "../core/paths.js";
import { inspectWorkspace } from "../repository/workspace.js";
import { prepareModels } from "./runner.js";
import { TIERS, type RouterKind, type Tier } from "../core/types.js";

export interface InteractiveOptions {
  repo: string;
  router: RouterKind;
  tier?: Tier;
  config: string;
  traceDir: string;
}

export function parseInteractiveArgs(args: string[]): InteractiveOptions {
  if (args[0] !== "interactive") throw new Error("Expected 'interactive'");
  const values = new Map<string, string>();
  const allowed = new Set(["--workspace", "--repo", "--router", "--tier", "--config", "--trace-dir"]);
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid or missing value for ${flag ?? "argument"}. Use --help for usage.`);
    }
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  if (values.has("--workspace") && values.has("--repo")) throw new Error("Use either --workspace or --repo, not both");
  const repo = values.get("--workspace") ?? values.get("--repo") ?? process.cwd();
  const router = values.get("--router") ?? "jev";
  if (!["jev", "rule", "fixed"].includes(router)) throw new Error(`Unknown router: ${router}`);
  const tier = values.get("--tier");
  if (router === "fixed" && !TIERS.includes(tier as Tier)) throw new Error("--router fixed requires --tier small|medium|strong");
  if (router !== "fixed" && tier) throw new Error("--tier can only be used with --router fixed");
  return {
    repo: resolve(repo), router: router as RouterKind,
    ...(tier ? { tier: tier as Tier } : {}),
    config: resolve(values.get("--config") ?? DEFAULT_CONFIG),
    traceDir: resolve(values.get("--trace-dir") ?? DEFAULT_TRACE_DIR),
  };
}

export async function launchPiTui(options: InteractiveOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode needs a terminal. Run it in a terminal window, not through a pipe.");
  }
  const context = await inspectWorkspace(options.repo, "");
  const config = await loadModelsConfig(options.config);
  await prepareModels(config);
  const piModule = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piEntry = join(dirname(piModule), "bundle", "cli.js");
  const extension = join(dirname(fileURLToPath(import.meta.url)), "extension.js");
  const initial = config.models.medium;
  const child = spawn(process.execPath, [piEntry,
    "--no-extensions", "--extension", extension,
    "--provider", initial.provider, "--model", initial.model,
  ], {
    cwd: context.repoPath,
    stdio: "inherit",
    env: {
      ...process.env,
      ROUTERCODER_CONFIG: options.config,
      ROUTERCODER_ROUTER: options.router,
      ROUTERCODER_TIER: options.tier ?? "",
      ROUTERCODER_TRACE_DIR: options.traceDir,
    },
  });
  return await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
