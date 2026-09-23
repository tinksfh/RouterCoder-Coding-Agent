import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunTrace } from "../core/types.js";

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string);
}

export function redact(value: string): string {
  let result = value;
  for (const secret of secretValues()) result = result.replaceAll(secret, "[REDACTED]");
  return result
    .replace(/\b(?:sk-|apikey_)[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
}

function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  }
  return value;
}

export async function writeTrace(directory: string, trace: RunTrace): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${trace.id}.json`);
  await writeFile(path, JSON.stringify(redactObject(trace), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return path;
}
