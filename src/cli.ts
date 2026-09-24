#!/usr/bin/env node
import { resolve } from "node:path";
import { run, type RunOptions } from "./app/run.js";
import { DEFAULT_CONFIG, DEFAULT_TRACE_DIR } from "./core/paths.js";
import { TIERS, type RouterKind, type Tier } from "./core/types.js";
import { launchPiTui, parseInteractiveArgs } from "./pi/interactive.js";
import { redact } from "./telemetry/trace.js";

export { run } from "./app/run.js";

const HELP = `RouterCoder coding agent

Usage:
  routercoder run --task <text> [--workspace <path>] [--router jev|rule|fixed] [--tier small|medium|strong]
  routercoder interactive [--workspace <path>] [--router jev|rule|fixed] [--tier small|medium|strong]

Options:
  --workspace <path>  Target directory (default: current directory)
  --repo <path>       Alias for --workspace
  --config <path>     Model configuration (default: project-root/configs/models.yaml)
  --trace-dir <path>  Trace directory (default: project-root/traces)
  --help              Show this help

Fixed routing requires --tier. Jev routing is the default.
The workspace may be an ordinary directory or a Git repository.
`;

export function parseArgs(args: string[]): RunOptions | "help" {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args[0] !== "run") throw new Error("Expected 'run'. Use --help for usage.");
  const values = new Map<string, string>();
  const allowed = new Set(["--workspace", "--repo", "--task", "--router", "--tier", "--config", "--trace-dir"]);
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
  const task = values.get("--task");
  if (!task?.trim()) throw new Error("--task is required");
  const router = values.get("--router") ?? "jev";
  if (!["jev", "rule", "fixed"].includes(router)) throw new Error(`Unknown router: ${router}`);
  const tier = values.get("--tier");
  if (router === "fixed" && !TIERS.includes(tier as Tier)) throw new Error("--router fixed requires --tier small|medium|strong");
  if (router !== "fixed" && tier) throw new Error("--tier can only be used with --router fixed");
  return {
    repo: resolve(repo), task,
    router: router as RouterKind,
    ...(tier ? { tier: tier as Tier } : {}),
    config: resolve(values.get("--config") ?? DEFAULT_CONFIG),
    traceDir: resolve(values.get("--trace-dir") ?? DEFAULT_TRACE_DIR),
  };
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(HELP);
      return;
    }
    if (args[0] === "interactive") {
      process.exitCode = await launchPiTui(parseInteractiveArgs(args));
      return;
    }
    const options = parseArgs(args);
    if (options === "help") {
      console.log(HELP);
      return;
    }
    const result = await run(options);
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  await main();
}
