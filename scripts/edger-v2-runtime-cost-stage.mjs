#!/usr/bin/env node
// Guarded staging for the Edger v2 runtime-cost browser harness.
//
//   stage   Copy the served client closure, harness scripts, Playwright packages
//           and pinned data into a new directory outside iCloud. The live
//           index.html and src/client/webGame.js are copied untouched; a
//           diagnostic page (runtime-cost.html) and module
//           (src/client/webGameRuntimeCost.js) are generated beside them by
//           guarded substitutions. Every source is pinned by SHA-256 and every
//           replaced block must occur exactly once with its pinned hash, so an
//           unexpected source shape fails staging. Writes config.json (the
//           predeclared validation plan and limits), MANIFEST.json and SHA256SUMS.
//           --browser chromium pins headed Chrome for Testing; the default,
//           chromium-headless-shell, pins the headless shell. Either way the
//           executable and its whole install tree are pinned by hash.
//   freeze  After validation and the measurement dry run pass, write the
//           successor freeze linked to the reviewed October 6 successor
//           freeze: the rendered matrix (24 v2 conditions in their original
//           order, then four live-v1 baselines), the measurement plan, display setup,
//           schemas, limits and the stage closure hash. It first rehashes the
//           whole stage and its tool binaries, and checks that the validation
//           and dry-run reports, their supervisor records and the gate record
//           are complete and bound to exactly that stage and config. It writes
//           a new read-only file and never overwrites one.
//
// The frozen cadence implementation and the production selectors are never
// rewritten; only the client entry module is substituted, and only in the stage.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_VALIDATION_SCHEMA,
  MEASUREMENT_SCHEMA,
  browserPinProblems,
  browserTreeDigest,
  buildMeasurementPlan,
  buildPlan,
  inventoryFiles,
  plannedCoverage,
} from "./edger-v2-runtime-cost-browser-worker.mjs";
import {
  EDGER_V2_NODE_EXPECTATIONS_SCHEMA as NODE_EXPECTATIONS_SCHEMA,
  EDGER_V2_RUNTIME_COST_MODEL_PINS as MODEL_PINS,
} from "./edger-v2-runtime-cost-core.mjs";
import { COMPLETE_PATH_SCHEMA, EXISTING_METHOD_SCHEMA } from "./edger-v2-runtime-cost-measure.mjs";
import { SUPERVISOR_SCHEMA } from "./edger-v2-runtime-cost-supervisor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STAGE_SCHEMA = "edger_v2_runtime_cost_stage_v1";
// v2: headed display setup, live-v1 baselines and the measurement plan.
export const VALIDATION_CONFIG_SCHEMA = "edger_v2_runtime_cost_browser_validation_config_v2";
export const MEASUREMENT_CONFIG_SCHEMA = "edger_v2_runtime_cost_measurement_config_v1";
// v2: the successor freeze, linked to the October 3 headless freeze.
export const PROFILING_FREEZE_SCHEMA = "edger_v2_runtime_cost_profiling_freeze_v2";
export const GATES_SCHEMA = "edger_v2_runtime_cost_gates_v1";
const GIB = 1024 ** 3;
// Stage files outside the hashed closure.
const STAGE_METADATA_FILES = Object.freeze(["MANIFEST.json", "SHA256SUMS"]);
const TARGETED_TEST_FILES = Object.freeze([
  "tests/edger-v2-runtime-cost.test.js",
  "tests/edger-v2-cadence.test.js",
  "tests/edger-v2-runtime-cost-browser.test.js",
]);
// Gates a freeze requires, each recorded exactly once with passed: true.
export const REQUIRED_FREEZE_GATES = Object.freeze([
  { id: "npm_test", matches: (command) => command === "npm test" },
  {
    id: "targeted_tests",
    matches: (command) => command.includes("--test") && TARGETED_TEST_FILES.every((file) => command.includes(file)),
  },
  { id: "live_browser_smoke", matches: (command) => command === "npm run smoke:browser" },
  {
    id: "supervised_validation",
    matches: (command) => command.includes("edger-v2-runtime-cost-supervisor.mjs") &&
      command.includes("edger-v2-runtime-cost-browser-worker.mjs") && !command.includes("--measure"),
  },
  {
    id: "supervised_measurement_dry_run",
    matches: (command) => command.includes("edger-v2-runtime-cost-supervisor.mjs") &&
      command.includes("edger-v2-runtime-cost-browser-worker.mjs") && command.includes("--measure dry_run"),
  },
]);
export const DIAGNOSTIC_HTML = "runtime-cost.html";
export const DIAGNOSTIC_MODULE = "src/client/webGameRuntimeCost.js";

// Live sources the stage substitutes. A change to either file must be reviewed
// and these pins updated together with the block pins below.
export const LIVE_SOURCE_PINS = Object.freeze({
  "index.html": "85ce12121f1544cb52159b456c1e5d93e47ed6494cd41d4cf81341dab341cb43",
  "src/client/webGame.js": "1143352cd189f0e6c37b9d3a378d49e1e20879a3b4efbaf5ed5b9d6221e58819",
});

// Live v1 driven by the cost baselines: the generated runtime module, and the
// canonical promoted JSON the expectations checked it against.
export const LIVE_V1_PIN = Object.freeze({
  module: "src/ai/generated/edgerPolicyCurrent.js",
  module_sha256: "69333cd508d3aebab3a246c6a9b1638960fb20611c6198eb81e08b9aae682847",
  artifact_sha256: "895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa",
});

// The reviewed October 6 successor freeze (itself linked to the October 3
// headless freeze bed6ff1e…) that this measurement-repair successor links to.
// Its review left measurement unadmitted; it stays immutable.
export const PREDECESSOR_FREEZE_SHA256 = "800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5";

export const HTML_SUBSTITUTIONS = Object.freeze([
  {
    id: "title",
    start: "    <title>Edge Royale Prototype</title>\n",
    end: null,
    block_sha256: "d05634df52c263644779427eb1932d3f345f7484f60474cfa54df9a08d02cfb1",
    replacement: "    <title>Edge Royale Runtime-Cost Diagnostic</title>\n",
  },
  {
    id: "entry_script",
    start: '    <script type="module" src="./src/client/webGame.js"></script>\n',
    end: null,
    block_sha256: "696663227fdf7eeb98836fb0bd5dbb2aa299420a47e81364508fdf307015039f",
    replacement: `    <script type="module" src="./${DIAGNOSTIC_MODULE}"></script>\n`,
  },
]);

export const WEBGAME_SUBSTITUTIONS = Object.freeze([
  {
    id: "imports",
    start: 'import { PROFILE_STORAGE_KEY } from "./storageKeys.js";\n',
    end: null,
    block_sha256: "dec92a69b4af452895c28bc318e338251ae1335ac7115c22604db992990d3fc2",
    replacement: `import { PROFILE_STORAGE_KEY } from "./storageKeys.js";
// Runtime-cost diagnostic stage only: generated from webGame.js by
// scripts/edger-v2-runtime-cost-stage.mjs. index.html never loads this module.
import { installEdgerV2RuntimeCostDiagnostic } from "../../scripts/edger-v2-runtime-cost-browser.js";
`,
  },
  {
    id: "persist_profile",
    start: "function persistProfile() {\n",
    end: "}\n",
    block_sha256: "1fe7be5c7bbff85106b61b8217201dea4ca404134121c4c8d15e87b42784ef77",
    replacement: `function persistProfile() {
  // Runtime-cost diagnostic: profile writes are disabled.
}
`,
  },
  {
    id: "reset_seed",
    start: "  const seedBase = 20260306 + profile.total_matches * 37 + appState.opponentBotId.length * 13;\n",
    end: "  appState.engine = createProductionEngine({ seed: seedBase });\n",
    block_sha256: "968f2609faf294790cd26e86670424d32656dbb4c1627cefe03b341c273af7d9",
    replacement: `  // Runtime-cost diagnostic: the configured development seed replaces the
  // profile-derived seed, and every match gets a fresh driver.
  const seedBase = runtimeCost.matchSeed();
  appState.engine = createProductionEngine({ seed: seedBase });
  runtimeCost.onReset(appState.engine);
`,
  },
  {
    id: "step_actions",
    start: "  const playerActions = appState.pendingActions.filter((action) => action.tick === nextTick);\n",
    end: "  syncVisualState();\n",
    block_sha256: "33448d58fd37afd070650bc021604fc43f74e2e56f287c4bfc8fd62360a5d94e",
    replacement: `  // Runtime-cost diagnostic: the driver supplies both sides' actions in the
  // frozen reference order; there is no player input or live bot here.
  const tickObserver = runtimeCost.tickObserver;
  const partsStart = tickObserver ? performance.now() : 0;
  const actions = runtimeCost.actionsForTick(appState.engine, nextTick);
  const actionsEnd = tickObserver ? performance.now() : 0;
  appState.engine.step(actions);
  const stepEnd = tickObserver ? performance.now() : 0;
  syncVisualState();
  if (tickObserver) {
    tickObserver(nextTick, partsStart, actionsEnd, stepEnd, performance.now());
  }
`,
  },
  {
    id: "frame_loop",
    start: "function frame(now) {\n",
    end: "  requestAnimationFrame(frame);\n}\n",
    block_sha256: "86a007c24d43218385514ccc4723b2e7e1eb5990dced298b42f6be7f3853e3d7",
    replacement: `// Runtime-cost diagnostic: the live drain loop (no lag clamp, no per-frame
// tick limit, lag still subtracted on terminal no-op iterations) with observers
// that stay null when collectors are off. rAF is re-armed only while a
// real-time match runs; the synthetic clock calls this function directly.
function frame(now) {
  const observer = runtimeCost.frameObserver;
  const callbackStart = observer ? performance.now() : 0;
  const elapsed = now - appState.lastFrameTime;
  appState.lastFrameTime = now;
  const tickBefore = appState.engine.state.tick;
  let preDrainLag = Number.NaN;
  let iterations = 0;
  let drainMs = 0;

  if (appState.mode === "playing" && !appState.paused) {
    appState.lagMs += elapsed;
    preDrainLag = appState.lagMs;
    const tickDurationMs = 1000 / TICK_RATE;
    const drainStart = observer ? performance.now() : 0;
    while (appState.lagMs >= tickDurationMs) {
      const tickStart = observer ? performance.now() : 0;
      stepGameTick();
      if (observer) {
        observer.tickDone(tickStart, performance.now());
      }
      appState.lagMs -= tickDurationMs;
      iterations += 1;
    }
    if (observer) {
      drainMs = performance.now() - drainStart;
    }
  }

  const renderStart = observer ? performance.now() : 0;
  render();
  if (observer) {
    const callbackEnd = performance.now();
    observer.frameDone(
      now,
      elapsed,
      preDrainLag,
      appState.lagMs,
      iterations,
      appState.engine.state.tick - tickBefore,
      drainMs,
      callbackEnd - renderStart,
      callbackEnd - callbackStart,
      appState.engine.state.tick,
    );
  }
  runtimeCost.afterFrame();
  if (runtimeCost.rafActive()) {
    requestAnimationFrame(frame);
  }
}
`,
  },
  {
    id: "user_input",
    start: "function getCanvasPointFromEvent(event) {\n",
    end: "      document.exitFullscreen().catch(() => {});\n    }\n  }\n});\n",
    block_sha256: "2ced734baf1b5af76680902c766029f238e9c286edd7ce45ea1dd39bc2900bc9",
    replacement: `// Runtime-cost diagnostic: pointer, click, button and keyboard input
// (including reset, start, pause and replay export) are not installed.
`,
  },
  {
    id: "smoke_hooks",
    start: "window.advanceTime = (ms) => {\n",
    end: "  render();\n};\n",
    block_sha256: "250a25f6956c47d14d4581cb91e366859bb3015b4c956eb61fa19c51aa6f1f8b",
    replacement: `// Runtime-cost diagnostic: advanceTime and the forced-finish smoke hook are not
// installed; the synthetic clock in edger-v2-runtime-cost-browser.js replaces them.
`,
  },
  {
    id: "startup",
    start: "hydrateAppState();\nresetGame();\nresizeCanvasToDisplaySize();\nrender();\nrequestAnimationFrame(frame);\n",
    end: null,
    block_sha256: "78f1f7851d0ba02ae8d7b43fff9b8120b9e365fb693829540a0daf220a201834",
    replacement: `// Runtime-cost diagnostic: initialize the idle board, then wait for the
// harness; requestAnimationFrame starts only when a real-time match starts.
const runtimeCost = installEdgerV2RuntimeCostDiagnostic({ appState, resetGame, render, frame });
hydrateAppState();
resetGame();
resizeCanvasToDisplaySize();
render();
`,
  },
]);

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrences(text, fragment) {
  let count = 0;
  for (let index = text.indexOf(fragment); index >= 0; index = text.indexOf(fragment, index + 1)) {
    count += 1;
  }
  return count;
}

// Apply substitutions located in the original source. The source must hash to
// its pin; each block's start marker and the block itself must occur exactly
// once, match its pinned hash and not overlap another block.
export function applyGuardedSubstitutions({ file, source, sourceSha256, substitutions }) {
  const actual = sha256Hex(source);
  if (actual !== sourceSha256) {
    throw new Error(`${file} hashes to ${actual}, expected ${sourceSha256}; review the source before restaging`);
  }
  const located = substitutions.map((substitution) => {
    const starts = occurrences(source, substitution.start);
    if (starts !== 1) {
      throw new Error(`${file} ${substitution.id}: start marker occurs ${starts} times, expected 1`);
    }
    const startIndex = source.indexOf(substitution.start);
    let endIndex = startIndex + substitution.start.length;
    if (substitution.end !== null) {
      const endAt = source.indexOf(substitution.end, endIndex);
      if (endAt < 0) {
        throw new Error(`${file} ${substitution.id}: end marker not found after the start marker`);
      }
      endIndex = endAt + substitution.end.length;
    }
    const block = source.slice(startIndex, endIndex);
    if (occurrences(source, block) !== 1) {
      throw new Error(`${file} ${substitution.id}: block occurs more than once`);
    }
    const blockSha256 = sha256Hex(block);
    if (blockSha256 !== substitution.block_sha256) {
      throw new Error(`${file} ${substitution.id}: block hashes to ${blockSha256}, expected ${substitution.block_sha256}`);
    }
    return { substitution, startIndex, endIndex, block };
  }).sort((left, right) => left.startIndex - right.startIndex);
  for (let index = 1; index < located.length; index += 1) {
    if (located[index].startIndex < located[index - 1].endIndex) {
      throw new Error(`${file}: blocks ${located[index - 1].substitution.id} and ${located[index].substitution.id} overlap`);
    }
  }
  let output = "";
  let cursor = 0;
  const records = [];
  for (const { substitution, startIndex, endIndex, block } of located) {
    output += source.slice(cursor, startIndex) + substitution.replacement;
    cursor = endIndex;
    records.push({
      id: substitution.id,
      start_line: source.slice(0, startIndex).split("\n").length,
      removed_lines: block.split("\n").length - 1,
      added_lines: substitution.replacement.split("\n").length - 1,
      block_sha256: substitution.block_sha256,
      replacement_sha256: sha256Hex(substitution.replacement),
    });
  }
  output += source.slice(cursor);
  return { output, records, source_sha256: actual, output_sha256: sha256Hex(output) };
}

// Playwright's two Chromium builds for one revision. The headless shell stays
// the correctness/smoke default at device scale 1; the October 3 review chose
// headed Chrome for Testing for rendered measurement, and the October 6 review
// its display: native device scale 2 and --kiosk with a per-page CDP
// fullscreen window, so both CSS viewports are fully visible.
export const BROWSER_ENGINES = Object.freeze({
  "chromium-headless-shell": {
    directory: "chromium_headless_shell",
    executable: "chrome-headless-shell",
    headless: true,
    device_scale_factor: 1,
    launch_args: Object.freeze([]),
    window: null,
  },
  chromium: {
    directory: "chromium",
    executable: process.platform === "darwin" ? "Google Chrome for Testing" : "chrome",
    headless: false,
    device_scale_factor: 2,
    launch_args: Object.freeze(["--kiosk"]),
    window: Object.freeze({
      mode: "cdp_fullscreen_per_page",
      settle_timeout_ms: 12000,
      retry_after_ms: 2000,
      settle_poll_ms: 250,
      settle_hold_ms: 1000,
      close_settle_ms: 1000,
    }),
  },
});

// The four live-v1 cost baselines appended to the rendered matrix: both sides
// and both viewports on the same development seed, in the matrix's order.
export function v1BaselineMatrix(seed) {
  const conditions = [];
  for (const viewport of ["portrait", "desktop"]) {
    for (const candidateActor of ["blue", "red"]) {
      conditions.push({
        id: `${seed}-v1-${candidateActor}-${viewport}`,
        kind: "v1_baseline",
        seed,
        model: "v1",
        controller: "live_v1",
        candidate_actor: candidateActor,
        viewport,
        clock: "raf",
        collectors: true,
      });
    }
  }
  return conditions;
}

// The measurement plan bound into the successor freeze (cost plan section 2
// and the October 3/6 review decisions). Order: Node paths without a browser,
// then the rendered matrix (24 v2 conditions in frozen order, then the four
// v1 baselines), then paired browser GC windows. One process or page at a
// time; no retries; an incomplete condition is recorded and the run continues.
export function buildMeasurementConfig(seed) {
  const pairs = [];
  for (const model of ["r0", "r1", "r2"]) {
    for (const controller of ["learned", "fixed_one_tick"]) {
      pairs.push({ model, controller });
    }
  }
  const rendered = [...profilingMatrix(seed), ...v1BaselineMatrix(seed)];
  const gcCondition = (model, controller, kind = "v2") => rendered.find((condition) =>
    (condition.kind ?? "v2") === kind && condition.model === model && condition.controller === controller &&
    condition.candidate_actor === "blue" && condition.viewport === "portrait");
  return {
    schema_version: MEASUREMENT_CONFIG_SCHEMA,
    total_wall_cap_s: 3 * 3600,
    requires_noindex: true,
    existing_method: {
      invocations: 5, samples: 100, warmups: 10, budget_ms: 5, invocation_cap_s: 180,
      order: "invocation-major: r0, r1, r2 within each invocation; each a separate Node process",
    },
    complete_path: {
      warmups: 10, samples: 100, paths: ["diagnostic", "production", "observed"], states: null, cap_s: 2400,
    },
    node_gc: {
      pairs, order: ["untraced", "traced"], paths: ["diagnostic"], warmups: 2, samples: 20,
      window_s: 60, cap_s: 150, heap_sampling_interval: 32768,
    },
    rendered: { conditions: rendered, collectors: true, clock: "raf", match_wall_cap_s: 360 },
    browser_gc: {
      conditions: [...pairs.map(({ model, controller }) => gcCondition(model, controller)),
        gcCondition("v1", "live_v1", "v1_baseline")],
      order: ["untraced", "traced"],
      window_ticks: 1200,
      match_wall_cap_s: 120,
      trace_categories: ["v8", "disabled-by-default-v8.gc"],
      heap_sampling_interval: 32768,
      trace_keep_cap_bytes: 64 * 1024 * 1024,
    },
    // Reduced paths for the pre-freeze measurement control; never measurement.
    dry_run: {
      existing_method: { invocations: 1, models: ["r0"] },
      complete_path: { states: 2, warmups: 2, samples: 5 },
      node_gc: { pairs: 1, states: 2 },
      rendered: {
        conditions: [`${seed}-r0-learned-blue-portrait`, `${seed}-v1-red-desktop`],
        window_ticks: 200,
      },
      browser_gc: { conditions: 1, window_ticks: 200 },
    },
  };
}

// Predeclared validation plan, measurement plan and limits (October 3 browser
// slice contract and the October 6 display decisions).
export function buildValidationConfig({ seed, models, bank, expectations, engine = "chromium-headless-shell",
  liveV1 = LIVE_V1_PIN }) {
  if (!BROWSER_ENGINES[engine]) {
    throw new Error(`unknown browser ${engine}; expected ${Object.keys(BROWSER_ENGINES).join(" or ")}`);
  }
  const display = BROWSER_ENGINES[engine];
  return {
    schema_version: VALIDATION_CONFIG_SCHEMA,
    seed,
    models,
    bank,
    expectations,
    live_v1: liveV1,
    browser: {
      engine,
      headless: display.headless,
      device_scale_factor: display.device_scale_factor,
      launch_args: [...display.launch_args],
      window: display.window ? { ...display.window } : null,
      display_probe_frames: 120,
    },
    viewports: {
      portrait: { width: 390, height: 844 },
      desktop: { width: 1280, height: 800 },
    },
    // Per-match raw sample capacities; overflow stops the match with a partial report.
    caps: {
      frames: 40000, ticks: 6100, candidate_decisions: 6100, v1_candidate_decisions: 6100, opponent_decisions: 6100,
      long_tasks: 5000,
    },
    chunk_rows: 4000,
    max_ticks: 6040,
    order: ["smoke", "jump", "fast_forward", "real_time"],
    smoke: {
      viewports: ["portrait", "desktop"],
      preview: {
        model: "r0",
        controller: "learned",
        candidate_actor: "blue",
        synthetic: [{ elapsed_ms: 1000, frames: 30 }],
        match_wall_cap_s: 60,
      },
    },
    jump: {
      viewport: "portrait",
      model: "r1",
      controller: "learned",
      candidate_actor: "blue",
      collectors: [true, false],
      match_wall_cap_s: 240,
    },
    fast_forward: {
      viewports: ["portrait", "desktop"],
      contexts_per_viewport: 2,
      collectors: [false, true],
      synthetic: [{ elapsed_ms: 1000 }],
      poll_ms: 200,
      match_wall_cap_s: 240,
      v1_baselines: true,
    },
    real_time: {
      conditions: [
        { model: "r1", controller: "learned", candidate_actor: "blue", viewport: "portrait" },
        { model: "r2", controller: "fixed_one_tick", candidate_actor: "red", viewport: "desktop" },
      ],
      collectors: [false, true],
      pages: 2,
      warm_frames: 30,
      poll_ms: 1000,
      match_wall_cap_s: 360,
    },
    // Supervisor-enforced deadlines, exact (no slack): each plan item, and a
    // bank check inside its item. Match deadlines are the match_wall_cap_s
    // values above, covering startMatch through the final result.
    deadlines: { item_s: 3600, bank_check_s: 600 },
    limits: {
      validation_wall_cap_s: 5400,
      measurement_dry_run_wall_cap_s: 1800,
      admission_free_gib: 3,
      reserve_free_gib: 2,
      output_cap_gib: 1,
      active_matches: 1,
      automatic_retries: 0,
    },
    timeouts: { control_call_ms: 15000, page_load_ms: 30000, launch_ms: 45000, close_ms: 10000 },
    measurement: buildMeasurementConfig(seed),
  };
}

// Regular files only; any other entry stops staging rather than being dropped.
function listFiles(directory) {
  const { files, unsupported } = inventoryFiles(directory);
  if (unsupported.length > 0) {
    throw new Error(`unsupported entries under ${directory}: ${unsupported.map(({ file, kind }) => `${kind} ${file}`).join(", ")}`);
  }
  return files;
}

function sha256File(file) {
  return sha256Hex(fs.readFileSync(file));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // Read then write: copyFileSync from an evicted iCloud file can fail with ECANCELED.
  fs.writeFileSync(to, fs.readFileSync(from));
}

function assertOutsideICloud(directory) {
  const resolved = path.resolve(directory);
  const home = os.homedir();
  for (const synced of ["Documents", "Desktop", path.join("Library", "Mobile Documents")]) {
    const prefix = path.join(home, synced) + path.sep;
    if (resolved.startsWith(prefix)) {
      throw new Error(`${resolved} is under iCloud-synced ${synced}; stage outside it`);
    }
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      args[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? argv[++index] : true;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function required(args, key) {
  if (args[key] === undefined || args[key] === true) {
    throw new Error(`--${key} is required`);
  }
  return args[key];
}

const SERVED_SCRIPTS = Object.freeze([
  "scripts/edger-v2-runtime-cost-adapter.js",
  "scripts/edger-v2-runtime-cost-collectors.js",
  "scripts/edger-v2-runtime-cost-browser.js",
]);
const HARNESS_SCRIPTS = Object.freeze([
  "scripts/edger-v2-runtime-cost-browser-worker.mjs",
  "scripts/edger-v2-runtime-cost-process.mjs",
  "scripts/edger-v2-runtime-cost-supervisor.mjs",
  // Node measurement paths, executed from the stage at their real paths.
  "scripts/edger-v2-runtime-cost-measure.mjs",
  "scripts/edger-v2-runtime-cost-core.mjs",
  "scripts/edger-v2-cadence-core.mjs",
  "scripts/edger-evaluation-core.mjs",
]);
// The unchanged live smoke, at its real paths, so `npm run smoke:browser` runs
// verbatim from the stage against the untouched live entry point.
const LIVE_SMOKE_SCRIPTS = Object.freeze([
  "scripts/browser-smoke.mjs",
  "scripts/browser-smoke-worker.mjs",
  "scripts/dev-server.mjs",
]);
// Recorded for provenance; not executed from the stage.
const PROVENANCE_FILES = Object.freeze([
  "scripts/edger-v2-runtime-cost-stage.mjs",
  "scripts/edger-v2-runtime-cost.mjs",
  "tests/edger-v2-runtime-cost.test.js",
  "tests/edger-v2-runtime-cost-browser.test.js",
  "tests/fixtures/runtime-cost-fake-worker.mjs",
]);

// Pin the engine's build for this Playwright: executable and install tree.
function browserInstall(browsersJson, engine) {
  const { directory: prefix, executable: name } = BROWSER_ENGINES[engine];
  const entry = browsersJson.browsers.find((browser) => browser.name === engine);
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const directory = path.join(base, `${prefix}-${entry.revision}`);
  if (!fs.existsSync(directory)) {
    throw new Error(`${engine} ${entry.revision} is not installed under ${directory}`);
  }
  // A lookup, not an inventory: the found binary and its tree are pinned by hash.
  const executable = inventoryFiles(directory).files.find((file) => path.basename(file) === name);
  if (!executable) {
    throw new Error(`${name} ${entry.revision} is not installed under ${directory}`);
  }
  const tree = browserTreeDigest(directory);
  if (tree.unsupported.length > 0) {
    throw new Error(`unsupported entries under ${directory}: ${tree.unsupported.join(", ")}`);
  }
  return {
    engine,
    revision: entry.revision,
    browser_version: entry.browserVersion,
    install_dir: directory,
    executable,
    sha256: sha256File(executable),
    tree_sha256: tree.sha256,
    tree_files: tree.files,
    tree_links: tree.links,
  };
}

function stageCommand(args) {
  const stageDir = path.resolve(required(args, "out"));
  assertOutsideICloud(stageDir);
  if (fs.existsSync(stageDir)) {
    throw new Error(`${stageDir} already exists; stages are never reused`);
  }
  const repo = path.resolve(args.repo ?? ROOT);
  const modelDir = required(args, "model-dir");
  const bankPath = required(args, "bank");
  const expectationsPath = required(args, "expectations");
  const playwrightModules = path.resolve(required(args, "playwright-modules"));
  const engine = args.browser ?? "chromium-headless-shell";
  if (!BROWSER_ENGINES[engine]) {
    throw new Error(`--browser must be ${Object.keys(BROWSER_ENGINES).join(" or ")}`);
  }

  // Pins first: nothing is written if any input differs.
  const models = {};
  for (const [run, expected] of Object.entries(MODEL_PINS)) {
    const file = path.join(modelDir, `${run}-learned-full.json`);
    const actual = sha256File(file);
    if (actual !== expected) {
      throw new Error(`${file} hashes to ${actual}, expected ${expected}`);
    }
    models[run] = { file, sha256: actual };
  }
  const bankSha256 = sha256File(bankPath);
  if (bankSha256 !== required(args, "bank-sha256")) {
    throw new Error(`bank hashes to ${bankSha256}, not the pinned value`);
  }
  const expectationsSha256 = sha256File(expectationsPath);
  if (expectationsSha256 !== required(args, "expectations-sha256")) {
    throw new Error(`expectations hash to ${expectationsSha256}, not the pinned value`);
  }
  const bank = readJson(bankPath);
  const expectations = readJson(expectationsPath);
  if (expectations.bank.sha256 !== bankSha256) {
    throw new Error("expectations were built from a different bank");
  }
  if (expectations.schema_version !== NODE_EXPECTATIONS_SCHEMA ||
    (expectations.v1_baselines ?? []).length !== 2 * expectations.match_seeds.length) {
    throw new Error(`expectations must be ${NODE_EXPECTATIONS_SCHEMA} with both live-v1 baselines per match seed`);
  }
  const liveV1Module = sha256File(path.join(repo, LIVE_V1_PIN.module));
  if (liveV1Module !== LIVE_V1_PIN.module_sha256 || expectations.live_v1?.module_sha256 !== LIVE_V1_PIN.module_sha256 ||
    expectations.live_v1?.artifact_sha256 !== LIVE_V1_PIN.artifact_sha256) {
    throw new Error(`live v1 ${LIVE_V1_PIN.module} (${liveV1Module}) or the expectations' live-v1 pins differ from LIVE_V1_PIN`);
  }
  for (const run of Object.keys(MODEL_PINS)) {
    if (expectations.model_sha256[run] !== models[run].sha256 || bank.model_sha256[run] !== models[run].sha256) {
      throw new Error(`model ${run} differs from the bank or expectations`);
    }
  }
  const seedPlans = {
    "base-seed-plan.json": required(args, "base-plan"),
    "replication-seed-plan.json": required(args, "replication-plan"),
  };
  const planHashes = {
    "base-seed-plan.json": sha256File(seedPlans["base-seed-plan.json"]),
    "replication-seed-plan.json": sha256File(seedPlans["replication-seed-plan.json"]),
  };
  if (
    planHashes["base-seed-plan.json"] !== bank.seed_plans.base_plan_sha256 ||
    planHashes["replication-seed-plan.json"] !== bank.seed_plans.replication_plan_sha256 ||
    JSON.stringify(expectations.seed_plans) !== JSON.stringify(bank.seed_plans)
  ) {
    throw new Error("seed plans differ from the bank's pins");
  }
  const lock = readJson(path.join(repo, "package-lock.json"));
  const lockedPlaywright = lock.packages?.["node_modules/playwright"]?.version;
  const playwrightVersion = readJson(path.join(playwrightModules, "playwright", "package.json")).version;
  const coreVersion = readJson(path.join(playwrightModules, "playwright-core", "package.json")).version;
  if (playwrightVersion !== lockedPlaywright || coreVersion !== lockedPlaywright) {
    throw new Error(`Playwright ${playwrightVersion}/${coreVersion} differs from the lockfile's ${lockedPlaywright}`);
  }
  const pinnedBrowser = browserInstall(readJson(path.join(playwrightModules, "playwright-core", "browsers.json")), engine);

  const htmlSource = fs.readFileSync(path.join(repo, "index.html"), "utf8");
  const gameSource = fs.readFileSync(path.join(repo, "src", "client", "webGame.js"), "utf8");
  const html = applyGuardedSubstitutions({
    file: "index.html",
    source: htmlSource,
    sourceSha256: LIVE_SOURCE_PINS["index.html"],
    substitutions: HTML_SUBSTITUTIONS,
  });
  const game = applyGuardedSubstitutions({
    file: "src/client/webGame.js",
    source: gameSource,
    sourceSha256: LIVE_SOURCE_PINS["src/client/webGame.js"],
    substitutions: WEBGAME_SUBSTITUTIONS,
  });

  fs.mkdirSync(stageDir, { recursive: true });
  const copyFromRepo = (relative, target = relative) => copyFile(path.join(repo, relative), path.join(stageDir, target));
  copyFromRepo("index.html");
  copyFromRepo("package.json");
  copyFromRepo("package-lock.json");
  for (const file of listFiles(path.join(repo, "src"))) {
    copyFromRepo(path.relative(repo, file));
  }
  for (const relative of [...SERVED_SCRIPTS, ...HARNESS_SCRIPTS, ...LIVE_SMOKE_SCRIPTS]) {
    copyFromRepo(relative);
  }
  for (const relative of PROVENANCE_FILES) {
    copyFromRepo(relative, path.join("provenance", relative));
  }
  for (const name of ["playwright", "playwright-core"]) {
    for (const file of listFiles(path.join(playwrightModules, name))) {
      copyFile(file, path.join(stageDir, "node_modules", path.relative(playwrightModules, file)));
    }
  }
  const dataModels = {};
  for (const [run, model] of Object.entries(models)) {
    const relative = `data/models/${run}-learned-full.json`;
    copyFile(model.file, path.join(stageDir, relative));
    dataModels[run] = { path: relative, sha256: model.sha256 };
  }
  copyFile(bankPath, path.join(stageDir, "data", "state-bank.json"));
  copyFile(expectationsPath, path.join(stageDir, "data", "node-expectations.json"));
  for (const [name, file] of Object.entries(seedPlans)) {
    copyFile(file, path.join(stageDir, "data", "seed-plans", name));
  }
  fs.writeFileSync(path.join(stageDir, DIAGNOSTIC_HTML), html.output);
  fs.writeFileSync(path.join(stageDir, DIAGNOSTIC_MODULE), game.output);

  // The copied live entry must be byte-identical to its pinned source.
  for (const [relative, pin] of Object.entries(LIVE_SOURCE_PINS)) {
    if (sha256File(path.join(stageDir, relative)) !== pin) {
      throw new Error(`staged live ${relative} is not byte-identical to its pin`);
    }
  }

  const config = buildValidationConfig({
    seed: expectations.match_seeds[0],
    models: dataModels,
    bank: { path: "data/state-bank.json", sha256: bankSha256 },
    expectations: { path: "data/node-expectations.json", sha256: expectationsSha256 },
    engine,
  });
  fs.writeFileSync(path.join(stageDir, "config.json"), `${JSON.stringify(config, null, 1)}\n`);

  let git = null;
  if (args["git-root"] && args["git-root"] !== true) {
    const run = (...gitArgs) => execFileSync("git", ["-C", args["git-root"], ...gitArgs]);
    git = {
      head: run("rev-parse", "HEAD").toString().trim(),
      tracked_diff_sha256: sha256Hex(run("diff", "HEAD", "--binary")),
      status_porcelain_sha256: sha256Hex(run("status", "--porcelain=v1", "--untracked-files=all")),
    };
  }
  const manifest = writeStageManifest(stageDir, {
    repo,
    git,
    node: { version: process.version, exec_path: process.execPath, sha256: sha256File(process.execPath) },
    playwright: {
      version: playwrightVersion,
      core_version: coreVersion,
      lockfile_version: lockedPlaywright,
      browser: pinnedBrowser,
    },
    substitutions: [
      ...html.records.map((record) => ({ file: "index.html", output: DIAGNOSTIC_HTML, ...record })),
      ...game.records.map((record) => ({ file: "src/client/webGame.js", output: DIAGNOSTIC_MODULE, ...record })),
    ],
    generated: { [DIAGNOSTIC_HTML]: html.output_sha256, [DIAGNOSTIC_MODULE]: game.output_sha256 },
    pins: {
      models: MODEL_PINS,
      bank_sha256: bankSha256,
      expectations_sha256: expectationsSha256,
      seed_plans: planHashes,
      live_v1: LIVE_V1_PIN,
    },
  });
  console.log(JSON.stringify({
    stage: stageDir,
    files: Object.keys(manifest.files).length,
    closure_sha256: manifest.closure_sha256,
    manifest_sha256: sha256File(path.join(stageDir, "MANIFEST.json")),
    substitutions: manifest.substitutions.map(({ file, id, start_line, removed_lines, added_lines }) =>
      `${file}:${start_line} ${id} -${removed_lines}/+${added_lines}`),
  }, null, 1));
}

function sha256SumsText(files, manifestSha256) {
  const sums = Object.entries({ ...files, "MANIFEST.json": manifestSha256 })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, digest]) => `${digest}  ${file}`)
    .join("\n");
  return `${sums}\n`;
}

// Hash every file already in the stage and write MANIFEST.json and SHA256SUMS.
// The closure is the hash of the file map; MANIFEST.json and SHA256SUMS are
// outside it.
export function writeStageManifest(stageDir, { repo, git, node, playwright, substitutions, generated, pins }) {
  const files = {};
  for (const file of listFiles(stageDir).sort()) {
    files[path.relative(stageDir, file)] = sha256File(file);
  }
  const manifest = {
    schema_version: STAGE_SCHEMA,
    created_at: new Date().toISOString(),
    stage_dir: stageDir,
    repo,
    git,
    node,
    playwright,
    live_sources: LIVE_SOURCE_PINS,
    substitutions,
    generated,
    pins,
    config_sha256: files["config.json"],
    files,
  };
  manifest.closure_sha256 = sha256Hex(JSON.stringify(files));
  fs.writeFileSync(path.join(stageDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  fs.writeFileSync(
    path.join(stageDir, "SHA256SUMS"),
    sha256SumsText(files, sha256File(path.join(stageDir, "MANIFEST.json"))),
  );
  return manifest;
}

function tryReadJson(file, label, problems) {
  try {
    return readJson(file);
  } catch (error) {
    problems.push(`cannot read ${label} ${file}: ${error.message.split("\n")[0]}`);
    return null;
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileHashProblem(file, expected, label) {
  if (typeof file !== "string" || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return `${label} ${file} is missing`;
  }
  const actual = sha256File(file);
  return actual === expected ? null : `${label} ${file} hashes to ${actual}, not ${expected}`;
}

// Rehash the stage from disk: every manifest file present and unchanged, no
// unlisted files, no symbolic links or other special entries (none are
// followed), the closure, config, live-source, generated-module and
// SHA256SUMS pins consistent, the pinned Node and browser binaries unchanged,
// and the config bound to the pinned models, bank, expectations and seed.
// modelPins exists for synthetic test stages; the CLI always uses MODEL_PINS.
export function verifyStageClosure(stageDir, { modelPins = MODEL_PINS } = {}) {
  const problems = [];
  const manifestPath = path.join(stageDir, "MANIFEST.json");
  const manifest = tryReadJson(manifestPath, "stage manifest", problems);
  if (!manifest) {
    return { manifest: null, config: null, expectations: null, problems };
  }
  if (manifest.schema_version !== STAGE_SCHEMA) {
    problems.push(`stage manifest schema ${manifest.schema_version} is not ${STAGE_SCHEMA}`);
  }
  if (manifest.stage_dir !== stageDir) {
    problems.push(`stage manifest names ${manifest.stage_dir}, not ${stageDir}`);
  }
  const listed = manifest.files ?? {};
  const inventory = inventoryFiles(stageDir);
  for (const { file, kind } of inventory.unsupported) {
    problems.push(`unsupported ${kind} ${path.relative(stageDir, file)}`);
  }
  const onDisk = new Set(inventory.files.map((file) => path.relative(stageDir, file)));
  for (const [relative, digest] of Object.entries(listed)) {
    if (!onDisk.has(relative)) {
      problems.push(`missing ${relative}`);
    } else if (sha256File(path.join(stageDir, relative)) !== digest) {
      problems.push(`changed ${relative}`);
    }
  }
  for (const relative of onDisk) {
    if (!(relative in listed) && !STAGE_METADATA_FILES.includes(relative)) {
      problems.push(`unlisted ${relative}`);
    }
  }
  if (sha256Hex(JSON.stringify(listed)) !== manifest.closure_sha256) {
    problems.push("manifest closure hash does not match its file list");
  }
  if (!onDisk.has("SHA256SUMS") ||
    fs.readFileSync(path.join(stageDir, "SHA256SUMS"), "utf8") !== sha256SumsText(listed, sha256File(manifestPath))) {
    problems.push("SHA256SUMS does not match the manifest");
  }
  if (!sameJson(manifest.live_sources, LIVE_SOURCE_PINS)) {
    problems.push("manifest live-source pins differ from this tool's pins");
  }
  for (const [relative, pin] of Object.entries(LIVE_SOURCE_PINS)) {
    if (listed[relative] !== pin) {
      problems.push(`live ${relative} is not the pinned source`);
    }
  }
  for (const [relative, digest] of Object.entries(manifest.generated ?? {})) {
    if (listed[relative] !== digest) {
      problems.push(`generated ${relative} differs from its recorded hash`);
    }
  }
  if (!manifest.generated?.[DIAGNOSTIC_HTML] || !manifest.generated?.[DIAGNOSTIC_MODULE]) {
    problems.push("manifest does not record both generated diagnostic files");
  }
  const configPath = path.join(stageDir, "config.json");
  const configSha256 = onDisk.has("config.json") ? sha256File(configPath) : null;
  if (configSha256 === null || configSha256 !== manifest.config_sha256 || listed["config.json"] !== configSha256) {
    problems.push("config.json does not match the manifest's config pin");
  }
  const nodeProblem = fileHashProblem(manifest.node?.exec_path, manifest.node?.sha256, "pinned Node");
  if (nodeProblem) {
    problems.push(nodeProblem);
  }
  problems.push(...browserPinProblems(manifest.playwright?.browser));
  const config = configSha256 === null ? null : tryReadJson(configPath, "stage config", problems);
  let expectations = null;
  if (config) {
    if (config.schema_version !== VALIDATION_CONFIG_SCHEMA) {
      problems.push(`config schema ${config.schema_version} is not ${VALIDATION_CONFIG_SCHEMA}`);
    }
    if (config.browser?.engine !== manifest.playwright?.browser?.engine) {
      problems.push(`config browser ${config.browser?.engine} is not the pinned ${manifest.playwright?.browser?.engine}`);
    }
    if (!sameJson(manifest.pins?.models, modelPins)) {
      problems.push("manifest model pins differ from this tool's pins");
    }
    for (const [run, pin] of Object.entries(modelPins)) {
      const model = config.models?.[run];
      if (model?.sha256 !== pin || listed[model?.path] !== pin) {
        problems.push(`config model ${run} is not the pinned, staged model`);
      }
    }
    if (config.bank?.sha256 !== manifest.pins?.bank_sha256 || listed[config.bank?.path] !== config.bank?.sha256) {
      problems.push("config bank is not the pinned, staged bank");
    }
    if (config.expectations?.sha256 !== manifest.pins?.expectations_sha256 ||
      listed[config.expectations?.path] !== config.expectations?.sha256) {
      problems.push("config expectations are not the pinned, staged expectations");
    } else {
      expectations = tryReadJson(path.join(stageDir, config.expectations.path), "staged expectations", problems);
      if (expectations && config.seed !== expectations.match_seeds?.[0]) {
        problems.push(`config seed ${config.seed} is not the expectations' match seed ${expectations.match_seeds?.[0]}`);
      }
    }
    const declared = [config.deadlines?.item_s, config.deadlines?.bank_check_s, config.smoke?.preview?.match_wall_cap_s];
    if (!declared.every((value) => Number.isFinite(value) && value > 0)) {
      problems.push("config does not declare the item, bank-check and preview deadlines");
    }
    const display = BROWSER_ENGINES[config.browser?.engine];
    if (display && (config.browser.device_scale_factor !== display.device_scale_factor ||
      !sameJson(config.browser.launch_args, display.launch_args) || !sameJson(config.browser.window, display.window))) {
      problems.push(`config display settings differ from the ${config.browser.engine} decision`);
    }
    if (!sameJson(config.live_v1, LIVE_V1_PIN) || !sameJson(manifest.pins?.live_v1, LIVE_V1_PIN) ||
      listed[LIVE_V1_PIN.module] !== LIVE_V1_PIN.module_sha256) {
      problems.push("config, manifest or staged module differ from the live-v1 pin");
    }
    if (expectations && (expectations.live_v1?.module_sha256 !== LIVE_V1_PIN.module_sha256 ||
      expectations.live_v1?.artifact_sha256 !== LIVE_V1_PIN.artifact_sha256)) {
      problems.push("staged expectations were not built from the pinned live v1");
    }
    if (!sameJson(config.measurement, buildMeasurementConfig(config.seed))) {
      problems.push("config measurement plan differs from this tool's plan");
    }
  }
  return { manifest, config, expectations, problems };
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// target with the symbolic links of its deepest existing ancestor resolved, so
// containment compares physical locations rather than spellings.
function physicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      throw error;
    }
    return path.join(physicalPath(parent), path.basename(resolved));
  }
}

// A worker report must be bound to exactly this stage, config and pins.
function reportBindingProblems(report, label, { stage, manifest, manifestSha256, config }) {
  const problems = [];
  const bound = report.stage ?? {};
  if (bound.dir !== stage) {
    problems.push(`${label} ran on stage ${bound.dir}, not ${stage}`);
  }
  if (manifest && bound.closure_sha256 !== manifest.closure_sha256) {
    problems.push(`${label} ran on a different stage closure`);
  }
  if (bound.manifest_sha256 !== manifestSha256) {
    problems.push(`${label} ran on a different stage manifest`);
  }
  if (manifest && bound.config_sha256 !== manifest.config_sha256) {
    problems.push(`${label} ran on a different stage config`);
  }
  if (manifest && !sameJson(bound.git, manifest.git)) {
    problems.push(`${label}'s recorded source state differs from the manifest`);
  }
  if (config && !sameJson(report.caps, config.caps)) {
    problems.push(`${label} caps differ from the stage config`);
  }
  const environment = report.environment ?? {};
  if (manifest && (environment.node !== manifest.node?.version || !sameJson(environment.playwright, manifest.playwright))) {
    problems.push(`${label} ran with a different Node or Playwright/browser pin`);
  }
  if (config && !sameJson(environment.browser, config.browser)) {
    problems.push(`${label} browser settings differ from the stage config`);
  }
  if (environment.chromium_exited !== true) {
    problems.push(`${label} did not confirm that Chromium exited`);
  }
  return problems;
}

// The supervised run that wrote a report: admitted, completed, cleaned up,
// running this stage's worker (with exactly workerArgs) under the pinned Node
// and the configured limits, with the report written inside the run.
function supervisorProblems(supervisor, label, { stage, reportPath, report, manifest, config, wallCapS, workerArgs }) {
  const problems = [];
  if (supervisor.schema_version !== SUPERVISOR_SCHEMA) {
    problems.push(`${label} supervisor schema ${supervisor.schema_version} is not ${SUPERVISOR_SCHEMA}`);
  }
  if (supervisor.admission?.admitted !== true) {
    problems.push(`${label} supervisor did not admit the run`);
  }
  if (supervisor.stop_reason !== "worker_complete" || supervisor.worker_exit?.code !== 0 ||
    supervisor.worker_exit?.signal !== null) {
    problems.push(`${label} supervisor ended with ${supervisor.stop_reason}, worker exit ${JSON.stringify(supervisor.worker_exit)}`);
  }
  if (supervisor.cleanup?.verified !== true || supervisor.cleanup?.worker_reaped !== true ||
    (supervisor.cleanup?.remaining ?? [null]).length !== 0) {
    problems.push(`${label} supervisor cleanup was not verified with the worker reaped`);
  }
  if (supervisor.last_worker_progress?.phase !== "complete") {
    problems.push(`${label}: the worker's last progress record is not complete`);
  }
  if (supervisor.out_dir !== path.dirname(path.dirname(path.resolve(reportPath)))) {
    problems.push(`the ${label} report is not the supervised run's report`);
  }
  if (supervisor.cwd !== stage ||
    path.resolve(supervisor.cwd ?? "", supervisor.command?.[1] ?? "") !==
      path.join(stage, "scripts", "edger-v2-runtime-cost-browser-worker.mjs") ||
    !sameJson((supervisor.command ?? []).slice(2), workerArgs)) {
    problems.push(`the ${label} supervisor did not run this stage's worker with ${JSON.stringify(workerArgs)}`);
  }
  if (manifest) {
    const nodeProblem = fileHashProblem(supervisor.command?.[0], manifest.node?.sha256, `${label} supervised worker Node`);
    if (nodeProblem) {
      problems.push(nodeProblem);
    }
  }
  const limits = supervisor.limits ?? {};
  if (config && (
    limits.wallCapMs !== wallCapS * 1000 ||
    limits.admissionFreeBytes !== config.limits.admission_free_gib * GIB ||
    limits.reserveFreeBytes !== config.limits.reserve_free_gib * GIB ||
    limits.outputCapBytes !== config.limits.output_cap_gib * GIB
  )) {
    problems.push(`${label} supervisor limits differ from the stage config`);
  }
  if ((limits.conditionSlackMs ?? 0) !== 0) {
    problems.push(`${label} supervisor extended condition deadlines by ${limits.conditionSlackMs} ms`);
  }
  if (report && !(Date.parse(supervisor.started_at) <= Date.parse(report.started_at) &&
    Date.parse(report.updated_at) <= Date.parse(supervisor.ended_at))) {
    problems.push(`the ${label} report was not written inside the supervised run`);
  }
  return problems;
}

// Everything freeze requires, as a list of problems (empty when admissible).
// modelPins and predecessorSha256 exist for synthetic test stages; the CLI
// always uses MODEL_PINS and PREDECESSOR_FREEZE_SHA256.
export function checkFreezeInputs({
  stageDir,
  validationPath,
  supervisorPath,
  dryRunPath,
  dryRunSupervisorPath,
  gatesPath,
  predecessorPath,
  modelPins = MODEL_PINS,
  predecessorSha256 = PREDECESSOR_FREEZE_SHA256,
}) {
  const stage = path.resolve(stageDir);
  const { manifest, config, expectations, problems } = verifyStageClosure(stage, { modelPins });
  const validation = tryReadJson(validationPath, "validation report", problems);
  const supervisor = tryReadJson(supervisorPath, "supervisor record", problems);
  const dryRun = tryReadJson(dryRunPath, "measurement dry-run report", problems);
  const dryRunSupervisor = tryReadJson(dryRunSupervisorPath, "dry-run supervisor record", problems);
  const gates = tryReadJson(gatesPath, "gate record", problems);
  const manifestSha256 = manifest ? sha256File(path.join(stage, "MANIFEST.json")) : null;
  const binding = { stage, manifest, manifestSha256, config };
  const predecessorProblem = fileHashProblem(predecessorPath, predecessorSha256, "predecessor freeze");
  if (predecessorProblem) {
    problems.push(predecessorProblem);
  }

  let plan = null;
  let dryPlan = null;
  if (config && expectations) {
    try {
      plan = buildPlan(config, expectations);
      dryPlan = buildMeasurementPlan(config, expectations, "dry_run");
    } catch (error) {
      problems.push(`cannot rebuild the validation or dry-run plan: ${error.message}`);
    }
  }

  if (validation) {
    if (validation.schema_version !== BROWSER_VALIDATION_SCHEMA) {
      problems.push(`validation schema ${validation.schema_version} is not ${BROWSER_VALIDATION_SCHEMA}`);
    }
    if (validation.passed !== true || validation.status !== "complete" || validation.stop_reason !== null) {
      problems.push(`browser validation did not pass (status ${validation.status}, stop ${validation.stop_reason})`);
    }
    if (validation.partial_plan !== null) {
      problems.push("validation ran a filtered plan");
    }
    if ((validation.failures ?? [null]).length !== 0 || (validation.not_run ?? [null]).length !== 0) {
      problems.push("validation recorded failures or items not run");
    }
    problems.push(...reportBindingProblems(validation, "validation", binding));
    if (config && !sameJson(validation.limits, config.limits)) {
      problems.push("validation limits differ from the stage config");
    }
    if (plan) {
      const planned = plannedCoverage(plan);
      const completed = validation.coverage?.completed ?? {};
      if (!sameJson(validation.coverage?.planned, planned)) {
        problems.push("validation's planned coverage is not the stage config's full plan");
      }
      const expectedCompleted = {
        smoke: planned.smoke_viewports,
        jump: planned.jump_matches,
        bank_checks: planned.bank_checks,
        fast_forward: planned.fast_forward_matches,
        fast_forward_v1_baseline: planned.fast_forward_v1_baseline_matches,
        real_time: planned.real_time_matches,
      };
      for (const [key, count] of Object.entries(expectedCompleted)) {
        if (completed[key] !== count) {
          problems.push(`validation completed ${completed[key] ?? 0} ${key}, expected ${count}`);
        }
      }
      const items = validation.items ?? [];
      if (!sameJson(items.map((item) => item.id), plan.map((item) => item.id)) || !items.every((item) => item.passed === true)) {
        problems.push("validation items are not the full plan, in order, all passed");
      }
      const plannedMatches = plan.flatMap((item) => (item.matches ? item.matches.map((match) => match.id)
        : item.phase === "smoke" ? [] : [item.id])).sort();
      const matches = validation.matches ?? [];
      if (!sameJson(matches.map((match) => match.id).sort(), plannedMatches) ||
        !matches.every((match) => match.passed === true && (match.failed_checks ?? [null]).length === 0)) {
        problems.push("validation match records are not every planned match, all passed");
      }
    }
  }
  if (supervisor) {
    problems.push(...supervisorProblems(supervisor, "validation", {
      ...binding, reportPath: validationPath, report: validation,
      wallCapS: config?.limits.validation_wall_cap_s, workerArgs: [],
    }));
  }

  if (dryRun) {
    if (dryRun.schema_version !== MEASUREMENT_SCHEMA || dryRun.mode !== "dry_run") {
      problems.push(`dry-run report is ${dryRun.schema_version} ${dryRun.mode}, not ${MEASUREMENT_SCHEMA} dry_run`);
    }
    if (dryRun.passed !== true || dryRun.status !== "dry_run_complete" || dryRun.stop_reason !== null ||
      (dryRun.failures ?? [null]).length !== 0 || (dryRun.incomplete ?? [null]).length !== 0) {
      problems.push(`measurement dry run did not pass (status ${dryRun.status}, stop ${dryRun.stop_reason})`);
    }
    problems.push(...reportBindingProblems(dryRun, "dry run", binding));
    if (dryPlan) {
      const items = dryRun.items ?? [];
      if (!sameJson(items.map((item) => item.id), dryPlan.map((item) => item.id)) || !items.every((item) => item.passed === true)) {
        problems.push("dry-run items are not the full dry-run plan, in order, all passed");
      }
    }
  }
  if (dryRunSupervisor) {
    problems.push(...supervisorProblems(dryRunSupervisor, "dry run", {
      ...binding, reportPath: dryRunPath, report: dryRun,
      wallCapS: config?.limits.measurement_dry_run_wall_cap_s, workerArgs: ["--measure", "dry_run"],
    }));
  }

  const gateLogs = {};
  if (gates) {
    if (gates.schema_version !== GATES_SCHEMA) {
      problems.push(`gate schema ${gates.schema_version} is not ${GATES_SCHEMA}`);
    }
    const entries = Array.isArray(gates.gates) ? gates.gates : [];
    for (const required of REQUIRED_FREEZE_GATES) {
      const found = entries.filter((gate) => typeof gate?.command === "string" && required.matches(gate.command));
      if (found.length !== 1) {
        problems.push(`gate ${required.id} is recorded ${found.length} times, expected once`);
      }
    }
    const runRoot = path.dirname(path.dirname(path.resolve(gatesPath)));
    for (const gate of entries) {
      if (gate?.passed !== true || typeof gate?.result !== "string" || gate.result.length === 0) {
        problems.push(`gate ${gate?.command} did not pass`);
      }
      const log = typeof gate?.log === "string" ? path.resolve(runRoot, gate.log) : null;
      if (!log || !fs.existsSync(log)) {
        problems.push(`gate ${gate?.command} has no log at ${gate?.log}`);
      } else if (fs.statSync(log).isFile()) {
        gateLogs[gate.log] = sha256File(log);
      }
    }
    const lastRun = Math.max(Date.parse(supervisor?.ended_at), Date.parse(dryRunSupervisor?.ended_at));
    if (!(Date.parse(gates.recorded_at) >= lastRun)) {
      problems.push("gates were recorded before the supervised validation and dry run ended");
    }
  }
  return {
    problems, manifest, manifestSha256, config, expectations, validation, supervisor, dryRun, dryRunSupervisor,
    gates, gateLogs,
  };
}

// Create outPath with content, never replacing an existing file: write a
// private temporary file, hard-link it into place (EEXIST if taken) and make
// the result read-only.
function writeNewReadOnly(outPath, content) {
  const temporary = path.join(path.dirname(outPath), `.${path.basename(outPath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content, { flag: "wx" });
  try {
    fs.linkSync(temporary, outPath);
  } finally {
    fs.unlinkSync(temporary);
  }
  fs.chmodSync(outPath, 0o444);
}

// The rendered profiling matrix of the cost plan: r0/r1/r2 x learned/every-tick
// x both sides x portrait/desktop on the predeclared development seed. Order
// alternates viewport and side within each model so drift is not confounded.
export function profilingMatrix(seed) {
  const conditions = [];
  for (const model of ["r0", "r1", "r2"]) {
    for (const controller of ["learned", "fixed_one_tick"]) {
      for (const viewport of ["portrait", "desktop"]) {
        for (const candidateActor of ["blue", "red"]) {
          conditions.push({
            id: `${seed}-${model}-${controller}-${candidateActor}-${viewport}`,
            seed,
            model,
            controller,
            candidate_actor: candidateActor,
            viewport,
            clock: "raf",
            collectors: true,
          });
        }
      }
    }
  }
  return conditions;
}

// Check every input, then write the freeze as a new read-only file.
export function freezeStage({
  stage, validation, supervisor, dryRun, dryRunSupervisor, gates, predecessor, out, modelPins = MODEL_PINS,
  predecessorSha256 = PREDECESSOR_FREEZE_SHA256,
}) {
  const stageDir = path.resolve(stage);
  const validationPath = path.resolve(validation);
  const supervisorPath = path.resolve(supervisor);
  const dryRunPath = path.resolve(dryRun);
  const dryRunSupervisorPath = path.resolve(dryRunSupervisor);
  const gatesPath = path.resolve(gates);
  const predecessorPath = path.resolve(predecessor);
  const outPath = path.resolve(out);
  const checked = checkFreezeInputs({
    stageDir, validationPath, supervisorPath, dryRunPath, dryRunSupervisorPath, gatesPath, predecessorPath, modelPins,
    predecessorSha256,
  });
  const { problems, manifest, manifestSha256, config, gateLogs } = checked;
  // lstat, so a dangling link at the name also counts as taken. A file in the
  // parent chain (ENOTDIR) is refused by the directory check below.
  let taken = false;
  try {
    taken = fs.lstatSync(outPath, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (error.code !== "ENOTDIR") {
      throw error;
    }
  }
  if (taken) {
    problems.push(`${outPath} already exists; freezes are never overwritten`);
  }
  // Containment and the write both use the output directory's resolved path,
  // so a directory alias cannot place the freeze in a protected directory.
  let target = null;
  try {
    const directory = fs.realpathSync(path.dirname(outPath));
    if (fs.statSync(directory).isDirectory()) {
      target = path.join(directory, path.basename(outPath));
    } else {
      problems.push(`the freeze directory ${path.dirname(outPath)} is not a directory`);
    }
  } catch (error) {
    problems.push(`the freeze directory ${path.dirname(outPath)} does not resolve to an existing directory (${error.code})`);
  }
  if (target && isInside(target, physicalPath(stageDir))) {
    problems.push("the freeze cannot be written inside the stage");
  }
  for (const [label, record] of [["validation", checked.supervisor], ["dry-run", checked.dryRunSupervisor]]) {
    if (target && record?.out_dir && isInside(target, physicalPath(record.out_dir))) {
      problems.push(`the freeze cannot be written inside the ${label} output`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`refusing to freeze:\n- ${problems.join("\n- ")}`);
  }
  const measurement = config.measurement;
  const freeze = {
    schema_version: PROFILING_FREEZE_SCHEMA,
    frozen_at: new Date().toISOString(),
    freeze_tool: { script: "scripts/edger-v2-runtime-cost-stage.mjs", sha256: sha256File(fileURLToPath(import.meta.url)) },
    predecessor: {
      path: predecessorPath,
      sha256: predecessorSha256,
      relation: "measurement-repair successor of the reviewed October 6 successor freeze: path-isolated model " +
        "objects, observer-overhead boundary, endpoint-checked browser GC pairs and full Node GC coverage; the " +
        "28 conditions and their order, weights, controllers, timing method and limits are unchanged",
    },
    stage: {
      dir: stageDir,
      closure_sha256: manifest.closure_sha256,
      manifest_sha256: manifestSha256,
      config_sha256: manifest.config_sha256,
      files_rehashed: Object.keys(manifest.files).length,
    },
    validation: { path: validationPath, sha256: sha256File(validationPath) },
    supervisor: { path: supervisorPath, sha256: sha256File(supervisorPath) },
    measurement_dry_run: {
      report: { path: dryRunPath, sha256: sha256File(dryRunPath) },
      supervisor: { path: dryRunSupervisorPath, sha256: sha256File(dryRunSupervisorPath) },
    },
    gates_file: { path: gatesPath, sha256: sha256File(gatesPath), logs: gateLogs },
    gates: checked.gates,
    schemas: {
      browser: "edger_v2_runtime_cost_browser_v2",
      samples: "edger_v2_runtime_cost_samples_v2",
      validation: BROWSER_VALIDATION_SCHEMA,
      measurement: MEASUREMENT_SCHEMA,
      measurement_config: MEASUREMENT_CONFIG_SCHEMA,
      complete_path: COMPLETE_PATH_SCHEMA,
      existing_method: EXISTING_METHOD_SCHEMA,
      supervisor: SUPERVISOR_SCHEMA,
    },
    rendered_matrix: {
      conditions: measurement.rendered.conditions,
      v2_conditions: profilingMatrix(config.seed).length,
      v1_baselines: v1BaselineMatrix(config.seed).length,
      browser: config.browser,
      viewports: config.viewports,
      warm_frames: config.real_time.warm_frames,
      caps: config.caps,
      max_ticks: config.max_ticks,
      match_wall_cap_s: measurement.rendered.match_wall_cap_s,
      deadline_enforcement: "supervisor, exact: startMatch through the final result, no slack",
      display: "per-page CDP fullscreen under --kiosk; settled admission before each match and monitoring at " +
        "every poll; a violation stops that condition as incomplete",
    },
    live_v1: config.live_v1,
    measurement,
    deadlines: config.deadlines,
    limits: {
      total_wall_cap_s: measurement.total_wall_cap_s,
      active_matches: 1,
      admission_free_gib: config.limits.admission_free_gib,
      reserve_free_gib: config.limits.reserve_free_gib,
      output_cap_gib: config.limits.output_cap_gib,
      automatic_retries: 0,
    },
    run: {
      worker_args: ["--measure", "full"],
      supervisor: `--wall-cap-s ${measurement.total_wall_cap_s} --admission-free-gib ${config.limits.admission_free_gib} ` +
        `--reserve-free-gib ${config.limits.reserve_free_gib} --output-cap-gib ${config.limits.output_cap_gib}`,
      requires: "a .noindex stage and output directory (the worker refuses otherwise), a fresh Spotlight " +
        "sentinel check, a fresh free-space check and an observed quiet host",
    },
  };
  writeNewReadOnly(target, `${JSON.stringify(freeze, null, 1)}\n`);
  return { freeze: target, sha256: sha256File(target), conditions: freeze.rendered_matrix.conditions.length };
}

function freezeCommand(args) {
  const result = freezeStage({
    stage: required(args, "stage"),
    validation: required(args, "validation"),
    supervisor: required(args, "supervisor"),
    dryRun: required(args, "dry-run"),
    dryRunSupervisor: required(args, "dry-run-supervisor"),
    gates: required(args, "gates"),
    predecessor: required(args, "predecessor"),
    out: required(args, "out"),
  });
  console.log(JSON.stringify(result, null, 1));
}

const COMMANDS = { stage: stageCommand, freeze: freezeCommand };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command) {
    console.error(`usage: edger-v2-runtime-cost-stage.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
    process.exit(2);
  }
  try {
    command(args);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  }
}
