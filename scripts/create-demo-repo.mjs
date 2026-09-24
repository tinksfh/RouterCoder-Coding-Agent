#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "routercoder-demo-"));
mkdirSync(join(repo, "src"));
mkdirSync(join(repo, "test"));
writeFileSync(join(repo, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(join(repo, "test", "math.test.js"), `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { add } from '../src/math.js';

test('adds two numbers', () => {
  assert.equal(add(1, 2), 3);
});
`);
writeFileSync(join(repo, "package.json"), '{"name":"routercoder-demo","private":true,"type":"module","scripts":{"test":"node --test"}}\n');
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["-c", "user.name=RouterCoder", "-c", "user.email=demo@localhost", "commit", "-qm", "Add failing addition fixture"], { cwd: repo });
console.log(repo);
