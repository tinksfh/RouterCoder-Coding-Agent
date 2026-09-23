import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { extname, join, resolve } from "node:path";
import type { TaskContext } from "../core/types.js";

const exec = promisify(execFile);
const OPTIONS = { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" as const };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, ...OPTIONS });
  return stdout;
}

export async function inspectRepository(repoPath: string, task: string, allowDirty = false): Promise<TaskContext> {
  const cwd = resolve(repoPath);
  let root: string;
  try {
    root = (await git(cwd, "rev-parse", "--show-toplevel")).trim();
  } catch {
    throw new Error(`Not a Git repository: ${cwd}`);
  }
  if (!allowDirty) {
    const status = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
    if (status.trim()) throw new Error("Target repository has uncommitted or untracked files. Commit or stash them before running RouterCoder.");
  }
  const commit = (await git(root, "rev-parse", "HEAD")).trim();
  const files = (await git(root, "ls-files", "-z")).split("\0").filter(Boolean);
  const languageByExtension: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
    ".c": "C", ".h": "C/C++", ".cpp": "C++", ".cc": "C++", ".cs": "C#",
    ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".kt": "Kotlin",
  };
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = languageByExtension[extname(file).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
  return { task, repoPath: root, commit, trackedFiles: files.length, languages };
}

/** Capture tracked and untracked content without changing the user's Git index. */
export async function snapshotWorkingTree(repoPath: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "routercoder-index-"));
  const indexPath = join(directory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await exec("git", ["read-tree", "HEAD"], { cwd: repoPath, env, ...OPTIONS });
    await exec("git", ["add", "-A"], { cwd: repoPath, env, ...OPTIONS });
    const { stdout } = await exec("git", ["write-tree"], { cwd: repoPath, env, ...OPTIONS });
    return stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function diffSnapshots(repoPath: string, before: string, after: string): Promise<string> {
  return git(repoPath, "diff", "--binary", before, after);
}

export async function collectDiff(repoPath: string): Promise<string> {
  const trackedDiff = await git(repoPath, "diff", "HEAD", "--binary");
  const untracked = (await git(repoPath, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const patches: string[] = [trackedDiff];
  for (const file of untracked) {
    try {
      await git(repoPath, "diff", "--no-index", "--binary", "--", "/dev/null", file);
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string };
      if (result.code !== 1 || typeof result.stdout !== "string") throw error;
      patches.push(result.stdout);
    }
  }
  return patches.filter(Boolean).join("\n");
}
