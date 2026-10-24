// Disposable owned worker for supervisor tests. Each mode reproduces one
// failure the runtime-cost supervisor must handle; "group" modes also start a
// TERM-resistant child in its own process group, as Playwright does with
// Chromium on macOS.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createWorkerProgress } from "../../scripts/edger-v2-runtime-cost-process.mjs";

const mode = process.argv[2];
const out = process.env.EDGER_RUNTIME_COST_OUT;
let groupChild = null;

// Installed before the first heartbeat, so a supervisor that has seen progress
// knows TERM will be ignored.
if (["stall", "resist_term"].includes(mode)) {
  process.on("SIGTERM", () => {});
}

const progress = createWorkerProgress({
  intervalMs: 100,
  onOrphan: () => {
    fs.writeFileSync(path.join(out, "orphaned.json"), JSON.stringify({ pid: process.pid, child: groupChild?.pid ?? null }));
    if (groupChild) {
      try {
        process.kill(-groupChild.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    process.exit(3);
  },
});

if (["group", "orphan"].includes(mode)) {
  groupChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  progress.update({ phase: "running", owned: [{ role: "fake_browser", pid: groupChild.pid }] });
}

switch (mode) {
  case "ok":
    progress.update({ phase: "complete" });
    setTimeout(() => process.exit(0), 200);
    break;
  case "crash":
    setTimeout(() => process.exit(3), 300);
    break;
  case "stall":
    // A blocked event loop: no heartbeats, and the JS TERM handler never runs.
    progress.update({ phase: "stalling" });
    setTimeout(() => {
      for (;;) {
        // Spin.
      }
    }, 300);
    break;
  case "resist_term":
    setInterval(() => {}, 1000);
    break;
  case "write_big": {
    const block = Buffer.alloc(512 * 1024, 1);
    let index = 0;
    setInterval(() => {
      fs.writeFileSync(path.join(out, `blob-${index}.bin`), block);
      index += 1;
    }, 50);
    break;
  }
  case "deadline_hang": {
    // A match whose page/control never answers while the worker keeps
    // heartbeating: only the published match deadline can stop it.
    const now = Date.now();
    progress.update({
      phase: "real_time",
      deadlines: [
        { id: "item", kind: "item", started_at_ms: now, deadline_ms: 60_000 },
        { id: "match", kind: "match", started_at_ms: now, deadline_ms: 700 },
      ],
    });
    setInterval(() => {}, 1000);
    break;
  }
  case "deadline_handoff": {
    // The match ends well inside its deadline; teardown then outlasts that
    // deadline under the item deadline, which must not stop the run.
    const now = Date.now();
    const item = { id: "item", kind: "item", started_at_ms: now, deadline_ms: 60_000 };
    progress.update({
      phase: "real_time",
      deadlines: [item, { id: "match", kind: "match", started_at_ms: now, deadline_ms: 2000 }],
    });
    setTimeout(() => progress.update({ deadlines: [item] }), 100);
    setTimeout(() => {
      progress.update({ phase: "complete", deadlines: [] });
      setTimeout(() => process.exit(0), 200);
    }, 3000);
    break;
  }
  case "hang":
  case "group":
  case "orphan":
    setInterval(() => {}, 1000);
    break;
  default:
    throw new Error(`unknown mode ${mode}`);
}
