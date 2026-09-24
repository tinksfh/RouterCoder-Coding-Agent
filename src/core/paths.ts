import { fileURLToPath } from "node:url";

// This module has the same depth under src/ and dist/, so the path works in
// development and after compilation.
export const DEFAULT_TRACE_DIR = fileURLToPath(new URL("../../traces/", import.meta.url));
export const DEFAULT_CONFIG = fileURLToPath(new URL("../../configs/models.yaml", import.meta.url));
