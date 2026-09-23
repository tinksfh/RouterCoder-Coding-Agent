import { rm } from "node:fs/promises";

// Remove only the compiler output for this project before rebuilding.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
