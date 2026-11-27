// Process bookkeeping for the Edger v2 runtime-cost supervisor and workers.
//
// Ownership is tracked by identity (pid plus start time from ps), so a recycled
// pid or process-group id is never signalled. The supervisor records its worker
// and every descendant it observes; Playwright starts Chromium with
// `detached: true` on macOS, so the browser and its helpers live in their own
// process group, which is recorded alongside the worker's group. Cleanup sends
// TERM to each owned group, escalates to KILL after a bounded grace period and
// then verifies that no owned process remains.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(temporary, file);
}

export function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ps cputime: [[dd-]hh:]mm:ss[.cc]
export function parseCpuSeconds(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return Number(days) * 86400 + seconds;
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d:.-]+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{1,2}:\d\d:\d\d\s+\d{4})\s+(.*)$/;

export function parsePsOutput(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      stat: match[4],
      cpu_s: parseCpuSeconds(match[5]),
      lstart: match[6].replace(/\s+/g, " "),
      command: match[7],
    });
  }
  return processes;
}

// Every live process; zombies are excluded (they hold no resources and are
// reaped by their parent or launchd).
export function listProcesses() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,time=,lstart=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return parsePsOutput(text).filter((entry) => !entry.stat.startsWith("Z"));
}

export function identityOf(entry) {
  return `${entry.pid}|${entry.lstart}`;
}

export function descendantsOf(rootPid, processes, { inclusive = false } = {}) {
  const children = new Map();
  for (const entry of processes) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const found = inclusive ? processes.filter((entry) => entry.pid === rootPid) : [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

export function treeCpuSeconds(rootPid, processes) {
  return descendantsOf(rootPid, processes, { inclusive: true })
    .reduce((sum, entry) => sum + entry.cpu_s, 0);
}

// ps CPU seconds of a process tree over a window of samples. Processes present
// at the first sample count from their cputime then; processes first seen
// later count from zero, since they started inside the window. A process that
// exits between samples loses its CPU after its last sample, so any exit makes
// the total a lower bound (lower_bound: true).
export function createTreeCpuTracker(rootPid) {
  const baseline = new Map();
  const latest = new Map();
  let current = new Set();
  let samples = 0;
  let appeared = 0;
  return {
    sample(processes) {
      const now = new Set();
      for (const entry of descendantsOf(rootPid, processes, { inclusive: true })) {
        const id = identityOf(entry);
        now.add(id);
        if (!baseline.has(id)) {
          baseline.set(id, samples === 0 ? entry.cpu_s : 0);
          appeared += samples === 0 ? 0 : 1;
        }
        latest.set(id, entry.cpu_s);
      }
      current = now;
      samples += 1;
    },
    summary() {
      let cpu = 0;
      for (const [id, value] of latest) {
        cpu += value - baseline.get(id);
      }
      const exited = [...latest.keys()].filter((id) => !current.has(id)).length;
      return {
        cpu_s: Math.round(cpu * 100) / 100,
        samples,
        processes: latest.size,
        appeared,
        exited,
        lower_bound: exited > 0,
      };
    },
  };
}

// Owned process groups, never including the caller's own group.
export function createOwnershipRegistry({ excludePgids = [] } = {}) {
  const excluded = new Set(excludePgids);
  const groups = new Map();

  function add(entry, role) {
    if (excluded.has(entry.pgid)) {
      return false;
    }
    const group = groups.get(entry.pgid) ?? {
      pgid: entry.pgid,
      role,
      first_seen_at: new Date().toISOString(),
      members: new Map(),
    };
    if (!group.members.has(identityOf(entry))) {
      group.members.set(identityOf(entry), { pid: entry.pid, lstart: entry.lstart, command: entry.command.slice(0, 200) });
    }
    groups.set(entry.pgid, group);
    return true;
  }

  // Record a root and all of its live descendants.
  function observe(rootPid, processes, roleFor = () => "descendant") {
    for (const entry of descendantsOf(rootPid, processes, { inclusive: true })) {
      add(entry, roleFor(entry));
    }
  }

  // Live processes still provably ours: a known member identity, or any member
  // of a group that still contains a known member identity.
  function live(processes) {
    const known = new Set();
    for (const group of groups.values()) {
      for (const identity of group.members.keys()) {
        known.add(identity);
      }
    }
    const verifiedGroups = new Set(
      processes.filter((entry) => known.has(identityOf(entry))).map((entry) => entry.pgid),
    );
    return processes.filter((entry) =>
      known.has(identityOf(entry)) || (groups.has(entry.pgid) && verifiedGroups.has(entry.pgid)));
  }

  return {
    add,
    observe,
    live,
    has: (pgid) => groups.has(pgid),
    snapshot: () => [...groups.values()].map((group) => ({
      pgid: group.pgid,
      role: group.role,
      first_seen_at: group.first_seen_at,
      members: [...group.members.values()],
    })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(pgid, signal, kill) {
  try {
    kill(-pgid, signal);
    return "sent";
  } catch (error) {
    return error.code ?? String(error);
  }
}

// TERM every owned group with a live member, wait up to graceMs, KILL whatever
// remains (groups, then individual known members), wait again and verify.
export async function terminateOwned({
  registry,
  graceMs = 5000,
  pollMs = 100,
  list = listProcesses,
  kill = process.kill.bind(process),
}) {
  const started = Date.now();
  const record = { term: [], kill: [], remaining: [], verified: false, waited_ms: 0 };
  const liveGroups = () => [...new Set(registry.live(list()).map((entry) => entry.pgid))];

  for (const pgid of liveGroups()) {
    record.term.push({ pgid, result: signalGroup(pgid, "SIGTERM", kill) });
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && registry.live(list()).length > 0) {
    await sleep(pollMs);
  }
  let remaining = registry.live(list());
  if (remaining.length > 0) {
    for (const pgid of new Set(remaining.map((entry) => entry.pgid))) {
      record.kill.push({ pgid, result: signalGroup(pgid, "SIGKILL", kill) });
    }
    for (const entry of remaining) {
      try {
        kill(entry.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    const killDeadline = Date.now() + graceMs;
    while (Date.now() < killDeadline && registry.live(list()).length > 0) {
      await sleep(pollMs);
    }
    remaining = registry.live(list());
  }
  record.remaining = remaining.map(({ pid, pgid, command }) => ({ pid, pgid, command: command.slice(0, 200) }));
  record.verified = remaining.length === 0;
  record.waited_ms = Date.now() - started;
  return record;
}

// Worker-side heartbeat and orphan guard. The supervisor watches the heartbeat;
// if the supervisor disappears (the worker is reparented), onOrphan runs once.
export function createWorkerProgress({
  file = process.env.EDGER_RUNTIME_COST_PROGRESS,
  intervalMs = 1000,
  onOrphan = () => {},
} = {}) {
  if (!file) {
    throw new Error("EDGER_RUNTIME_COST_PROGRESS is not set; run the worker under the supervisor");
  }
  const initialParent = process.ppid;
  let orphaned = false;
  const state = {
    pid: process.pid,
    parent_pid: initialParent,
    started_at_ms: Date.now(),
    heartbeat_at_ms: Date.now(),
    phase: null,
    // Active deadlines, outermost first; the supervisor enforces each exactly.
    deadlines: [],
    owned: [],
    note: null,
  };
  const write = () => writeJsonAtomic(file, state);
  write();
  const timer = setInterval(() => {
    if (!orphaned && process.ppid !== initialParent) {
      orphaned = true;
      onOrphan();
    }
    state.heartbeat_at_ms = Date.now();
    write();
  }, intervalMs);
  timer.unref();
  return {
    update(patch) {
      Object.assign(state, patch, { heartbeat_at_ms: Date.now() });
      write();
    },
    stop() {
      clearInterval(timer);
    },
    get state() {
      return state;
    },
  };
}

export function directoryBytes(directory) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // Removed between listing and stat (atomic rename).
      }
    }
  }
  return total;
}

export function freeBytes(directory) {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}
