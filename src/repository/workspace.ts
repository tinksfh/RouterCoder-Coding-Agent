import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskContext } from "../core/types.js";

const exec = promisify(execFile);
const OPTIONS = { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" as const };
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);
const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".c": "C", ".h": "C/C++", ".cpp": "C++", ".cc": "C++", ".cs": "C#",
  ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".kt": "Kotlin",
};

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env, ...OPTIONS });
  return stdout;
}

async function filesInDirectory(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(join(directory, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

/** Resolve a local workspace. Git metadata is useful when present, but optional. */
export async function inspectWorkspace(path: string, task: string): Promise<TaskContext> {
  const requested = resolve(path);
  try {
    if (!(await stat(requested)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Workspace directory not found: ${requested}`);
  }
  const directory = await realpath(requested);
  let gitRoot: string | null = null;
  try { gitRoot = (await git(directory, ["rev-parse", "--show-toplevel"])).trim(); } catch { /* Ordinary directory. */ }
  let commit: string | null = null;
  let files: string[];
  if (gitRoot) {
    try { commit = (await git(gitRoot, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { /* An uncommitted Git repository is valid. */ }
    files = (await git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  } else {
    files = await filesInDirectory(directory);
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = LANGUAGES[extname(file).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
  return { task, repoPath: directory, commit, trackedFiles: files.length, languages };
}

export interface WorkspaceSnapshot {
  path: string;
  gitDir: string;
  tree: string;
}

function snapshotEnv(snapshot: WorkspaceSnapshot): NodeJS.ProcessEnv {
  return { ...process.env, GIT_DIR: snapshot.gitDir, GIT_WORK_TREE: snapshot.path };
}

async function captureTree(snapshot: WorkspaceSnapshot): Promise<string> {
  const env = snapshotEnv(snapshot);
  const excludes = join(snapshot.gitDir, "routercoder-excludes");
  await git(snapshot.path, ["-c", `core.excludesFile=${excludes}`, "add", "-A"], env);
  return (await git(snapshot.path, ["write-tree"], env)).trim();
}

/** Use a temporary Git object store for diffs without modifying the workspace. */
export async function snapshotWorkspace(path: string): Promise<WorkspaceSnapshot> {
  const gitDir = await mkdtemp(join(tmpdir(), "routercoder-snapshot-"));
  const snapshot: WorkspaceSnapshot = { path, gitDir, tree: "" };
  try {
    await git(path, ["init", "--bare", "-q", gitDir]);
    await writeFile(join(gitDir, "routercoder-excludes"), ".git\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n.cache/\n");
    snapshot.tree = await captureTree(snapshot);
    return snapshot;
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true });
    throw error;
  }
}

export async function diffWorkspace(snapshot: WorkspaceSnapshot): Promise<string> {
  const after = await captureTree(snapshot);
  return git(snapshot.path, ["diff", "--binary", snapshot.tree, after], snapshotEnv(snapshot));
}

export async function disposeSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  await rm(snapshot.gitDir, { recursive: true, force: true });
}
