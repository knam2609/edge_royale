#!/usr/bin/env node

import { spawnNativePython } from "./python-runtime.mjs";

const result = spawnNativePython(
  ["scripts/edger-v2-training.py", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
