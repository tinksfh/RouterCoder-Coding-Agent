import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PlanningInspection, TaskContext, TaskRequirement } from "../core/types.js";
import { redact } from "../telemetry/trace.js";

const exec = promisify(execFile);
const MAX_PATHS = 2000;
const MAX_SCANNED = 160;
const MAX_FILES = 12;
const MAX_BYTES = 64 * 1024;
const MAX_EXCERPT = 4000;
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build", "target", "vendor", "coverage", ".next"]);
const TEXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cc", ".cs", ".rb", ".php", ".swift", ".kt", ".vue", ".svelte", ".sql", ".graphql", ".proto", ".json", ".toml", ".yaml", ".yml", ".md", ".txt", ".ini", ".cfg"]);
const SOURCE = /\.(?:[cm]?jsx?|tsx?|py|go|rs|java|[ch]|cpp|cc|cs|rb|php|swift|kt|vue|svelte|sql|graphql|proto)$/i;
const TEST = /(?:^|\/)(?:tests?|specs?)(?:\/|[_.-])|(?:test|spec)\.[^.]+$|(?:^|\/)test_[^/]+$/i;
const MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|pytest\.ini|go\.mod|Cargo\.toml|README[^/]*|tsconfig\.json|Makefile)$/i;

export function isWorkspaceRelativePath(path: string): boolean {
  return Boolean(path.trim()) && !isAbsolute(path) && !/^[A-Za-z]:|^[/\\]|[\x00-\x1f]/.test(path)
    && !path.replaceAll("\\", "/").split("/").some((part) => part === ".." || part === ".git");
}

function readable(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const name = parts.at(-1) ?? "";
  return isWorkspaceRelativePath(path) && !parts.some((part) => SKIP.has(part) || part.startsWith("."))
    && !/^(?:auth|credentials|secrets)(?:\.|$)|(?:package-lock|pnpm-lock|yarn\.lock)/i.test(name)
    && (TEXT.has(extname(name).toLowerCase()) || /^(?:Makefile|Dockerfile|go\.mod)$/i.test(name));
}

async function inventory(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  try {
    const { stdout } = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const paths = [...new Set(stdout.split("\0").filter(readable))].sort();
    return { paths: paths.slice(0, MAX_PATHS), truncated: paths.length > MAX_PATHS };
  } catch { /* An ordinary folder has no Git inventory. */ }
  const paths: string[] = [];
  const directories = [root];
  let entries = 0;
  while (directories.length && paths.length < MAX_PATHS && entries < 10000) {
    const directory = directories.shift()!;
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 10000 || paths.length >= MAX_PATHS) break;
      const absolute = resolve(directory, item.name);
      if (item.isDirectory() && !SKIP.has(item.name) && !item.name.startsWith(".")) directories.push(absolute);
      else if (item.isFile()) {
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (readable(path)) paths.push(path);
      }
    }
  }
  return { paths, truncated: paths.length >= MAX_PATHS || entries >= 10000 || directories.length > 0 };
}

function keywords(task: string): string[] {
  const stop = new Set(["the", "and", "with", "from", "that", "this", "only", "should", "要求", "功能", "实现", "当前"]);
  const words = task.toLowerCase().match(/[a-z_][a-z0-9_./-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set(words.flatMap((word) => /^[\u4e00-\u9fff]+$/.test(word) && word.length > 3
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))].filter((word) => !stop.has(word)).slice(0, 48);
}

async function readPrefix(root: string, path: string): Promise<{ text: string; truncated: boolean }> {
  const absolute = resolve(root, path);
  const actual = await realpath(absolute);
  if (!isWorkspaceRelativePath(relative(root, actual)) || !(await lstat(absolute)).isFile()) throw new Error("只读取工作区内的普通文件");
  const handle = await open(absolute, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) throw new Error("跳过二进制文件");
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: size > bytesRead };
  } finally { await handle.close(); }
}

/** Bounded filesystem reads only: never run project code or expose a shell to the planner. */
export async function inspectPlanningCode(context: TaskContext, requirements: TaskRequirement[]): Promise<PlanningInspection> {
  const root = await realpath(context.repoPath);
  const listed = await inventory(root);
  const terms = keywords([context.task, ...requirements.map((item) => item.description)].join(" "));
  const relevance = (text: string) => terms.reduce((score, term) => score + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  const pathScore = (path: string) => 8 * relevance(path) + (SOURCE.test(path) ? 3 : 0) + (TEST.test(path) ? 3 : 0) + (MANIFEST.test(path) ? 2 : 0);
  const candidates = listed.paths.sort((a, b) => pathScore(b) - pathScore(a) || a.localeCompare(b)).slice(0, MAX_SCANNED);
  const scanned: { path: string; text: string; truncated: boolean; score: number }[] = [];
  const notes: string[] = [];
  for (const path of candidates) {
    try {
      const file = await readPrefix(root, path);
      if (file.text.trim()) scanned.push({ path, ...file, score: pathScore(path) + 4 * relevance(file.text) });
    } catch { if (notes.length < 5) notes.push(`未读取 ${path}：不可读、非文本或不在工作区内。`); }
  }
  scanned.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const selected: typeof scanned = [];
  // Include source, tests and project configuration when present, then fill by relevance.
  for (const category of [SOURCE, TEST, MANIFEST]) {
    const file = scanned.find((item) => category.test(item.path) && !selected.includes(item));
    if (file) selected.push(file);
  }
  for (const file of scanned) if (selected.length < MAX_FILES && !selected.includes(file)) selected.push(file);
  let truncated = listed.truncated || listed.paths.length > candidates.length || scanned.length > selected.length;
  const evidence = selected.map((file, index) => {
    const lines = file.text.split("\n");
    const hit = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
    const start = Math.max(0, hit - 15);
    const chosen: string[] = [];
    let length = 0;
    for (const line of lines.slice(start, start + 100)) {
      if (length + line.length + 1 > MAX_EXCERPT) {
        if (!chosen.length) chosen.push(line.slice(0, MAX_EXCERPT));
        break;
      }
      chosen.push(line);
      length += line.length + 1;
    }
    if (file.truncated || start > 0 || chosen.length < lines.length) truncated = true;
    const excerpt = redact(chosen.join("\n"));
    return { id: `evidence-${index + 1}`, path: file.path, startLine: start + 1, endLine: start + chosen.length,
      excerpt, sha256: createHash("sha256").update(excerpt).digest("hex") };
  });
  if (!evidence.length) notes.push(context.workspaceKind === "empty" ? "空工作区：没有已有源码或测试可读取，按新项目需求规划。" : "未找到可读取的相关文本；规划代码依据不足，不能假定接口已存在。");
  if (truncated) notes.push("代码依据是有预算的局部片段，并非完整仓库审查。最多扫描 160 个文件，每文件 64 KiB，提供 12 段、每段最多 4000 字符。");
  return { evidence, filesConsidered: listed.paths.length, truncated, notes };
}
