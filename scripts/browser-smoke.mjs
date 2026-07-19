#!/usr/bin/env node

import { spawn } from "node:child_process";

const watchdogMs = Number.parseInt(
  process.env.BROWSER_SMOKE_WATCHDOG_MS ?? "120000",
  10,
);

if (!Number.isInteger(watchdogMs) || watchdogMs < 1_000) {
  throw new Error("BROWSER_SMOKE_WATCHDOG_MS must be an integer of at least 1000");
}

const worker = spawn(process.execPath, ["scripts/browser-smoke-worker.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let settled = false;

worker.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
worker.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

const watchdog = setTimeout(() => {
  if (settled) {
    return;
  }
  settled = true;
  worker.kill("SIGTERM");
  console.error(
    [
      `Browser smoke exceeded its ${watchdogMs}ms watchdog.`,
      `Node: ${process.version}`,
      `Architecture: ${process.arch}`,
      `Platform: ${process.platform}`,
      `Executable: ${process.execPath}`,
      "Install the pinned browser with: npx playwright install chromium",
      output ? `Last output:\n${output.slice(-4000)}` : "No worker output was captured.",
    ].join("\n"),
  );
  process.exitCode = 1;
}, watchdogMs);

worker.on("exit", (code, signal) => {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(watchdog);
  if (code !== 0) {
    console.error(
      [
        `Browser smoke worker failed (code=${code ?? "null"}, signal=${signal ?? "none"}).`,
        `Node: ${process.version}`,
        `Architecture: ${process.arch}`,
        `Platform: ${process.platform}`,
        `Executable: ${process.execPath}`,
        "Install the pinned browser with: npx playwright install chromium",
      ].join("\n"),
    );
    process.exitCode = code || 1;
  }
});
