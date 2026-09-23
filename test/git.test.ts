import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDiff, inspectRepository } from "../src/repository/git.js";

test("repository inspection and diff include tracked and new files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "routercoder-git-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  await writeFile(join(repo, "code.ts"), "export const n = 1;\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial");
  const info = await inspectRepository(repo, "Change code");
  assert.equal(info.trackedFiles, 1);
  assert.deepEqual(info.languages, ["TypeScript"]);
  await writeFile(join(repo, "code.ts"), "export const n = 2;\n");
  await writeFile(join(repo, "new.ts"), "export const m = 3;\n");
  const diff = await collectDiff(repo);
  assert.match(diff, /export const n = 2/);
  assert.match(diff, /export const m = 3/);
  await assert.rejects(inspectRepository(repo, "Again"), /uncommitted or untracked/);
});
