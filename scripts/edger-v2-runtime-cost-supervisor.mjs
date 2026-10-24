#!/usr/bin/env node
// External supervisor for Edger v2 runtime-cost browser runs.
//
// Runs one worker command in its own process group (Node's `detached: true`
// calls setsid in the child, so no fork-before-setsid step is needed here) and
// enforces, from outside the browser main thread:
//
// - free disk at admission and a running reserve, on the output filesystem;
// - total elapsed time and every deadline the worker publishes (an item, and
//   inside it a match or bank check), exactly as declared: no slack is added,
//   so a page or control call that never answers cannot extend a condition
//   while the worker keeps heartbeating;
// - aggregate output bytes;
// - worker liveness (exit), a first heartbeat within the startup timeout and
//   heartbeat freshness afterwards (stall).
//
// Every poll records the worker's descendants, including Chromium's separate
// process group, and writes an atomic progress record. On any stop it writes a
// stop record, TERMs every owned group, escalates to KILL after the grace
// period, waits for the worker to be reaped and verifies that no owned process
// remains. It never signals a process it did not observe as a descendant.
// Detection lateness (bounded by the poll interval) and the TERM/KILL cleanup
// duration are recorded separately from the deadline itself.
//
//   node edger-v2-runtime-cost-supervisor.mjs --out DIR [limits] -- CMD [ARGS...]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createOwnershipRegistry,
  directoryBytes,
  freeBytes as statfsFreeBytes,
  listProcesses as psList,
  readJsonIfPresent,
  terminateOwned,
  writeJsonAtomic,
} from "./edger-v2-runtime-cost-process.mjs";

export const SUPERVISOR_SCHEMA = "edger_v2_runtime_cost_supervisor_v1";
const GIB = 1024 ** 3;

export const DEFAULT_SUPERVISOR_LIMITS = Object.freeze({
  wallCapMs: 90 * 60 * 1000,
  admissionFreeBytes: 3 * GIB,
  reserveFreeBytes: 2 * GIB,
  outputCapBytes: 1 * GIB,
  heartbeatTimeoutMs: 120 * 1000,
  startupTimeoutMs: 120 * 1000,
  graceMs: 5000,
  pollMs: 1000,
  exitWaitMs: 10 * 1000,
});

export function supervisorPaths(outDir) {
  return {
    progress: path.join(outDir, "supervisor", "progress.json"),
    stop: path.join(outDir, "supervisor", "stop.json"),
    final: path.join(outDir, "supervisor", "final.json"),
    log: path.join(outDir, "supervisor", "worker.log"),
    workerProgress: path.join(outDir, "progress", "worker.json"),
  };
}

// Start supervising. Returns { stop(reason), done } where done resolves to the
// final record once the worker has exited and owned processes are verified gone.
export function superviseWorker({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  outDir,
  limits: limitOverrides = {},
  freeBytes = statfsFreeBytes,
  listProcesses = psList,
  log = () => {},
}) {
  const limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...limitOverrides };
  const paths = supervisorPaths(path.resolve(outDir));
  fs.mkdirSync(path.dirname(paths.progress), { recursive: true });
  fs.mkdirSync(path.dirname(paths.workerProgress), { recursive: true });
  const startedAt = Date.now();
  const self = listProcesses().find((entry) => entry.pid === process.pid);
  const registry = createOwnershipRegistry({ excludePgids: self ? [self.pgid] : [] });
  const record = {
    schema_version: SUPERVISOR_SCHEMA,
    command: [command, ...args],
    cwd,
    out_dir: path.resolve(outDir),
    supervisor_pid: process.pid,
    supervisor_pgid: self?.pgid ?? null,
    limits,
    started_at: new Date(startedAt).toISOString(),
    admission: null,
    worker: null,
    polls: 0,
    min_free_bytes: null,
    max_output_bytes: 0,
    stop_reason: null,
    stop_detail: null,
    stop_elapsed_ms: null,
    worker_exit: null,
    cleanup: null,
    owned_groups: [],
    last_worker_progress: null,
    ended_at: null,
    elapsed_ms: null,
  };

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let child = null;
  let timer = null;
  let stopping = false;
  let exited = null;
  const exitWaiters = [];

  function finish() {
    record.owned_groups = registry.snapshot();
    record.ended_at = new Date().toISOString();
    record.elapsed_ms = Date.now() - startedAt;
    writeJsonAtomic(paths.final, record);
    resolveDone(record);
  }

  const admissionFree = freeBytes(record.out_dir);
  record.admission = {
    free_bytes: admissionFree,
    required_bytes: limits.admissionFreeBytes,
    admitted: admissionFree >= limits.admissionFreeBytes,
  };
  record.min_free_bytes = admissionFree;
  if (!record.admission.admitted) {
    record.stop_reason = "admission_free_disk";
    finish();
    return { stop: () => {}, done };
  }

  const logFd = fs.openSync(paths.log, "a");
  child = spawn(command, args, {
    cwd,
    env: {
      ...env,
      EDGER_RUNTIME_COST_OUT: record.out_dir,
      EDGER_RUNTIME_COST_PROGRESS: paths.workerProgress,
      EDGER_RUNTIME_COST_SUPERVISOR_PID: String(process.pid),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  record.worker = { pid: child.pid, pgid: child.pid };
  child.on("exit", (code, signal) => {
    exited = { code, signal, at: new Date().toISOString() };
    record.worker_exit = exited;
    exitWaiters.splice(0).forEach((resolve) => resolve());
    if (!stopping) {
      const progress = readJsonIfPresent(paths.workerProgress);
      stop(code === 0 && progress?.phase === "complete" ? "worker_complete" : "worker_exit", { code, signal });
    }
  });
  child.on("error", (error) => {
    if (!stopping) {
      stop("worker_spawn_error", { message: error.message });
    }
  });

  function observe() {
    const processes = listProcesses();
    const workerEntry = processes.find((entry) => entry.pid === child.pid);
    if (workerEntry) {
      registry.observe(child.pid, processes, (entry) =>
        entry.pgid === child.pid ? "worker" : "detached_descendant");
    }
    return processes;
  }

  function writeProgress(extra = {}) {
    writeJsonAtomic(paths.progress, {
      schema_version: SUPERVISOR_SCHEMA,
      at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      stopping,
      polls: record.polls,
      min_free_bytes: record.min_free_bytes,
      max_output_bytes: record.max_output_bytes,
      owned_groups: registry.snapshot().map(({ pgid, role, members }) => ({ pgid, role, members: members.length })),
      worker: record.worker,
      ...extra,
    });
  }

  function poll() {
    if (stopping) {
      return;
    }
    record.polls += 1;
    try {
      observe();
    } catch (error) {
      log(`process listing failed: ${error.message}`);
    }
    const now = Date.now();
    const free = freeBytes(record.out_dir);
    record.min_free_bytes = Math.min(record.min_free_bytes, free);
    const output = directoryBytes(record.out_dir);
    record.max_output_bytes = Math.max(record.max_output_bytes, output);
    const progress = readJsonIfPresent(paths.workerProgress);
    record.last_worker_progress = progress;
    writeProgress({ free_bytes: free, output_bytes: output, worker_phase: progress?.phase ?? null });

    if (now - startedAt > limits.wallCapMs) {
      stop("wall_cap", { elapsed_ms: now - startedAt });
    } else if (free < limits.reserveFreeBytes) {
      stop("disk_reserve", { free_bytes: free });
    } else if (output > limits.outputCapBytes) {
      stop("output_cap", { output_bytes: output });
    } else if (progress && now - progress.heartbeat_at_ms > limits.heartbeatTimeoutMs) {
      stop("worker_stall", { heartbeat_age_ms: now - progress.heartbeat_at_ms });
    } else if (!progress && now - startedAt > limits.startupTimeoutMs) {
      stop("worker_startup_timeout", { elapsed_ms: now - startedAt });
    } else {
      const expired = expiredDeadline(progress, now);
      if (expired) {
        stop("condition_deadline", expired);
      }
    }
  }

  async function stop(reason, detail = null) {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(timer);
    const stopStarted = Date.now();
    record.stop_reason = reason;
    record.stop_detail = detail;
    record.stop_elapsed_ms = stopStarted - startedAt;
    writeJsonAtomic(paths.stop, {
      schema_version: SUPERVISOR_SCHEMA,
      reason,
      detail,
      at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
    });
    log(`stopping: ${reason}`);
    try {
      observe();
    } catch {
      // Use what was already recorded.
    }
    record.cleanup = await terminateOwned({ registry, graceMs: limits.graceMs, list: listProcesses });
    if (!exited) {
      await Promise.race([
        new Promise((resolve) => exitWaiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, limits.exitWaitMs)),
      ]);
    }
    record.cleanup.worker_reaped = Boolean(exited);
    // TERM, grace, KILL and reap: accounted apart from any deadline.
    record.cleanup.duration_ms = Date.now() - stopStarted;
    // The worker may have written a final phase while stopping.
    record.last_worker_progress = readJsonIfPresent(paths.workerProgress) ?? record.last_worker_progress;
    writeProgress({ final: true });
    finish();
  }

  // Record the worker before its first poll so an early crash is still owned.
  try {
    observe();
  } catch {
    // The first poll retries.
  }
  writeProgress();
  timer = setInterval(poll, limits.pollMs);
  return { stop, done };
}

// The first published deadline that has passed, if any. A deadline is
// { id, kind, started_at_ms, deadline_ms }; it expires once now is past
// started_at_ms + deadline_ms. late_by_ms is the detection delay.
export function expiredDeadline(progress, now) {
  for (const deadline of progress?.deadlines ?? []) {
    if (!Number.isFinite(deadline?.started_at_ms) || !Number.isFinite(deadline?.deadline_ms)) {
      continue;
    }
    const expiresAt = deadline.started_at_ms + deadline.deadline_ms;
    if (now > expiresAt) {
      return { deadline, expires_at_ms: expiresAt, detected_at_ms: now, late_by_ms: now - expiresAt };
    }
  }
  return null;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("usage: edger-v2-runtime-cost-supervisor.mjs --out DIR [limits] -- CMD [ARGS...]");
  }
  const options = {};
  const flags = argv.slice(0, separator);
  for (let index = 0; index < flags.length; index += 2) {
    if (!flags[index].startsWith("--") || flags[index + 1] === undefined) {
      throw new Error(`bad option ${flags[index]}`);
    }
    options[flags[index].slice(2)] = flags[index + 1];
  }
  const [command, ...args] = argv.slice(separator + 1);
  return { options, command, args };
}

function number(options, key, scale, fallback) {
  if (options[key] === undefined) {
    return fallback;
  }
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative number`);
  }
  return value * scale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options, command, args } = parseArgs(process.argv.slice(2));
  if (!options.out) {
    throw new Error("--out is required");
  }
  const d = DEFAULT_SUPERVISOR_LIMITS;
  const limits = {
    wallCapMs: number(options, "wall-cap-s", 1000, d.wallCapMs),
    admissionFreeBytes: number(options, "admission-free-gib", GIB, d.admissionFreeBytes),
    reserveFreeBytes: number(options, "reserve-free-gib", GIB, d.reserveFreeBytes),
    outputCapBytes: number(options, "output-cap-gib", GIB, d.outputCapBytes),
    heartbeatTimeoutMs: number(options, "heartbeat-timeout-s", 1000, d.heartbeatTimeoutMs),
    startupTimeoutMs: number(options, "startup-timeout-s", 1000, d.startupTimeoutMs),
    graceMs: number(options, "grace-ms", 1, d.graceMs),
    pollMs: number(options, "poll-ms", 1, d.pollMs),
    exitWaitMs: number(options, "exit-wait-ms", 1, d.exitWaitMs),
  };
  // Unknown flags (including the removed --condition-slack-s) are refused.
  const known = new Set(["out", "wall-cap-s", "admission-free-gib", "reserve-free-gib", "output-cap-gib",
    "heartbeat-timeout-s", "startup-timeout-s", "grace-ms", "poll-ms", "exit-wait-ms"]);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
  }
  const log =(message) => process.stderr.write(`[supervisor ${new Date().toISOString()}] ${message}\n`);
  const supervision = superviseWorker({ command, args, outDir: options.out, limits, log });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => supervision.stop("supervisor_interrupted", { signal }));
  }
  const record = await supervision.done;
  log(`final: ${record.stop_reason}; cleanup verified ${record.cleanup?.verified ?? "n/a"}`);
  const clean = record.stop_reason === "worker_complete" && record.worker_exit?.code === 0 &&
    record.cleanup?.verified === true;
  const interrupted = record.stop_reason === "supervisor_interrupted";
  process.exit(clean ? 0 : interrupted ? 130 : 1);
}
