import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffWorkspace, disposeSnapshot, inspectWorkspace, snapshotWorkspace } from "../src/repository/workspace.js";

test("Git workspace keeps its commit and captures only changes made after the snapshot", async () => {
  const repo = await mkdtemp(join(tmpdir(), "routercoder-git-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  await writeFile(join(repo, "code.ts"), "export const n = 1;\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "initial");
  await writeFile(join(repo, "code.ts"), "export const n = 2;\n");
  const info = await inspectWorkspace(repo, "Change code");
  assert.ok(info.commit);
  assert.equal(info.trackedFiles, 1);
  assert.deepEqual(info.languages, ["TypeScript"]);
  const snapshot = await snapshotWorkspace(repo);
  try {
    await writeFile(join(repo, "code.ts"), "export const n = 3;\n");
    await writeFile(join(repo, "new.ts"), "export const m = 3;\n");
    const diff = await diffWorkspace(snapshot);
    assert.match(diff, /-export const n = 2/);
    assert.match(diff, /\+export const n = 3/);
    assert.match(diff, /export const m = 3/);
  } finally {
    await disposeSnapshot(snapshot);
  }
});

test("ordinary folders and Git repositories without commits are valid workspaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercoder-folder-test-"));
  await writeFile(join(directory, "code.py"), "print('before')\n");
  await mkdir(join(directory, "node_modules"));
  await writeFile(join(directory, "node_modules", "generated.js"), "ignored\n");
  const info = await inspectWorkspace(directory, "Update the code");
  assert.equal(info.commit, null);
  assert.equal(info.trackedFiles, 1);
  assert.deepEqual(info.languages, ["Python"]);
  const snapshot = await snapshotWorkspace(directory);
  try {
    await writeFile(join(directory, "code.py"), "print('after')\n");
    await writeFile(join(directory, "new.py"), "print('new')\n");
    const diff = await diffWorkspace(snapshot);
    assert.match(diff, /print\('after'\)/);
    assert.match(diff, /print\('new'\)/);
    assert.doesNotMatch(diff, /generated\.js/);
  } finally {
    await disposeSnapshot(snapshot);
  }

  const uncommitted = await mkdtemp(join(tmpdir(), "routercoder-uncommitted-test-"));
  execFileSync("git", ["-C", uncommitted, "init", "-q"], { stdio: "pipe" });
  await writeFile(join(uncommitted, "code.js"), "export const value = 1;\n");
  assert.equal((await inspectWorkspace(uncommitted, "Update the code")).commit, null);
  const uncommittedSnapshot = await snapshotWorkspace(uncommitted);
  try {
    await writeFile(join(uncommitted, "code.js"), "export const value = 2;\n");
    assert.match(await diffWorkspace(uncommittedSnapshot), /export const value = 2/);
  } finally {
    await disposeSnapshot(uncommittedSnapshot);
  }

  const empty = await mkdtemp(join(tmpdir(), "routercoder-empty-test-"));
  const emptySnapshot = await snapshotWorkspace(empty);
  try {
    await writeFile(join(empty, "first.js"), "export const ready = true;\n");
    assert.match(await diffWorkspace(emptySnapshot), /first\.js/);
  } finally {
    await disposeSnapshot(emptySnapshot);
  }
});
