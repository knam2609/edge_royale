#!/usr/bin/env node

import { spawnNativePython } from "./python-runtime.mjs";

const result = spawnNativePython(
  ["-m", "unittest", "tests/test_edger_training_streaming.py"],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
