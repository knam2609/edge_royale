#!/usr/bin/env node
// Browser validation and measurement worker for the Edger v2 runtime-cost harness.
//
// Runs from a stage made by edger-v2-runtime-cost-stage.mjs, under
// edger-v2-runtime-cost-supervisor.mjs (which sets EDGER_RUNTIME_COST_OUT and
// EDGER_RUNTIME_COST_PROGRESS). It verifies every staged file against
// MANIFEST.json before launching anything, serves the stage from an in-process
// static server, launches the pinned Chromium build (the headless shell, or
// headed Chrome for Testing when config.browser.headless is false, with the
// configured launch arguments), records GPU feature status and an unemulated
// display probe, and runs the predeclared plan in config.json:
//
// - smoke: the untouched live entry point and the diagnostic page, both
//   viewports, page errors, screenshots and (headed) native visible captures;
// - jump: a deterministic synthetic-clock elapsed jump (multi-tick frame,
//   following-frame catch-up, terminal frame with no-op iterations);
// - fast_forward: bank replay checks and all full-match conditions, including
//   the live-v1 baselines, with collectors off/on, in two fresh contexts per
//   viewport;
// - real_time: the predeclared rAF overtime checks, one fresh context each.
//
// With --measure full|dry_run it runs config.measurement instead: the Node
// paths as bounded child processes (existing-method invocations, complete-path
// timing, paired Node GC windows), then the rendered matrix and the paired
// browser GC windows. The dry run takes the configured reductions and never
// counts as measurement. Measurement records an incomplete condition and
// continues; there are no retries.
//
// Headed pages get a per-page fullscreen window (the browser runs with
// --kiosk). Each rendered real-time match first passes a settled display
// admission (fullscreen at the native bounds, no inset, exact viewport and
// scale, visible, Chromium frontmost) and is then monitored at every poll.
//
// Every browser-control call is bounded. In validation any failure stops
// admission; the remaining items are recorded as not run. There are no
// automatic retries. Reports, item records and sample chunks are written as
// they are produced, so a stopped run keeps its partial output.
//
// Deadlines are published to the supervisor, which enforces them exactly from
// outside this process and the browser: each item has its declared item
// deadline, and while a match (startMatch through the final result) or bank
// check runs, its declared deadline is published inside the item's. Page setup
// and context cleanup fall under the item deadline, never a match's. The
// worker does not soft-stop a match at its deadline; the supervisor stops the
// run, and the worker's TERM handler records the in-flight item as incomplete.

import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";

import {
  RUNTIME_COST_BOUNDARIES,
  RUNTIME_COST_TABLE_COLUMNS,
  RUNTIME_COST_TABLE_NAMES,
  summarizeRuntimeCostTables,
} from "./edger-v2-runtime-cost-collectors.js";
import { completePathCoverageProblems, summarizeHeapProfile } from "./edger-v2-runtime-cost-measure.mjs";
import {
  createTreeCpuTracker,
  createWorkerProgress,
  listProcesses,
  writeJsonAtomic,
} from "./edger-v2-runtime-cost-process.mjs";

// v2: headed display setup and checks, live-v1 baseline matches.
export const BROWSER_VALIDATION_SCHEMA = "edger_v2_runtime_cost_browser_validation_v2";
export const V1_BASELINE_KIND = "v1_baseline";
const STAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TICK_MS = 50;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};
const SERVED = [
  "index.html",
  "runtime-cost.html",
  "src/",
  "data/",
  "scripts/edger-v2-runtime-cost-adapter.js",
  "scripts/edger-v2-runtime-cost-collectors.js",
  "scripts/edger-v2-runtime-cost-browser.js",
];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared by staging, freeze admission and worker preflight. Never descend into
// or hash through links, including links whose targets are inside the stage.
export function inventoryFiles(directory) {
  const files = [];
  const unsupported = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = inventoryFiles(full);
      files.push(...nested.files);
      unsupported.push(...nested.unsupported);
    } else if (entry.isFile()) {
      files.push(full);
    } else {
      const kind = entry.isSymbolicLink() ? "symbolic link"
        : entry.isFIFO() ? "FIFO" : entry.isSocket() ? "socket" : "device or special file";
      unsupported.push({ file: full, kind });
    }
  }
  return { files, unsupported };
}

// Digest of a pinned browser installation, shared by staging, freeze admission
// and worker preflight. Regular files are hashed; links are recorded by their
// target text and never followed (a macOS .app framework contains a few);
// any other entry is unsupported. The main executable of a headed .app is a
// small launcher, so its hash alone does not pin the build.
export function browserTreeDigest(root) {
  const entries = [];
  const unsupported = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        entries.push([relative, "file", sha256Hex(fs.readFileSync(full))]);
      } else if (entry.isSymbolicLink()) {
        entries.push([relative, "link", fs.readlinkSync(full)]);
      } else {
        unsupported.push(relative);
      }
    }
  };
  walk(root);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    sha256: sha256Hex(JSON.stringify(entries)),
    files: entries.filter(([, kind]) => kind === "file").length,
    links: entries.filter(([, kind]) => kind === "link").length,
    unsupported: unsupported.sort(),
  };
}

// Problems with a pinned browser: its executable and whole install tree.
export function browserPinProblems(pin, label = "pinned browser") {
  if (!pin || typeof pin.executable !== "string" || typeof pin.install_dir !== "string") {
    return [`${label} is not recorded`];
  }
  if (!fs.existsSync(pin.executable) || !fs.statSync(pin.executable).isFile()) {
    return [`${label} executable ${pin.executable} is missing`];
  }
  const problems = [];
  const actual = sha256Hex(fs.readFileSync(pin.executable));
  if (actual !== pin.sha256) {
    problems.push(`${label} executable ${pin.executable} hashes to ${actual}, not ${pin.sha256}`);
  }
  if (!path.resolve(pin.executable).startsWith(path.resolve(pin.install_dir) + path.sep)) {
    problems.push(`${label} executable is outside its install tree ${pin.install_dir}`);
  } else {
    const tree = browserTreeDigest(pin.install_dir);
    if (tree.unsupported.length > 0) {
      problems.push(`${label} install tree has unsupported entries: ${tree.unsupported.join(", ")}`);
    }
    if (tree.sha256 !== pin.tree_sha256) {
      problems.push(`${label} install tree ${pin.install_dir} hashes to ${tree.sha256}, not ${pin.tree_sha256}`);
    }
  }
  return problems;
}

// Check each component on every request, including links added after preflight.
// Open the leaf without following it and stream that same descriptor. Parent
// replacement during this check is outside the concurrent-tampering contract.
function openStageFile(base, relative) {
  let descriptor = null;
  try {
    const parts = relative.split("/");
    let full = base;
    for (let index = 0; index < parts.length; index += 1) {
      full = path.join(full, parts[index]);
      const entry = fs.lstatSync(full);
      if (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
        return null;
      }
    }
    descriptor = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(descriptor).isFile()) {
      fs.closeSync(descriptor);
      return null;
    }
    return descriptor;
  } catch {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    return null;
  }
}

// One published deadline: the supervisor stops the run once Date.now() is past
// started_at_ms + deadline_ms.
export function deadlineRecord(id, kind, deadlineMs, startedAtMs = Date.now()) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`deadline ${id} must be a positive duration, not ${deadlineMs}`);
  }
  return { id, kind, started_at_ms: startedAtMs, deadline_ms: deadlineMs };
}

// Serves only the page closure and data, with cross-origin isolation so the
// page's performance.now() is not coarsened to 100 µs.
export function startStageServer(root) {
  const base = fs.realpathSync(root);
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    } catch {
      response.statusCode = 400;
      response.end("Bad request");
      return;
    }
    const full = path.resolve(base, `.${pathname}`);
    const relative = path.relative(base, full).split(path.sep).join("/");
    const allowed = !relative.startsWith("..") && !path.isAbsolute(relative) &&
      SERVED.some((entry) => (entry.endsWith("/") ? relative.startsWith(entry) : relative === entry));
    const descriptor = request.method === "GET" && allowed ? openStageFile(base, relative) : null;
    if (descriptor === null) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    response.setHeader("Content-Type", CONTENT_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");
    // pipeline destroys the file stream (and closes its descriptor) when the
    // client disconnects or either stream fails. The response is destroyed
    // too; consume the error without writing to that closed connection.
    pipeline(fs.createReadStream(full, { fd: descriptor }), response, () => {});
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

class ControlTimeout extends Error {
  constructor(label, ms) {
    super(`browser control call ${label} exceeded ${ms} ms`);
    this.code = "control_timeout";
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ControlTimeout(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The deterministic controlled elapsed jump, for a match ending at
// terminalTick. Lag arithmetic is exact: 1000-ms frames add 20 ticks; 16 ms
// adds none; 400 ms drains 8 ticks (residual 16); 130 ms catches up 2 (residual
// 46); 50-ms frames add one each; the final 500 ms frame loops 10 times but can
// only advance 3 ticks before the match ends.
export function jumpSchedule(terminalTick) {
  if (terminalTick < 1200) {
    throw new Error(`jump condition must last at least 1200 ticks, not ${terminalTick}`);
  }
  return [
    { elapsed_ms: 1000, until_tick: 1000 },
    { elapsed_ms: 16, frames: 1 },
    { elapsed_ms: 400, frames: 1 },
    { elapsed_ms: 130, frames: 1 },
    { elapsed_ms: 1000, until_tick: terminalTick - 60 },
    { elapsed_ms: 50, until_tick: terminalTick - 3 },
    { elapsed_ms: 500, frames: 1 },
    { elapsed_ms: 50, frames: 1 },
  ];
}

// Expected frames of jumpSchedule, checked against the collected frame rows.
export function checkJumpFrames(frames, terminalTick) {
  const columns = RUNTIME_COST_TABLE_COLUMNS.frames;
  const at = (row, name) => row[columns.indexOf(name)];
  const find = (interval) => frames.findIndex((row) => at(row, "interval_ms") === interval);
  const expectFrame = (index, expected) => {
    const row = frames[index];
    if (!row) {
      return { ok: false, expected, actual: null };
    }
    const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, at(row, name)]));
    return { ok: isDeepStrictEqual(actual, expected), expected, actual };
  };
  const idle = find(16);
  const jump = find(400);
  const terminal = find(500);
  const checks = {
    zero_tick_frame: expectFrame(idle, {
      pre_drain_lag_ms: 16, residual_lag_ms: 16, loop_iterations: 0, tick_advances: 0,
    }),
    multi_tick_frame: expectFrame(jump, {
      pre_drain_lag_ms: 416, residual_lag_ms: 16, loop_iterations: 8, tick_advances: 8,
    }),
    following_catch_up: expectFrame(jump + 1, {
      interval_ms: 130, pre_drain_lag_ms: 146, residual_lag_ms: 46, loop_iterations: 2, tick_advances: 2,
    }),
    terminal_no_op_iterations: expectFrame(terminal, {
      pre_drain_lag_ms: 546, residual_lag_ms: 46, loop_iterations: 10, tick_advances: 3, tick_after: terminalTick,
    }),
  };
  const advanced = frames.reduce((sum, row) => sum + at(row, "tick_advances"), 0);
  checks.total_advances = { ok: advanced === terminalTick, expected: terminalTick, actual: advanced };
  checks.terminal_is_last = { ok: terminal === frames.length - 1, expected: frames.length - 1, actual: terminal };
  return { passed: Object.values(checks).every((check) => check.ok), checks };
}

function firstScheduleDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      return { index, expected: expected[index] ?? null, actual: actual[index] ?? null };
    }
  }
  return null;
}

// Compare a page's final record (and collected rows) with the Node reference.
export function checkMatchAgainstExpectation({ final, expected, rows = null }) {
  const scheduleDifference = final ? firstScheduleDifference(expected.schedule, final.schedule) : null;
  const checks = final
    ? {
        status: final.status === "complete",
        result: isDeepStrictEqual(final.result, expected.result),
        terminal_tick: final.terminal_tick === expected.result.tick,
        overtime_start_tick: final.overtime_start_tick === expected.overtime_start_tick,
        schedule: scheduleDifference === null,
        schedule_sha256: final.schedule_sha256 === expected.schedule_sha256,
        counts: isDeepStrictEqual(final.counts, expected.counts),
        decision_kinds: isDeepStrictEqual(final.decision_kinds, expected.decision_kinds),
        opponent_decisions: final.opponent_decisions === expected.opponent_decisions,
        action_stream_hash: final.action_stream_hash === expected.action_stream_hash,
        final_state_hash: final.final_state_hash === expected.final_state_hash,
      }
    : { status: false };
  if (final && rows) {
    const frames = RUNTIME_COST_TABLE_COLUMNS.frames;
    const advances = rows.frames.reduce((sum, row) => sum + row[frames.indexOf("tick_advances")], 0);
    // A live-v1 baseline fills only the v1 candidate table; a v2 match only the v2 one.
    const v1 = expected.kind === V1_BASELINE_KIND;
    const candidateRows = v1 ? rows.v1_candidate_decisions : rows.candidate_decisions;
    const otherRows = v1 ? rows.candidate_decisions : rows.v1_candidate_decisions;
    checks.collector_coverage =
      candidateRows.length === expected.counts.decisions &&
      otherRows.length === 0 &&
      rows.opponent_decisions.length === expected.opponent_decisions &&
      rows.ticks.length === expected.result.tick &&
      advances === expected.result.tick &&
      Object.values(final.collector_refused ?? {}).every((count) => count === 0);
    if (!v1) {
      const delayColumn = RUNTIME_COST_TABLE_COLUMNS.candidate_decisions.indexOf("delay_head_ms");
      const delayMeasured = rows.candidate_decisions.map((row) => Number.isFinite(row[delayColumn]));
      checks.delay_head_boundary = expected.controller === "learned"
        ? delayMeasured.every(Boolean)
        : delayMeasured.every((measured) => !measured);
    }
  }
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    schedule_difference: scheduleDifference,
  };
}

// Console errors are page failures, except the one request headed Chrome makes
// for the undeclared /favicon.ico (the headless shell does not): exactly the
// missing-resource 404 at that local URL. Anything else, including an error that
// merely mentions a favicon, is retained with its source URL.
export const FAVICON_MISSING_RESOURCE = "Failed to load resource: the server responded with a status of 404 (Not Found)";
export function retainedConsoleError({ type, text, url }, faviconUrl) {
  if (type !== "error") {
    return null;
  }
  if (url === faviconUrl && text === FAVICON_MISSING_RESOURCE) {
    return null;
  }
  return `console: ${text}${url ? ` (${url})` : ""}`;
}

// Settled display admission for one rendered page. window is CDP
// Browser.getWindowBounds (null without per-page window setup), page is the
// page's own geometry (pageGeometry below), frontmostPid the
// macOS frontmost application and capture the native visible-content capture
// size. Headed pages must be fullscreen at the native screen bounds with no
// content inset, at the exact CSS viewport and device scale, visible and in
// front; the canvas backing store must follow the device scale. Playwright
// emulates document.hasFocus(), so focus is the frontmost application.
export function checkDisplayGeometry({ window = null, page, frontmostPid = null, capture = null },
  { viewport, deviceScaleFactor, screen = null, chromiumPid = null }) {
  const same = (actual, expected) => isDeepStrictEqual(actual, expected);
  const checks = {
    css_viewport: same(page?.inner, [viewport.width, viewport.height]),
    visual_viewport: same(page?.visual, [viewport.width, viewport.height, 1]),
    device_pixel_ratio: page?.device_pixel_ratio === deviceScaleFactor,
    visible: page?.visibility === "visible",
  };
  if (page?.canvas_backing && page?.canvas_css) {
    checks.canvas_backing = same(page.canvas_backing,
      page.canvas_css.map((size) => Math.max(1, Math.round(Math.max(1, Math.round(size)) * deviceScaleFactor))));
  }
  if (screen) {
    const bounds = window?.bounds ?? {};
    checks.window_fullscreen = bounds.windowState === "fullscreen";
    checks.window_bounds = bounds.left === 0 && bounds.top === 0 &&
      bounds.width === screen.width && bounds.height === screen.height;
    checks.no_content_inset = same(page?.origin, [0, 0]) && same(page?.outer, [screen.width, screen.height]);
    checks.frontmost = chromiumPid !== null && frontmostPid === chromiumPid;
  }
  if (capture) {
    checks.capture_covers_viewport = capture.width >= viewport.width * deviceScaleFactor &&
      capture.height >= viewport.height * deviceScaleFactor;
  }
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failed: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
  };
}

// Window and viewport geometry as the page sees it; passed to page.evaluate,
// so it must stay self-contained. With viewport emulation screen.* reports the
// emulated viewport, and Playwright emulates document.hasFocus().
export function pageGeometry() {
  const canvas = document.getElementById("game");
  const rect = canvas?.getBoundingClientRect();
  return {
    device_pixel_ratio: window.devicePixelRatio,
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    origin: [window.screenX, window.screenY],
    visual: window.visualViewport
      ? [window.visualViewport.width, window.visualViewport.height, window.visualViewport.scale]
      : null,
    screen: [screen.width, screen.height],
    visibility: document.visibilityState,
    focused_emulated: document.hasFocus(),
    canvas_backing: canvas ? [canvas.width, canvas.height] : null,
    canvas_css: rect ? [rect.width, rect.height] : null,
  };
}

// PID of the macOS frontmost application, or null. Bounded and asynchronous so
// the worker's polling never blocks on it.
export function frontmostPid({ timeoutMs = 2000 } = {}) {
  if (process.platform !== "darwin") {
    return Promise.resolve(null);
  }
  const run = (args) => new Promise((resolve) => {
    execFile("lsappinfo", args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? null : stdout.trim()));
  });
  return run(["front"]).then((asn) => (asn ? run(["info", "-only", "pid", asn]) : null))
    .then((text) => {
      const match = /"pid"=(\d+)/.exec(text ?? "");
      return match ? Number(match[1]) : null;
    });
}

// PNG width/height from its IHDR chunk.
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
    throw new Error("not a PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Verify every staged regular file, reject unsupported/unlisted entries, and
// check the tool binaries and live-entry pins before launching the browser.
export function verifyStage(stage = STAGE) {
  const problems = [];
  const inventory = inventoryFiles(stage);
  for (const { file, kind } of inventory.unsupported) {
    problems.push(`unsupported ${kind} ${path.relative(stage, file)}`);
  }
  const onDisk = new Set(inventory.files.map((file) => path.relative(stage, file)));
  if (!onDisk.has("MANIFEST.json")) {
    problems.push("missing MANIFEST.json");
    return { manifest: null, problems };
  }
  const manifest = readJson(path.join(stage, "MANIFEST.json"));
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const full = path.join(stage, relative);
    if (!onDisk.has(relative)) {
      problems.push(`missing ${relative}`);
    } else if (sha256Hex(fs.readFileSync(full)) !== digest) {
      problems.push(`changed ${relative}`);
    }
  }
  for (const relative of onDisk) {
    if (!(relative in manifest.files) && !["MANIFEST.json", "SHA256SUMS"].includes(relative)) {
      problems.push(`unlisted ${relative}`);
    }
  }
  if (sha256Hex(JSON.stringify(manifest.files)) !== manifest.closure_sha256) {
    problems.push("manifest closure hash mismatch");
  }
  for (const [relative, pin] of Object.entries(manifest.live_sources)) {
    if (manifest.files[relative] !== pin) {
      problems.push(`live ${relative} is not the pinned source`);
    }
  }
  if (manifest.files["config.json"] !== manifest.config_sha256) {
    problems.push("config hash mismatch");
  }
  if (process.version !== manifest.node.version || sha256Hex(fs.readFileSync(process.execPath)) !== manifest.node.sha256) {
    problems.push(`node ${process.version} at ${process.execPath} is not the staged Node`);
  }
  problems.push(...browserPinProblems(manifest.playwright?.browser));
  let config = null;
  try {
    config = onDisk.has("config.json") ? readJson(path.join(stage, "config.json")) : null;
  } catch {
    problems.push("config.json is not valid JSON");
  }
  if (config && config.browser?.engine !== manifest.playwright?.browser?.engine) {
    problems.push(`config browser ${config.browser?.engine} is not the pinned ${manifest.playwright?.browser?.engine}`);
  }
  return { manifest, problems };
}

export function buildPlan(config, expectations) {
  const byKey = new Map(expectations.full_matches.map((entry) =>
    [`${entry.model}|${entry.controller}|${entry.candidate_actor}`, entry]));
  const expectedFor = ({ model, controller, candidate_actor: actor }) => {
    const entry = byKey.get(`${model}|${controller}|${actor}`);
    if (!entry) {
      throw new Error(`no Node expectation for ${model} ${controller} ${actor}`);
    }
    return entry;
  };
  const onOff = (collectors) => (collectors ? "on" : "off");
  const items = [];
  for (const viewport of config.smoke.viewports) {
    items.push({ phase: "smoke", id: `smoke-${viewport}`, viewport });
  }
  const jumpExpected = expectedFor(config.jump);
  for (const collectors of config.jump.collectors) {
    items.push({
      phase: "jump",
      id: `jump-${jumpExpected.id}-${config.jump.viewport}-${onOff(collectors)}`,
      viewport: config.jump.viewport,
      expected: jumpExpected,
      collectors,
      synthetic: jumpSchedule(jumpExpected.result.tick),
      wall_cap_s: config.jump.match_wall_cap_s,
    });
  }
  for (const viewport of config.fast_forward.viewports) {
    for (let context = 1; context <= config.fast_forward.contexts_per_viewport; context += 1) {
      const matches = [];
      const baselines = config.fast_forward.v1_baselines ? expectations.v1_baselines ?? [] : [];
      if (config.fast_forward.v1_baselines && baselines.length === 0) {
        throw new Error("config requires live-v1 baselines but the expectations have none");
      }
      for (const expected of [...expectations.full_matches, ...baselines]) {
        for (const collectors of config.fast_forward.collectors) {
          matches.push({
            id: `ff-${expected.id}-${viewport}-ctx${context}-${onOff(collectors)}`,
            expected,
            collectors,
          });
        }
      }
      items.push({ phase: "fast_forward", id: `ff-${viewport}-ctx${context}`, viewport, matches });
    }
  }
  for (const condition of config.real_time.conditions) {
    const expected = expectedFor(condition);
    for (const collectors of config.real_time.collectors) {
      for (let page = 1; page <= config.real_time.pages; page += 1) {
        items.push({
          phase: "real_time",
          id: `rt-${expected.id}-${condition.viewport}-${onOff(collectors)}-page${page}`,
          viewport: condition.viewport,
          expected,
          collectors,
          wall_cap_s: config.real_time.match_wall_cap_s,
        });
      }
    }
  }
  return items.sort((left, right) => config.order.indexOf(left.phase) - config.order.indexOf(right.phase));
}

export function plannedCoverage(plan) {
  const matches = (phase) => plan.filter((item) => item.phase === phase)
    .reduce((sum, item) => sum + (item.matches?.length ?? 1), 0);
  const v1Matches = plan.filter((item) => item.phase === "fast_forward")
    .reduce((sum, item) => sum + item.matches.filter((match) => match.expected.kind === V1_BASELINE_KIND).length, 0);
  return {
    smoke_viewports: plan.filter((item) => item.phase === "smoke").length,
    jump_matches: matches("jump"),
    fast_forward_contexts: plan.filter((item) => item.phase === "fast_forward").length,
    fast_forward_matches: matches("fast_forward"),
    fast_forward_v1_baseline_matches: v1Matches,
    bank_checks: plan.filter((item) => item.phase === "fast_forward").length,
    real_time_matches: matches("real_time"),
  };
}

function safeExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim();
  } catch (error) {
    return `unavailable: ${error.message.split("\n")[0]}`;
  }
}

function swapActivity() {
  const text = safeExec("vm_stat", []);
  const pick = (name) => {
    const match = new RegExp(`${name}:\\s+(\\d+)`).exec(text);
    return match ? Number(match[1]) : null;
  };
  return { swapins: pick("Swapins"), swapouts: pick("Swapouts"), pageouts: pick("Pageouts") };
}

function hostSnapshot() {
  return {
    at: new Date().toISOString(),
    load_average: os.loadavg(),
    free_memory_bytes: os.freemem(),
    swap: safeExec("sysctl", ["-n", "vm.swapusage"]),
    swap_activity: swapActivity(),
    memory_pressure_level: safeExec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    power: safeExec("pmset", ["-g", "ps"]),
  };
}

// v2: windows must stop at their admitted endpoint, browser GC pairs need an
// admitted partner with equal endpoints and hashes, and Node GC windows need
// full, matching coverage.
export const MEASUREMENT_SCHEMA = "edger_v2_runtime_cost_measurement_v2";
export const MEASURE_MODES = Object.freeze(["full", "dry_run"]);
const BROWSER_PHASES = Object.freeze(["smoke", "jump", "fast_forward", "real_time", "rendered", "browser_gc"]);

// Node expectation for a rendered condition: a v2 full match, or a live-v1 baseline.
export function expectationFor(expectations, { kind = "v2", model, controller, candidate_actor: actor }) {
  const entry = kind === V1_BASELINE_KIND
    ? (expectations.v1_baselines ?? []).find((candidate) => candidate.candidate_actor === actor)
    : expectations.full_matches.find((candidate) =>
      candidate.model === model && candidate.controller === controller && candidate.candidate_actor === actor);
  if (!entry) {
    throw new Error(`no Node expectation for ${kind} ${model ?? ""} ${controller ?? ""} ${actor}`);
  }
  return entry;
}

// The ordered measurement plan: Node paths first (no browser running), then
// the rendered matrix and the paired browser GC windows. The dry run takes the
// configured reductions of the same paths and can never count as measurement.
export function buildMeasurementPlan(config, expectations, mode) {
  if (!MEASURE_MODES.includes(mode)) {
    throw new Error(`unknown measurement mode ${mode}`);
  }
  const m = config.measurement;
  const dry = mode === "dry_run" ? m.dry_run : null;
  const items = [];
  const runs = dry?.existing_method?.models ?? Object.keys(config.models);
  const invocations = dry?.existing_method?.invocations ?? m.existing_method.invocations;
  for (let invocation = 1; invocation <= invocations; invocation += 1) {
    for (const model of runs) {
      items.push({ phase: "existing_method", id: `existing-${model}-${invocation}`, model, invocation });
    }
  }
  items.push({ phase: "complete_path", id: "complete-path", ...m.complete_path, ...(dry?.complete_path ?? {}) });
  const nodePairs = dry ? m.node_gc.pairs.slice(0, dry.node_gc.pairs) : m.node_gc.pairs;
  for (const pair of nodePairs) {
    for (const trace of m.node_gc.order) {
      items.push({
        phase: "node_gc",
        id: `node-gc-${pair.model}-${pair.controller}-${trace}`,
        model: pair.model,
        controller: pair.controller,
        trace,
        states: dry?.node_gc?.states ?? null,
      });
    }
  }
  const conditions = dry
    ? dry.rendered.conditions.map((id) => m.rendered.conditions.find((condition) => condition.id === id))
    : m.rendered.conditions;
  for (const condition of conditions) {
    if (!condition) {
      throw new Error("a dry-run rendered condition is not in the rendered matrix");
    }
    items.push({
      phase: "rendered",
      id: `rendered-${condition.id}`,
      condition,
      viewport: condition.viewport,
      expected: expectationFor(expectations, condition),
      window_ticks: dry?.rendered?.window_ticks ?? null,
    });
  }
  const gcConditions = dry ? m.browser_gc.conditions.slice(0, dry.browser_gc.conditions) : m.browser_gc.conditions;
  for (const condition of gcConditions) {
    for (const trace of m.browser_gc.order) {
      items.push({
        phase: "browser_gc",
        id: `browser-gc-${condition.id}-${trace}`,
        condition,
        viewport: condition.viewport,
        expected: expectationFor(expectations, condition),
        trace,
        window_ticks: dry?.browser_gc?.window_ticks ?? m.browser_gc.window_ticks,
      });
    }
  }
  return items;
}

// The admitted endpoint of a window: the requested tick, or the expected match
// end if that comes first.
export function windowEndpoint(expected, windowTicks) {
  return Math.min(windowTicks, expected.result.tick);
}

// A windowed match against the Node expectation. It must end exactly at its
// admitted endpoint: the page checks max_ticks only after draining a whole
// frame, so a catch-up burst can overshoot, and an overshoot is incomplete
// (the uncapped drain loop is unchanged). Its decisions must be exactly the
// expected schedule up to the tick it reached.
export function checkWindowAgainstExpectation({ final, expected, windowTicks }) {
  if (!Number.isInteger(windowTicks) || windowTicks <= 0) {
    throw new Error("a window needs a positive integer windowTicks");
  }
  const admitted = windowEndpoint(expected, windowTicks);
  const endpoint = { requested: windowTicks, admitted, reached: final?.terminal_tick ?? null };
  if (!final) {
    return { passed: false, checks: { status: false }, schedule_difference: null, endpoint };
  }
  const prefix = expected.schedule.filter((row) => row.tick <= final.terminal_tick);
  const difference = firstScheduleDifference(prefix, final.schedule);
  const checks = {
    status: expected.result.tick <= windowTicks
      ? final.status === "complete" && isDeepStrictEqual(final.result, expected.result)
      : final.status === "stopped" && final.stop_reason === "max_ticks",
    endpoint: final.terminal_tick === admitted,
    schedule_prefix: difference === null,
    counts: final.counts?.decisions === prefix.length,
  };
  return { passed: Object.values(checks).every(Boolean), checks, schedule_difference: difference, endpoint };
}

// Pair admission for paired browser GC windows, decided when the later window
// of the frozen order finishes: its partner must exist and have passed, both
// must end at the same admitted endpoint, and their action-stream and final
// state hashes must be equal. Anything else is an incomplete pair.
export function admitBrowserGcPair({ entry, partner }) {
  const problems = [];
  if (!partner) {
    problems.push("missing_partner");
  } else {
    if (partner.window_passed !== true) {
      problems.push("partner_incomplete");
    }
    if (entry.window_passed !== true) {
      problems.push("window_incomplete");
    }
    if (!Number.isInteger(entry.admitted_endpoint) || partner.admitted_endpoint !== entry.admitted_endpoint ||
      partner.terminal_tick !== entry.admitted_endpoint || entry.terminal_tick !== entry.admitted_endpoint) {
      problems.push("unequal_endpoint");
    }
    if (!entry.action_stream_hash || partner.action_stream_hash !== entry.action_stream_hash ||
      !entry.final_state_hash || partner.final_state_hash !== entry.final_state_hash) {
      problems.push("hash_mismatch");
    }
  }
  return {
    complete: problems.length === 0,
    problems,
    ids: [partner?.id ?? null, entry.id],
    endpoint: entry.admitted_endpoint ?? null,
    terminal_ticks: [partner?.terminal_tick ?? null, entry.terminal_tick ?? null],
  };
}

// Pair admission for paired Node GC windows, decided when the later window of
// the frozen order finishes: both must have full coverage and the same
// planned and covered combinations before they count as paired allocation
// evidence.
export function admitNodeGcPair({ entry, partner }) {
  const problems = [];
  if (!partner) {
    problems.push("missing_partner");
  } else {
    if ((partner.coverage_problems ?? [null]).length !== 0) {
      problems.push("partner_incomplete");
    }
    if ((entry.coverage_problems ?? [null]).length !== 0) {
      problems.push("window_incomplete");
    }
    if (!entry.plan_sha256 || partner.plan_sha256 !== entry.plan_sha256) {
      problems.push("plan_differs");
    }
    if (!entry.coverage_sha256 || partner.coverage_sha256 !== entry.coverage_sha256) {
      problems.push("coverage_differs");
    }
  }
  return { complete: problems.length === 0, problems, ids: [partner?.id ?? null, entry.id] };
}

// GC events of a Chromium trace by name, split into renderer-main-thread and
// other threads, with count/total/max durations.
export function summarizeChromeTrace(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents ?? [];
  const main = new Set(events
    .filter((event) => event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain")
    .map((event) => `${event.pid}|${event.tid}`));
  const gc = {};
  for (const event of events) {
    if (event.ph !== "X" || !/GC|Scaveng|MarkCompact/.test(event.name ?? "")) {
      continue;
    }
    const key = `${main.has(`${event.pid}|${event.tid}`) ? "main" : "other"}:${event.name}`;
    const entry = gc[key] ?? { count: 0, sum_ms: 0, max_ms: 0 };
    const ms = (event.dur ?? 0) / 1000;
    entry.count += 1;
    entry.sum_ms = Math.round((entry.sum_ms + ms) * 1e4) / 1e4;
    entry.max_ms = Math.max(entry.max_ms, Math.round(ms * 1e4) / 1e4);
    gc[key] = entry;
  }
  return { events: events.length, renderer_main_threads: main.size, gc_events: gc };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const outRoot = process.env.EDGER_RUNTIME_COST_OUT;
  if (!outRoot) {
    throw new Error("EDGER_RUNTIME_COST_OUT is not set; run under the supervisor");
  }
  const measureMode = argValue("--measure");
  if (measureMode !== null && !MEASURE_MODES.includes(measureMode)) {
    throw new Error(`--measure must be ${MEASURE_MODES.join(" or ")}`);
  }
  const out = path.join(outRoot, "worker");
  fs.mkdirSync(out, { recursive: true });
  let shuttingDown = null;
  let browser = null;
  let server = null;
  let activeChild = null;
  const report = {
    schema_version: measureMode ? MEASUREMENT_SCHEMA : BROWSER_VALIDATION_SCHEMA,
    mode: measureMode ?? "validation",
    status: "running",
    passed: false,
    stop_reason: null,
    started_at: new Date().toISOString(),
    updated_at: null,
    stage: { dir: STAGE },
    boundaries: {
      ...RUNTIME_COST_BOUNDARIES,
      synthetic_clock:
        "fast-forward and jump runs call the production frame function with scripted timestamps " +
        "while rAF is disabled; their frame timings carry no frame-pacing claim",
      chromium_tree_cpu:
        "ps cputime over the Chromium browser process and its descendants (renderer, GPU, utility), one " +
        "page active, sampled at match start, at every real-time poll and at the end; processes present at " +
        "the start count from their cputime then, later ones from zero; an exit between samples loses its " +
        "remaining CPU, so lower_bound marks a total that omits it; excludes the worker and supervisor",
      worker_cpu_s: "process.cpuUsage of the worker Node process (control, polling, writes); not browser CPU",
      export:
        "page-side preparation of drained sample chunks (export.prep_ms_*); serialization of the returned " +
        "value to the worker is not included",
      display_monitor:
        "worker-side checks each real-time poll: CDP window bounds and the macOS frontmost application " +
        "(lsappinfo), plus the page's visibility, device scale and viewport from its poll; their round " +
        "trips are recorded as display.monitor overhead; any violation stops the match as incomplete",
      long_tasks: "page PerformanceObserver longtask entries while playing (collectors on only), bounded",
    },
    environment: null,
    coverage: { planned: null, completed: {} },
    items: [],
    matches: [],
    not_run: [],
    failures: [],
  };
  if (measureMode) {
    report.measurements = { existing_method: [], complete_path: null, node_gc: [], rendered: [], browser_gc: [] };
    report.incomplete = [];
  }
  const writeReport = () => {
    report.updated_at = new Date().toISOString();
    writeJsonAtomic(path.join(out, "report.json"), report);
  };

  const progress = createWorkerProgress({ onOrphan: () => shutdown("supervisor_lost") });
  let plan = [];
  let currentIndex = -1;

  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = reason;
    report.status = "stopped";
    report.stop_reason = reason;
    if (currentIndex >= 0 && currentIndex < plan.length) {
      // The in-flight item (and the deadlines active when the stop arrived) is
      // incomplete; later items never ran. Chunks already written are kept.
      report.incomplete_item = { item: plan[currentIndex].id, deadlines: progress.state.deadlines };
      report.not_run = plan.slice(currentIndex + 1).map((later) => later.id);
    }
    writeReport();
    progress.update({ phase: "stopped", note: reason });
    activeChild?.kill("SIGTERM");
    try {
      await withTimeout(browser?.close() ?? Promise.resolve(), 5000, "browser.close");
    } catch {
      // The supervisor kills Chromium's group if this fails.
    }
    server?.server.close();
    process.exit(reason === "terminated" ? 143 : 1);
  }
  process.on("SIGTERM", () => shutdown("terminated"));
  process.on("SIGINT", () => shutdown("interrupted"));

  const failPreflight = (problems) => {
    report.status = "failed";
    report.stop_reason = "preflight";
    report.failures.push({ phase: "preflight", problems: problems.slice(0, 50), count: problems.length });
    writeReport();
    progress.update({ phase: "failed" });
    process.exit(1);
  };

  progress.update({ phase: "preflight" });
  const { manifest, problems } = verifyStage();
  report.stage = {
    dir: STAGE,
    closure_sha256: manifest?.closure_sha256 ?? null,
    manifest_sha256: manifest ? sha256Hex(fs.readFileSync(path.join(STAGE, "MANIFEST.json"))) : null,
    config_sha256: manifest?.config_sha256 ?? null,
    git: manifest?.git ?? null,
  };
  if (problems.length > 0) {
    failPreflight(problems);
  }
  const config = readJson(path.join(STAGE, "config.json"));
  const declared = [config.deadlines?.item_s, config.deadlines?.bank_check_s, config.smoke?.preview?.match_wall_cap_s];
  if (!declared.every((value) => Number.isFinite(value) && value > 0)) {
    failPreflight(["config.json does not declare item/bank/preview deadlines"]);
  }
  if (measureMode) {
    // Spotlight must not index the stage or outputs during measurement.
    const unindexed = (directory) => fs.realpathSync(directory).split(path.sep).some((part) => part.endsWith(".noindex"));
    const measurementProblems = [];
    if (!config.measurement) {
      measurementProblems.push("config.json declares no measurement plan");
    }
    if (config.measurement?.requires_noindex && (!unindexed(STAGE) || !unindexed(outRoot))) {
      measurementProblems.push("measurement stage and output must be inside a .noindex directory");
    }
    if (measurementProblems.length > 0) {
      failPreflight(measurementProblems);
    }
  }
  const expectations = readJson(path.join(STAGE, config.expectations.path));
  let only = null;
  if (measureMode) {
    plan = buildMeasurementPlan(config, expectations, measureMode);
    report.limits = { ...config.limits, measurement_total_wall_cap_s: config.measurement.total_wall_cap_s };
  } else {
    // Debugging aid only: a filtered plan can never pass or be frozen.
    const filter = (process.env.EDGER_RUNTIME_COST_ONLY ?? "").split(",").filter(Boolean);
    only = filter.length > 0 ? filter : null;
    plan = buildPlan(config, expectations)
      .filter((item) => !only || only.some((entry) => entry === item.phase || entry === item.id));
    report.partial_plan = only;
    report.coverage.planned = plannedCoverage(plan);
    report.limits = config.limits;
  }
  report.caps = config.caps;
  report.environment = {
    worker_pid: process.pid,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    os_release: os.release(),
    cpu: os.cpus()[0]?.model ?? null,
    cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    playwright: manifest.playwright,
    browser: config.browser,
    host_start: hostSnapshot(),
    page: null,
  };
  writeReport();

  const control = (promise, label) => withTimeout(promise, config.timeouts.control_call_ms, label);
  // The current item's deadline, and an optional inner (match/bank) deadline.
  let itemDeadline = null;
  const publishDeadlines = (phase, inner = null) =>
    progress.update({ phase, deadlines: inner ? [itemDeadline, inner] : [itemDeadline] });

  let chromiumInfo = null;
  let nativeScreen = null;
  const chromiumCpuTracker = () => {
    const tracker = createTreeCpuTracker(chromiumInfo.pid);
    tracker.sample(listProcesses());
    return tracker;
  };

  async function launchBrowser() {
    const { chromium } = await import("playwright");
    server = await startStageServer(STAGE);
    progress.update({ phase: "launch" });
    const pinnedBrowser = manifest.playwright.browser;
    browser = await withTimeout(
      chromium.launch({
        headless: config.browser.headless,
        executablePath: pinnedBrowser.executable,
        args: config.browser.launch_args,
        timeout: config.timeouts.launch_ms,
      }),
      config.timeouts.launch_ms + 5000,
      "chromium.launch",
    );
    const processes = listProcesses();
    const self = processes.find((entry) => entry.pid === process.pid);
    const chromiumProcess = processes.find((entry) =>
      entry.ppid === process.pid && entry.command.includes(pinnedBrowser.executable));
    if (!chromiumProcess) {
      throw new Error("could not identify the Chromium browser process");
    }
    chromiumInfo = {
      pid: chromiumProcess.pid,
      pgid: chromiumProcess.pgid,
      lstart: chromiumProcess.lstart,
      separate_group: chromiumProcess.pgid !== self?.pgid,
    };
    progress.update({ phase: "launched", owned: [{ role: "chromium", ...chromiumInfo }] });
    Object.assign(report.environment, {
      worker_pgid: self?.pgid ?? null,
      chromium: chromiumInfo,
      browser_version: browser.version(),
      server: server.url,
    });
    writeReport();
  }

  // Headed pages: bring the page's window forward and put it in fullscreen
  // (the browser runs with --kiosk), then wait until CDP reports the state and
  // hold briefly so geometry settles. macOS ignores a request made while a
  // previous window is still leaving its fullscreen space, so the request is
  // repeated until the settle timeout. Never the game's fullscreen control.
  async function setupWindow(context, page) {
    const started = performance.now();
    const settings = config.browser.window;
    await control(page.bringToFront(), "bringToFront");
    const session = await control(context.newCDPSession(page), "newCDPSession");
    const { windowId } = await control(session.send("Browser.getWindowForTarget"), "getWindowForTarget");
    const before = await control(session.send("Browser.getWindowBounds", { windowId }), "getWindowBounds");
    const until = Date.now() + settings.settle_timeout_ms;
    let after;
    let attempts = 0;
    for (;;) {
      await control(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } }),
        "setWindowBounds");
      attempts += 1;
      const attemptUntil = Math.min(until, Date.now() + settings.retry_after_ms);
      do {
        await sleep(settings.settle_poll_ms);
        after = await control(session.send("Browser.getWindowBounds", { windowId }), "getWindowBounds");
      } while (after.bounds.windowState !== "fullscreen" && Date.now() < attemptUntil);
      if (after.bounds.windowState === "fullscreen" || Date.now() >= until) {
        break;
      }
    }
    await sleep(settings.settle_hold_ms);
    return {
      session, windowId, before: before.bounds, after: after.bounds, attempts, setup_ms: performance.now() - started,
    };
  }

  async function openPage(viewport, url) {
    const size = config.viewports[viewport];
    const context = await control(browser.newContext({
      viewport: size,
      deviceScaleFactor: config.browser.device_scale_factor,
    }), "newContext");
    const page = await control(context.newPage(), "newPage");
    const errors = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
    const favicon = `${server.url}/favicon.ico`;
    page.on("console", (message) => {
      const retained = retainedConsoleError(
        { type: message.type(), text: message.text(), url: message.location()?.url ?? "" }, favicon);
      if (retained) {
        errors.push(retained);
      }
    });
    page.on("crash", () => errors.push("page crashed"));
    const opened = { context, page, errors, viewport, window: null };
    if (config.browser.window) {
      opened.window = await setupWindow(context, page);
    }
    await withTimeout(page.goto(`${server.url}/${url}`, { waitUntil: "load" }), config.timeouts.page_load_ms, "goto");
    return opened;
  }

  // Settled display admission for an opened page; optionally saves the native
  // visible-content capture (what is physically shown, not a re-render).
  async function displayCheck(opened, { capture = null } = {}) {
    const started = performance.now();
    const window = opened.window
      ? await control(opened.window.session.send("Browser.getWindowBounds", { windowId: opened.window.windowId }),
        "getWindowBounds")
      : null;
    const page = await control(opened.page.evaluate(pageGeometry), "geometry");
    const front = opened.window ? await frontmostPid() : null;
    let captureSize = null;
    if (capture && opened.window) {
      const shot = await control(opened.window.session.send("Page.captureScreenshot", { format: "png", fromSurface: false }),
        "captureScreenshot");
      const buffer = Buffer.from(shot.data, "base64");
      fs.mkdirSync(path.dirname(capture), { recursive: true });
      fs.writeFileSync(capture, buffer);
      captureSize = pngSize(buffer);
    }
    const result = checkDisplayGeometry({ window, page, frontmostPid: front, capture: captureSize }, {
      viewport: config.viewports[opened.viewport],
      deviceScaleFactor: config.browser.device_scale_factor,
      screen: opened.window ? nativeScreen : null,
      chromiumPid: chromiumInfo.pid,
    });
    return {
      ...result,
      window: window?.bounds ?? null,
      window_setup: opened.window
        ? {
            before: opened.window.before, after: opened.window.after, attempts: opened.window.attempts,
            setup_ms: opened.window.setup_ms,
          }
        : null,
      page,
      frontmost_pid: front,
      capture: captureSize ? { file: path.relative(out, capture), ...captureSize } : null,
      check_ms: performance.now() - started,
    };
  }

  // Headed windows leave their fullscreen space with an animation; let it
  // finish before the next window is created.
  async function closeContext(context) {
    try {
      await withTimeout(context.close(), config.timeouts.close_ms, "context.close");
    } catch (error) {
      report.failures.push({ phase: "cleanup", error: error.message });
    }
    if (config.browser.window) {
      await sleep(config.browser.window.close_settle_ms);
    }
  }

  async function openDiagnostic(viewport, runs) {
    const opened = await openPage(viewport, `runtime-cost.html?seed=${config.seed}`);
    await withTimeout(
      opened.page.waitForFunction(() => Boolean(window.__edgerRuntimeCost)),
      config.timeouts.page_load_ms,
      "diagnostic ready",
    );
    const specs = runs.map((run) => ({ run, url: config.models[run].path, sha256: config.models[run].sha256 }));
    await control(opened.page.evaluate((list) => window.__edgerRuntimeCost.loadModels(list), specs), "loadModels");
    return opened;
  }

  const modelsFor = (expected) => (expected.kind === V1_BASELINE_KIND ? [] : [expected.model]);

  function matchConfig(id, expected, { collectors, clock, synthetic = null, maxTicks = config.max_ticks }) {
    return {
      id,
      kind: expected.kind ?? "v2",
      seed: expected.seed,
      model: expected.model,
      controller: expected.controller,
      candidate_actor: expected.candidate_actor,
      collectors,
      clock,
      synthetic,
      warm_frames: config.real_time.warm_frames,
      caps: config.caps,
      max_ticks: maxTicks,
    };
  }

  // Start one match, drain its samples while it runs and return its record.
  // Its declared deadline covers startMatch through the final result exactly;
  // the supervisor enforces it. Control round trips, chunk writes, display
  // monitoring and the page's warmup/export/finalize times are recorded
  // separately. Real-time matches of a headed page are monitored: a changed
  // window, lost front position, hidden page or changed scale/viewport stops
  // the match as incomplete.
  async function driveMatch({ opened, id, phase, settings, pollMs, wallCapS, admittedBounds = null }) {
    const { page, errors } = opened;
    const rows = Object.fromEntries(RUNTIME_COST_TABLE_NAMES.map((name) => [name, []]));
    const chunkDir = path.join(out, "chunks", id);
    const realTime = settings.clock === "raf";
    const cpu = chromiumCpuTracker();
    const workerCpuStart = process.cpuUsage();
    const size = config.viewports[opened.viewport];
    const monitor = realTime
      ? { window_checked: Boolean(opened.window), checks: 0, ms_sum: 0, ms_max: 0, ps_ms_sum: 0, violations: [] }
      : null;
    const timing = {
      deadline_ms: wallCapS * 1000,
      start_control_ms: null,
      poll_control_ms_sum: 0,
      poll_control_ms_max: 0,
      stop_control_ms: null,
      result_control_ms: null,
      chunk_write_ms: 0,
      condition_ms: null,
    };
    const timed = async (promise, label, record) => {
      const at = performance.now();
      const value = await control(promise, label);
      record(performance.now() - at);
      return value;
    };
    const started = Date.now();
    publishDeadlines(phase, deadlineRecord(id, "match", wallCapS * 1000, started));
    try {
      await timed(page.evaluate((value) => window.__edgerRuntimeCost.startMatch(value), settings), "startMatch",
        (ms) => { timing.start_control_ms = ms; });
      let sequence = 0;
      let stopSent = null;
      let polls = 0;
      let maxTick = 0;
      for (;;) {
        if (shuttingDown) {
          throw new Error(`shutting down: ${shuttingDown}`);
        }
        await sleep(pollMs);
        const snapshot = await timed(
          page.evaluate((maxRows) => window.__edgerRuntimeCost.poll(maxRows), config.chunk_rows),
          "poll",
          (ms) => {
            timing.poll_control_ms_sum += ms;
            timing.poll_control_ms_max = Math.max(timing.poll_control_ms_max, ms);
          },
        );
        polls += 1;
        maxTick = Math.max(maxTick, snapshot.tick ?? 0);
        if (snapshot.chunks) {
          const written = {};
          for (const name of RUNTIME_COST_TABLE_NAMES) {
            const chunk = snapshot.chunks[name];
            if (chunk.rows.length > 0) {
              rows[name].push(...chunk.rows);
              written[name] = chunk;
            }
          }
          if (Object.keys(written).length > 0) {
            const writeStart = performance.now();
            fs.mkdirSync(chunkDir, { recursive: true });
            fs.writeFileSync(
              path.join(chunkDir, `${String(sequence).padStart(5, "0")}.json`),
              `${JSON.stringify({ match: id, sequence, columns: RUNTIME_COST_TABLE_COLUMNS, tables: written })}\n`,
            );
            timing.chunk_write_ms += performance.now() - writeStart;
            sequence += 1;
          }
        }
        if (monitor && ["warming", "running"].includes(snapshot.status)) {
          const at = performance.now();
          const [bounds, front] = await Promise.all([
            opened.window
              ? control(opened.window.session.send("Browser.getWindowBounds", { windowId: opened.window.windowId }),
                "monitor window")
              : null,
            opened.window ? frontmostPid() : null,
          ]);
          const psStart = performance.now();
          cpu.sample(listProcesses());
          const ms = performance.now() - at;
          monitor.checks += 1;
          monitor.ms_sum += ms;
          monitor.ms_max = Math.max(monitor.ms_max, ms);
          monitor.ps_ms_sum += performance.now() - psStart;
          const problems = [];
          if (snapshot.visibility !== "visible") {
            problems.push("hidden");
          }
          if (snapshot.device_pixel_ratio !== config.browser.device_scale_factor) {
            problems.push("device_pixel_ratio");
          }
          if (!isDeepStrictEqual(snapshot.viewport, [size.width, size.height])) {
            problems.push("viewport");
          }
          if (opened.window) {
            if (!isDeepStrictEqual(bounds?.bounds, admittedBounds)) {
              problems.push("window_bounds");
            }
            if (front !== chromiumInfo.pid) {
              problems.push("not_frontmost");
            }
          }
          if (problems.length > 0) {
            if (monitor.violations.length < 20) {
              monitor.violations.push({ tick: snapshot.tick, problems, frontmost_pid: front });
            }
            if (!stopSent) {
              stopSent = "display_lost";
              await timed(page.evaluate((reason) => window.__edgerRuntimeCost.stop(reason), stopSent), "stop",
                (value) => { timing.stop_control_ms = value; });
            }
          }
        }
        if (errors.length > 0 && !stopSent) {
          stopSent = "page_error";
          await timed(page.evaluate((reason) => window.__edgerRuntimeCost.stop(reason), stopSent), "stop",
            (ms) => { timing.stop_control_ms = ms; });
        }
        if (["complete", "stopped", "error"].includes(snapshot.status) && !(snapshot.pending_rows > 0)) {
          break;
        }
      }
      const final = await timed(page.evaluate(() => window.__edgerRuntimeCost.result()), "result",
        (ms) => { timing.result_control_ms = ms; });
      timing.condition_ms = Date.now() - started;
      const workerCpu = process.cpuUsage(workerCpuStart);
      cpu.sample(listProcesses());
      const chromiumCpu = cpu.summary();
      return {
        final,
        rows,
        polls,
        chunks: sequence,
        stop_sent: stopSent,
        wall_ms: timing.condition_ms,
        timing,
        chromium_tree_cpu: chromiumCpu,
        chromium_tree_cpu_s: chromiumCpu.cpu_s,
        worker_cpu_s: Math.round((workerCpu.user + workerCpu.system) / 1e4) / 100,
        max_polled_tick: maxTick,
        display_monitor: monitor,
      };
    } finally {
      // Whatever follows (recording, context cleanup) is charged to the item.
      publishDeadlines(phase);
    }
  }

  function recordMatch({ item, id, phase, viewport, context, settings, expected, run, comparison = null,
    extraChecks = null, errors, display = null }) {
    comparison ??= checkMatchAgainstExpectation({
      final: run.final,
      expected,
      rows: settings.collectors ? run.rows : null,
    });
    const summary = settings.collectors
      ? { frame_pacing_claim: settings.clock === "raf", ...summarizeRuntimeCostTables(run.rows) }
      : null;
    const displayOk = display === null ||
      (display.admission.passed && (display.monitor?.violations.length ?? 0) === 0);
    const passed = comparison.passed && (extraChecks?.passed ?? true) && errors.length === 0 && displayOk;
    const { schedule, long_tasks: longTasks, ...finalWithoutSchedule } = run.final ?? {};
    const record = {
      id,
      item,
      phase,
      viewport,
      context,
      kind: expected.kind ?? "v2",
      clock: settings.clock,
      collectors: settings.collectors,
      expected_id: expected.id,
      passed,
      checks: comparison.checks,
      schedule_difference: comparison.schedule_difference,
      extra_checks: extraChecks,
      display,
      page_errors: errors.slice(0, 20),
      final: run.final ? { ...finalWithoutSchedule, schedule_length: schedule?.length ?? null } : null,
      long_tasks: longTasks ?? null,
      wall_ms: run.wall_ms,
      timing: run.timing,
      chromium_tree_cpu: run.chromium_tree_cpu,
      chromium_tree_cpu_s: run.chromium_tree_cpu_s,
      worker_cpu_s: run.worker_cpu_s,
      polls: run.polls,
      chunks: run.chunks,
      stop_sent: run.stop_sent,
      summary,
    };
    writeJsonAtomic(path.join(out, "matches", `${id}.json`), record);
    report.matches.push({
      id,
      phase,
      viewport,
      kind: expected.kind ?? "v2",
      collectors: settings.collectors,
      clock: settings.clock,
      passed,
      failed_checks: Object.entries({ ...comparison.checks, ...(extraChecks?.checks ?? {}) })
        .filter(([, value]) => value === false || value?.ok === false)
        .map(([name]) => name)
        .concat(displayOk ? [] : ["display"]),
      status: run.final?.status ?? null,
      stop_reason: run.final?.stop_reason ?? null,
      terminal_tick: run.final?.terminal_tick ?? null,
      overtime_start_tick: run.final?.overtime_start_tick ?? null,
      match_wall_ms: run.final?.match_wall_ms ?? null,
      wall_ms: run.wall_ms,
      chromium_tree_cpu_s: run.chromium_tree_cpu_s,
    });
    report.coverage.completed[phase] = (report.coverage.completed[phase] ?? 0) + 1;
    if (phase === "fast_forward" && expected.kind === V1_BASELINE_KIND) {
      report.coverage.completed.fast_forward_v1_baseline = (report.coverage.completed.fast_forward_v1_baseline ?? 0) + 1;
    }
    writeReport();
    return record;
  }

  async function runSmoke(item) {
    const result = { id: item.id, phase: "smoke", checks: {}, screenshots: [], display: {} };
    const screenshot = async (page, name) => {
      const file = path.join(out, "screenshots", `${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await control(page.screenshot({ path: file }), "screenshot");
      result.screenshots.push(path.relative(out, file));
    };
    const readText = (page) => control(page.evaluate(() => JSON.parse(window.render_game_to_text())), "render_game_to_text");

    const live = await openPage(item.viewport, "index.html");
    try {
      await withTimeout(live.page.locator("#start-btn").waitFor({ state: "visible" }), config.timeouts.page_load_ms, "start-btn");
      result.display.live = await displayCheck(live);
      result.checks.live_display = result.display.live.passed;
      const before = await readText(live.page);
      await control(live.page.locator("#start-btn").click(), "start click");
      await withTimeout(
        live.page.waitForFunction(() => JSON.parse(window.render_game_to_text()).tick >= 20),
        config.timeouts.control_call_ms,
        "live ticks",
      );
      const after = await readText(live.page);
      await screenshot(live.page, `live-${item.viewport}`);
      result.checks.live_ready = before.mode === "ready" && before.bot_tier === "edger" && before.tick === 0;
      result.checks.live_playing = after.mode === "playing" && after.tick >= 20;
      result.checks.live_smoke_hooks_present = await control(live.page.evaluate(() =>
        typeof window.advanceTime === "function" && typeof window.__edgeRoyaleSmokeFinishMatch === "function"), "hooks");
      result.checks.live_page_errors = live.errors.length === 0;
      result.live_errors = live.errors.slice(0, 20);
    } finally {
      await closeContext(live.context);
    }

    const diagnostic = await openDiagnostic(item.viewport, [config.smoke.preview.model]);
    try {
      const { page } = diagnostic;
      const info = await control(page.evaluate(() => window.__edgerRuntimeCost.info()), "info");
      report.environment.page ??= {};
      report.environment.page[item.viewport] = info;
      // Headed: the physically visible content, captured natively, must show the
      // whole viewport at the configured scale.
      result.display.diagnostic = await displayCheck(diagnostic, {
        capture: diagnostic.window ? path.join(out, "screenshots", `diagnostic-${item.viewport}-visible.png`) : null,
      });
      result.checks.diagnostic_display = result.display.diagnostic.passed &&
        (!diagnostic.window || result.display.diagnostic.capture !== null);
      const idle = await readText(page);
      result.checks.cross_origin_isolated = info.cross_origin_isolated === true;
      result.checks.diagnostic_idle = idle.mode === "ready" && idle.tick === 0;
      result.checks.diagnostic_hooks_removed = await control(page.evaluate(() =>
        typeof window.advanceTime === "undefined" && typeof window.__edgeRoyaleSmokeFinishMatch === "undefined"), "hooks");
      await screenshot(page, `diagnostic-${item.viewport}-idle`);
      // Input is not installed: the visible Start button and keys do nothing.
      await control(page.locator("#start-btn").click(), "diagnostic start click");
      await control(page.keyboard.press("r"), "key r");
      await sleep(300);
      const afterClick = await readText(page);
      result.checks.diagnostic_input_disabled = afterClick.mode === "ready" && afterClick.tick === 0;
      const preview = config.smoke.preview;
      const settings = {
        ...matchConfig(`smoke-preview-${item.viewport}`, { ...preview, seed: config.seed }, {
          collectors: true,
          clock: "synthetic",
          synthetic: preview.synthetic,
        }),
      };
      const run = await driveMatch({
        opened: diagnostic, id: settings.id, phase: "smoke", settings, pollMs: 200,
        wallCapS: preview.match_wall_cap_s,
      });
      const ticksAfterPreview = run.final?.terminal_tick;
      await sleep(300);
      const settled = await readText(page);
      await screenshot(page, `diagnostic-${item.viewport}-preview`);
      const expectedTicks = preview.synthetic.reduce((sum, step) => sum + step.frames * (step.elapsed_ms / TICK_MS), 0);
      result.checks.preview_ran = run.final?.stop_reason === "synthetic_plan_exhausted" && ticksAfterPreview === expectedTicks;
      result.checks.single_tick_source = settled.tick === ticksAfterPreview;
      result.checks.no_profile_writes = await control(page.evaluate(() => window.localStorage.length === 0), "storage");
      result.checks.diagnostic_page_errors = diagnostic.errors.length === 0;
      result.diagnostic_errors = diagnostic.errors.slice(0, 20);
    } finally {
      await closeContext(diagnostic.context);
    }
    result.passed = Object.values(result.checks).every(Boolean);
    return result;
  }

  async function runJump(item) {
    const opened = await openDiagnostic(item.viewport, [item.expected.model]);
    try {
      const settings = matchConfig(item.id, item.expected, {
        collectors: item.collectors,
        clock: "synthetic",
        synthetic: item.synthetic,
      });
      const run = await driveMatch({
        opened, id: item.id, phase: "jump", settings, pollMs: config.fast_forward.poll_ms, wallCapS: item.wall_cap_s,
      });
      const extra = item.collectors ? checkJumpFrames(run.rows.frames, item.expected.result.tick) : null;
      const record = recordMatch({
        item: item.id, id: item.id, phase: "jump", viewport: item.viewport, context: 1, settings,
        expected: item.expected, run, extraChecks: extra, errors: opened.errors,
      });
      return { id: item.id, phase: "jump", passed: record.passed, jump_checks: extra };
    } finally {
      await closeContext(opened.context);
    }
  }

  async function runFastForward(item) {
    const runs = Object.keys(config.models);
    const opened = await openDiagnostic(item.viewport, runs);
    const result = { id: item.id, phase: "fast_forward", passed: false, bank: null, matches: 0 };
    try {
      const bankMs = config.deadlines.bank_check_s * 1000;
      publishDeadlines("fast_forward", deadlineRecord(`${item.id}-bank`, "bank_check", bankMs));
      try {
        result.bank = await withTimeout(opened.page.evaluate((spec) => window.__edgerRuntimeCost.bankCheck(spec), {
          bankUrl: config.bank.path,
          bankSha256: config.bank.sha256,
          expectationsUrl: config.expectations.path,
          expectationsSha256: config.expectations.sha256,
        }), bankMs, "bankCheck");
      } finally {
        publishDeadlines("fast_forward");
      }
      writeJsonAtomic(path.join(out, "items", `${item.id}-bank.json`), result.bank);
      const bankPassed = result.bank.mismatch_count === 0 &&
        result.bank.decisions === result.bank.expected_decisions &&
        result.bank.states_checked === result.bank.states &&
        opened.errors.length === 0;
      report.coverage.completed.bank_checks = (report.coverage.completed.bank_checks ?? 0) + (bankPassed ? 1 : 0);
      if (!bankPassed) {
        result.failure = "bank_check";
        return result;
      }
      for (const match of item.matches) {
        const settings = matchConfig(match.id, match.expected, {
          collectors: match.collectors,
          clock: "synthetic",
          synthetic: config.fast_forward.synthetic,
        });
        const run = await driveMatch({
          opened, id: match.id, phase: "fast_forward", settings,
          pollMs: config.fast_forward.poll_ms, wallCapS: config.fast_forward.match_wall_cap_s,
        });
        const record = recordMatch({
          item: item.id, id: match.id, phase: "fast_forward", viewport: item.viewport, context: item.id,
          settings, expected: match.expected, run, errors: opened.errors,
        });
        result.matches += 1;
        if (!record.passed) {
          result.failure = match.id;
          return result;
        }
      }
      result.passed = true;
      return result;
    } finally {
      await closeContext(opened.context);
    }
  }

  // One rendered real-time match in a fresh context: settled display admission
  // first (no match starts on a failed admission), then the monitored match.
  async function renderedMatch({ item, phase, expected, collectors, maxTicks = config.max_ticks, wallCapS,
    comparisonFor = null, around = null }) {
    const opened = await openDiagnostic(item.viewport, modelsFor(expected));
    try {
      const admission = await displayCheck(opened);
      if (!admission.passed) {
        return { admitted: false, admission, record: null };
      }
      const settings = matchConfig(item.id, expected, { collectors, clock: "raf", maxTicks });
      const traced = around ? await around.before(opened) : null;
      let run;
      try {
        run = await driveMatch({
          opened, id: item.id, phase, settings, pollMs: config.real_time.poll_ms, wallCapS,
          admittedBounds: admission.window,
        });
      } finally {
        if (around) {
          await around.after(opened, traced);
        }
      }
      const record = recordMatch({
        item: item.id, id: item.id, phase, viewport: item.viewport, context: item.id, settings, expected, run,
        comparison: comparisonFor ? comparisonFor(run) : null,
        errors: opened.errors,
        display: { admission, monitor: run.display_monitor },
      });
      return { admitted: true, admission, record, run, traced };
    } finally {
      await closeContext(opened.context);
    }
  }

  async function runRealTime(item) {
    const result = await renderedMatch({
      item, phase: "real_time", expected: item.expected, collectors: item.collectors, wallCapS: item.wall_cap_s,
    });
    if (!result.admitted) {
      return { id: item.id, phase: "real_time", passed: false, failure: "display_admission", admission: result.admission };
    }
    const final = result.record.final;
    const visible = final?.visibility_at_start === "visible" && (final?.visibility_events ?? []).length === 0;
    return { id: item.id, phase: "real_time", passed: result.record.passed && visible, visible_throughout: visible };
  }

  // Run one measurement child (Node) with its own wall cap enforced by this
  // worker; the item's published deadline stays the outer, supervisor bound.
  function runChild(item, args, capS) {
    const logFile = path.join(out, "children", `${item.id}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.openSync(logFile, "w");
    const started = performance.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: STAGE, stdio: ["ignore", log, log] });
      activeChild = child;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, capS * 1000);
      const finish = (record) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fs.closeSync(log);
        activeChild = null;
        resolve({ ...record, timed_out: timedOut, wall_ms: performance.now() - started, log: path.relative(out, logFile) });
      };
      child.on("error", (error) => finish({ code: null, signal: null, error: error.message }));
      child.on("exit", (code, signal) => finish({ code, signal }));
    });
  }

  const measureScript = path.join(STAGE, "scripts", "edger-v2-runtime-cost-measure.mjs");
  const resultFile = (item) => path.join(out, "measurements", `${item.id}.json`);

  async function runExistingMethod(item) {
    const e = config.measurement.existing_method;
    const model = config.models[item.model];
    const child = await runChild(item, [measureScript, "existing-method", "--model", model.path, "--sha256", model.sha256,
      "--samples", String(e.samples), "--warmups", String(e.warmups), "--budget-ms", String(e.budget_ms),
      "--out", resultFile(item)], e.invocation_cap_s);
    const value = child.code === 0 ? readJson(resultFile(item)) : null;
    report.measurements.existing_method.push({ id: item.id, model: item.model, invocation: item.invocation, child,
      timing: value?.timing ?? null, process: value?.process ?? null });
    return { id: item.id, phase: item.phase, passed: child.code === 0 && value !== null, child };
  }

  async function runCompletePath(item) {
    const args = [measureScript, "complete-path", "--stage", STAGE, "--warmups", String(item.warmups),
      "--samples", String(item.samples), "--paths", item.paths.join(","), "--out", resultFile(item)];
    if (item.states !== null && item.states !== undefined) {
      args.push("--states", String(item.states));
    }
    const child = await runChild(item, args, item.cap_s);
    const value = child.code === 0 ? readJson(resultFile(item)) : null;
    const problems = completePathCoverageProblems(value);
    report.measurements.complete_path = value
      ? { id: item.id, child, planned: value.planned, completed: value.completed, mismatches: value.mismatches.length,
          truncated: value.truncated, coverage_problems: problems, elapsed_ms: value.elapsed_ms,
          first_calls: value.first_calls, groups: value.summary.groups, file: path.relative(out, resultFile(item)) }
      : { id: item.id, child, coverage_problems: problems };
    return { id: item.id, phase: item.phase, passed: problems.length === 0, child };
  }

  // A Node GC window is complete only with full planned coverage; a truncated
  // window keeps its bounded partial output as an incomplete condition. The
  // later window of each pair (frozen order) is complete only if both windows
  // planned and covered the same combinations.
  async function runNodeGc(item) {
    const g = config.measurement.node_gc;
    const args = [measureScript, "complete-path", "--stage", STAGE, "--runs", item.model, "--controllers",
      item.controller, "--paths", g.paths.join(","), "--warmups", String(g.warmups), "--samples", String(g.samples),
      "--gc", item.trace, "--window-s", String(g.window_s), "--out", resultFile(item)];
    if (item.states !== null) {
      args.push("--states", String(item.states));
    }
    const child = await runChild(item, args, g.cap_s);
    const value = child.code === 0 ? readJson(resultFile(item)) : null;
    const coverageProblems = completePathCoverageProblems(value);
    const entry = {
      id: item.id, model: item.model, controller: item.controller, trace: item.trace, child,
      planned: value?.planned ?? null, completed: value?.completed ?? null, truncated: value?.truncated ?? null,
      mismatches: value?.mismatches.length ?? null, plan_sha256: value?.plan_sha256 ?? null,
      coverage_sha256: value?.coverage_sha256 ?? null, coverage_problems: coverageProblems,
      file: value ? path.relative(out, resultFile(item)) : null,
      gc_trace: value?.gc_trace ?? null,
      total_ms: value?.summary.groups[`path|${g.paths[0]}`] ?? null,
    };
    let pairComplete = true;
    if (item.trace === g.order[g.order.length - 1]) {
      const partner = report.measurements.node_gc.find((other) =>
        other.model === item.model && other.controller === item.controller && other.trace !== item.trace);
      entry.pair = admitNodeGcPair({ entry, partner });
      if (partner) {
        partner.pair = entry.pair;
      }
      pairComplete = entry.pair.complete;
    }
    report.measurements.node_gc.push(entry);
    const passed = coverageProblems.length === 0 && pairComplete;
    return {
      id: item.id, phase: item.phase, passed, child,
      failure: passed ? null : coverageProblems.length > 0 ? "coverage_incomplete" : "pair_incomplete",
    };
  }

  async function runRendered(item) {
    const m = config.measurement.rendered;
    const windowed = item.window_ticks !== null;
    const result = await renderedMatch({
      item, phase: "rendered", expected: item.expected, collectors: true,
      maxTicks: windowed ? item.window_ticks : config.max_ticks, wallCapS: m.match_wall_cap_s,
      comparisonFor: windowed
        ? (run) => checkWindowAgainstExpectation({ final: run.final, expected: item.expected, windowTicks: item.window_ticks })
        : null,
    });
    const entry = {
      id: item.id,
      condition: item.condition.id,
      admitted: result.admitted,
      passed: result.record?.passed ?? false,
      windowed,
      status: result.record?.final?.status ?? null,
      stop_reason: result.record?.final?.stop_reason ?? null,
      terminal_tick: result.record?.final?.terminal_tick ?? null,
      failed_checks: result.record ? report.matches[report.matches.length - 1].failed_checks : ["display_admission"],
      match_wall_ms: result.record?.final?.match_wall_ms ?? null,
      chromium_tree_cpu: result.record?.chromium_tree_cpu ?? null,
      display_monitor: result.record?.display?.monitor ?? null,
    };
    report.measurements.rendered.push(entry);
    return { id: item.id, phase: item.phase, passed: entry.passed, failure: entry.passed ? null : "condition_incomplete" };
  }

  async function runBrowserGc(item) {
    const g = config.measurement.browser_gc;
    const traced = item.trace === "traced";
    const around = traced
      ? {
          async before(opened) {
            const session = opened.window?.session ?? await control(opened.context.newCDPSession(opened.page), "newCDPSession");
            await control(session.send("HeapProfiler.enable"), "HeapProfiler.enable");
            await control(session.send("HeapProfiler.startSampling", {
              samplingInterval: g.heap_sampling_interval,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            }), "HeapProfiler.startSampling");
            await control(browser.startTracing(opened.page, { categories: g.trace_categories }), "startTracing");
            return { session };
          },
          async after(opened, state) {
            const buffer = await control(browser.stopTracing(), "stopTracing");
            const { profile } = await control(state.session.send("HeapProfiler.stopSampling"), "HeapProfiler.stopSampling");
            state.trace = summarizeChromeTrace(JSON.parse(buffer.toString("utf8")));
            state.trace.bytes = buffer.length;
            if (buffer.length <= g.trace_keep_cap_bytes) {
              const file = path.join(out, "traces", `${item.id}.json.gz`);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, gzipSync(buffer));
              state.trace.file = path.relative(out, file);
            }
            state.heap = summarizeHeapProfile(profile);
          },
        }
      : null;
    const result = await renderedMatch({
      item, phase: "browser_gc", expected: item.expected, collectors: true, maxTicks: item.window_ticks,
      wallCapS: g.match_wall_cap_s,
      comparisonFor: (run) => checkWindowAgainstExpectation({
        final: run.final, expected: item.expected, windowTicks: item.window_ticks,
      }),
      around,
    });
    const windowPassed = result.record?.passed ?? false;
    const entry = {
      id: item.id,
      condition: item.condition.id,
      trace: item.trace,
      admitted: result.admitted,
      window_passed: windowPassed,
      passed: windowPassed,
      admitted_endpoint: windowEndpoint(item.expected, item.window_ticks),
      terminal_tick: result.record?.final?.terminal_tick ?? null,
      action_stream_hash: result.record?.final?.action_stream_hash ?? null,
      final_state_hash: result.record?.final?.final_state_hash ?? null,
      heap: result.record?.final?.heap ?? null,
      long_tasks: result.record?.long_tasks
        ? { count: result.record.long_tasks.count, refused: result.record.long_tasks.refused } : null,
      frames: result.record?.summary?.frames ?? null,
      candidate_total_by_kind: result.record?.summary?.candidate_decisions?.total_by_kind ?? null,
      chrome_trace: result.traced?.trace ?? null,
      heap_sampling: result.traced?.heap ?? null,
    };
    // Paired windows: the later run of the frozen order must reproduce its
    // partner at the same admitted endpoint, or the pair is incomplete.
    if (item.trace === g.order[g.order.length - 1]) {
      const partner = report.measurements.browser_gc.find((other) =>
        other.condition === entry.condition && other.trace !== entry.trace);
      entry.pair = admitBrowserGcPair({ entry, partner });
      if (partner) {
        partner.pair = entry.pair;
      }
      entry.passed &&= entry.pair.complete;
    }
    report.measurements.browser_gc.push(entry);
    return {
      id: item.id, phase: item.phase, passed: entry.passed,
      failure: entry.passed ? null : windowPassed ? "pair_incomplete" : "condition_incomplete",
    };
  }

  // GPU feature status from the browser, then one page without viewport or
  // scale emulation: native device scale, screen, focus/visibility and an rAF
  // refresh estimate (nearest-rank intervals). A failure here stops admission.
  async function probeDisplay(frames) {
    const session = await control(browser.newBrowserCDPSession(), "newBrowserCDPSession");
    let gpu;
    try {
      const info = await control(session.send("SystemInfo.getInfo"), "SystemInfo.getInfo");
      gpu = {
        feature_status: info.gpu.featureStatus,
        devices: info.gpu.devices.map((device) => ({
          vendor: device.vendorString,
          device: device.deviceString,
          driver_vendor: device.driverVendor,
          driver_version: device.driverVersion,
        })),
        driver_bug_workarounds: info.gpu.driverBugWorkarounds.length,
        model: info.modelName,
        model_version: info.modelVersion,
      };
    } finally {
      await control(session.detach(), "CDP detach").catch(() => {});
    }
    const context = await control(browser.newContext({ viewport: null }), "newContext (display probe)");
    try {
      const page = await control(context.newPage(), "newPage (display probe)");
      const display = await control(page.evaluate((count) => new Promise((resolve) => {
        const stamps = [];
        const step = (now) => {
          stamps.push(now);
          if (stamps.length <= count) {
            requestAnimationFrame(step);
            return;
          }
          const intervals = stamps.slice(1).map((value, index) => value - stamps[index]).sort((a, b) => a - b);
          const rank = (q) => intervals[Math.max(0, Math.ceil(q * intervals.length) - 1)];
          resolve({
            device_pixel_ratio: window.devicePixelRatio,
            screen: {
              width: screen.width,
              height: screen.height,
              avail_width: screen.availWidth,
              avail_height: screen.availHeight,
              color_depth: screen.colorDepth,
            },
            window: { inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] },
            visibility_state: document.visibilityState,
            has_focus: document.hasFocus(),
            raf_intervals: intervals.length,
            raf_interval_ms: {
              min: intervals[0], p50: rank(0.5), p95: rank(0.95), max: intervals[intervals.length - 1],
            },
            refresh_hz_estimate: Math.round(10_000 / rank(0.5)) / 10,
          });
        };
        requestAnimationFrame(step);
      }), frames), "display probe rAF");
      return { gpu, display };
    } finally {
      await closeContext(context);
    }
  }

  async function startBrowserPhase() {
    await launchBrowser();
    try {
      Object.assign(report.environment, await probeDisplay(config.browser.display_probe_frames));
      const display = report.environment.display;
      nativeScreen = { width: display.screen.width, height: display.screen.height };
      // Headed measurement uses the native scale; a different display stops admission.
      if (config.browser.window && display.device_pixel_ratio !== config.browser.device_scale_factor) {
        throw new Error(`native device scale ${display.device_pixel_ratio} is not the configured ` +
          `${config.browser.device_scale_factor}`);
      }
      return true;
    } catch (error) {
      report.failures.push({ phase: "environment", error: String(error?.stack ?? error) });
      report.stop_reason = "environment_probe";
      return false;
    } finally {
      writeReport();
    }
  }

  const runners = {
    smoke: runSmoke,
    jump: runJump,
    fast_forward: runFastForward,
    real_time: runRealTime,
    existing_method: runExistingMethod,
    complete_path: runCompletePath,
    node_gc: runNodeGc,
    rendered: runRendered,
    browser_gc: runBrowserGc,
  };
  // Measurement continues past an incomplete condition (no retries); validation stops.
  const continueAfterFailure = measureMode !== null;
  for (let index = 0; report.stop_reason === null && index < plan.length; index += 1) {
    const item = plan[index];
    currentIndex = index;
    if (BROWSER_PHASES.includes(item.phase) && browser === null && !(await startBrowserPhase())) {
      report.not_run = plan.slice(index).map((later) => later.id);
      break;
    }
    const started = Date.now();
    itemDeadline = deadlineRecord(item.id, "item", config.deadlines.item_s * 1000, started);
    publishDeadlines(item.phase);
    let result;
    try {
      result = await runners[item.phase](item);
    } catch (error) {
      result = { id: item.id, phase: item.phase, passed: false, error: String(error?.stack ?? error) };
    }
    result.wall_ms = Date.now() - started;
    writeJsonAtomic(path.join(out, "items", `${item.id}.json`), result);
    report.items.push({
      id: item.id,
      phase: item.phase,
      passed: result.passed,
      wall_ms: result.wall_ms,
      failure: result.failure ?? null,
      error: result.error ? result.error.split("\n")[0] : null,
    });
    if (item.phase === "smoke") {
      report.coverage.completed.smoke = (report.coverage.completed.smoke ?? 0) + (result.passed ? 1 : 0);
    }
    writeReport();
    if (!result.passed) {
      if (continueAfterFailure) {
        report.incomplete.push({ item: item.id, phase: item.phase, failure: result.failure ?? null,
          error: result.error ? result.error.split("\n")[0] : null });
        continue;
      }
      report.failures.push({ item: item.id, failure: result.failure ?? null, error: result.error ?? null });
      report.not_run = plan.slice(index + 1).map((later) => later.id);
      report.stop_reason = "item_failed";
      break;
    }
  }
  currentIndex = -1;

  report.environment.host_end = hostSnapshot();
  const finished = report.stop_reason === null && report.items.length === plan.length;
  if (measureMode) {
    report.passed = finished && report.failures.length === 0 && report.incomplete.length === 0;
    report.status = !finished ? "failed" : measureMode === "dry_run" ? "dry_run_complete" : "complete";
  } else {
    report.passed = !only && report.failures.length === 0 && report.not_run.length === 0 &&
      report.items.length === plan.length && report.items.every((entry) => entry.passed);
    report.status = report.passed ? "complete" : only && report.failures.length === 0 ? "partial" : "failed";
  }
  writeReport();
  if (browser) {
    try {
      await withTimeout(browser.close(), config.timeouts.close_ms, "browser.close");
    } catch (error) {
      report.failures.push({ phase: "cleanup", error: error.message });
    }
    server.server.close();
    report.environment.chromium_exited = !listProcesses().some((entry) =>
      entry.pid === chromiumInfo.pid && entry.lstart === chromiumInfo.lstart);
  }
  writeReport();
  progress.update({ phase: "complete", deadlines: [] });
  progress.stop();
  const exitOk = measureMode ? finished : report.passed || report.status === "partial";
  process.exit(exitOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
