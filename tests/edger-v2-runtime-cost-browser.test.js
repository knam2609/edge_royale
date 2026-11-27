import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEdgerV2BootstrapModel, validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import { runEdgerV2CadenceMatch } from "../scripts/edger-v2-cadence-core.mjs";
import {
  EDGER_V1_BASELINE_PHASES,
  EDGER_V2_DIAGNOSTIC_CONTROLLERS,
  EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES,
  EDGER_V2_DIAGNOSTIC_PHASES,
} from "../scripts/edger-v2-runtime-cost-adapter.js";
import {
  RUNTIME_COST_KIND_CODES,
  RUNTIME_COST_TABLE_COLUMNS,
  createRuntimeCostCollectors,
  createSampleTable,
  summarizeRuntimeCostTables,
  summarizeSamples,
} from "../scripts/edger-v2-runtime-cost-collectors.js";
import {
  buildNodeExpectations,
  buildStateBank,
  rebuildEngineAt,
  runDiagnosticMatch,
} from "../scripts/edger-v2-runtime-cost-core.mjs";
import {
  BROWSER_VALIDATION_SCHEMA,
  FAVICON_MISSING_RESOURCE,
  MEASUREMENT_SCHEMA,
  admitBrowserGcPair,
  admitNodeGcPair,
  browserTreeDigest,
  buildMeasurementPlan,
  buildPlan,
  checkDisplayGeometry,
  checkJumpFrames,
  checkMatchAgainstExpectation,
  checkWindowAgainstExpectation,
  deadlineRecord,
  jumpSchedule,
  plannedCoverage,
  pngSize,
  retainedConsoleError,
  startStageServer,
  summarizeChromeTrace,
  verifyStage,
  windowEndpoint,
} from "../scripts/edger-v2-runtime-cost-browser-worker.mjs";
import {
  COMPLETE_PATH_SCHEMA,
  EXISTING_METHOD_SCHEMA,
  GC_TRACE_SCOPE,
  completePathCoverageProblems,
  completePathPlan,
  loadPathModels,
  measureCompletePath,
  modelIdentityProblems,
  summarizeHeapProfile,
  timedCall,
} from "../scripts/edger-v2-runtime-cost-measure.mjs";
import {
  createOwnershipRegistry,
  createTreeCpuTracker,
  parseCpuSeconds,
  parsePsOutput,
  treeCpuSeconds,
} from "../scripts/edger-v2-runtime-cost-process.mjs";
import {
  DIAGNOSTIC_HTML,
  DIAGNOSTIC_MODULE,
  GATES_SCHEMA,
  HTML_SUBSTITUTIONS,
  LIVE_SOURCE_PINS,
  WEBGAME_SUBSTITUTIONS,
  applyGuardedSubstitutions,
  BROWSER_ENGINES,
  LIVE_V1_PIN,
  PREDECESSOR_FREEZE_SHA256,
  buildMeasurementConfig,
  buildValidationConfig,
  checkFreezeInputs,
  freezeStage,
  profilingMatrix,
  sha256Hex,
  v1BaselineMatrix,
  writeStageManifest,
} from "../scripts/edger-v2-runtime-cost-stage.mjs";
import { SUPERVISOR_SCHEMA, expiredDeadline, superviseWorker } from "../scripts/edger-v2-runtime-cost-supervisor.mjs";

const { LEARNED, FIXED_ONE_TICK } = EDGER_V2_DIAGNOSTIC_CONTROLLERS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The live-v1 module the October study pinned (LIVE_V1_PIN), kept byte for byte
// since the November 2026 v2 promotion replaced the live module.
const RETIRED_V1_MODULE = path.join(ROOT, "artifacts/edger-training/retired/edger_policy_bootstrap_20260701/edgerPolicyCurrent.js");
const DEV_SEED = 1836353410;
const FAKE_WORKER = path.join(ROOT, "tests", "fixtures", "runtime-cost-fake-worker.mjs");
const SUPERVISOR = path.join(ROOT, "scripts", "edger-v2-runtime-cost-supervisor.mjs");
const GIB = 1024 ** 3;

function randomModel(seed, { playBias = 1.5 } = {}) {
  const model = createEdgerV2BootstrapModel({ modelId: `runtime-cost-browser-test-${seed}` });
  const rng = createRng(seed);
  const fill = (values) => {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = (rng() * 2 - 1) * 0.35;
    }
  };
  for (const layer of Object.values(model.weights)) {
    if (Array.isArray(layer)) {
      fill(layer);
    } else {
      fill(layer.weights);
      fill(layer.bias);
    }
  }
  const delayHead = model.weights.delay_head;
  for (let index = 0; index < delayHead.weights.length; index += 1) {
    delayHead.weights[index] *= 6;
  }
  model.weights.card_head.bias[0] -= playBias;
  return validateEdgerV2PolicyModel(model);
}

const tempDirs = [];
function tempDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `edger-runtime-cost-${label}-`));
  tempDirs.push(directory);
  return directory;
}
test.after(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("driver observer hooks see both sides without changing schedule, stream or state", () => {
  const model = randomModel(31);
  const seenKinds = { play: 0, elective_pass: 0, forced_pass: 0, illegal: 0 };
  for (const controller of [LEARNED, FIXED_ONE_TICK]) {
    const candidatePhases = [];
    const opponentPhases = [];
    const scheduleDetails = [];
    const construct = [];
    const observed = runDiagnosticMatch({
      seed: DEV_SEED,
      candidateActor: "red",
      model,
      controller,
      phaseHook: (phase, detail) => {
        candidatePhases.push(phase);
        if (phase === "schedule") {
          scheduleDetails.push(detail);
        }
      },
      opponentHook: (phase, detail) => {
        opponentPhases.push(phase);
        if (phase === "construct") {
          construct.push(detail);
        }
      },
    });
    const plain = runDiagnosticMatch({ seed: DEV_SEED, candidateActor: "red", model, controller });
    assert.equal(observed.action_stream_hash, plain.action_stream_hash);
    assert.equal(observed.final_state_hash, plain.final_state_hash);
    assert.deepEqual(observed.schedule, plain.schedule);
    assert.deepEqual(observed.decision_kinds, plain.decision_kinds);

    const reference = runEdgerV2CadenceMatch({
      seed: DEV_SEED, candidateActor: "red", model, cadence: controller, opponentBotId: "edger",
    });
    assert.equal(plain.action_stream_hash, reference.action_stream_hash);

    // Kinds partition the reference counts.
    const kinds = plain.decision_kinds;
    assert.equal(kinds.play, plain.counts.play_attempts);
    assert.equal(kinds.illegal, plain.counts.illegal_attempts);
    assert.equal(kinds.elective_pass + kinds.forced_pass, plain.counts.pass_decisions);
    for (const [kind, count] of Object.entries(kinds)) {
      seenKinds[kind] += count;
    }
    assert.equal(scheduleDetails.length, plain.counts.decisions);
    assert.deepEqual(scheduleDetails.map((detail) => detail.tick), plain.schedule.map((row) => row.tick));

    // Opponent boundaries arrive in declared order, once per opponent decision.
    const opponentOrder = EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES;
    assert.equal(opponentPhases.length, plain.opponent_decisions * opponentOrder.length);
    for (let index = 0; index < opponentPhases.length; index += 1) {
      assert.equal(opponentPhases[index], opponentOrder[index % opponentOrder.length]);
    }
    assert.ok(construct.some((detail) => detail.play) && construct.some((detail) => !detail.play));
    assert.equal(candidatePhases.filter((phase) => phase === "begin").length, plain.counts.decisions);
  }
  assert.ok(seenKinds.forced_pass > 0 && seenKinds.elective_pass > 0 && seenKinds.play > 0, JSON.stringify(seenKinds));
});

test("Node expectations carry the frozen reference's decisions, schedules, kinds and overtime start", () => {
  const models = { t: randomModel(37) };
  const bank = buildStateBank({
    label: "runtime-cost-browser-test-bank",
    seeds: [DEV_SEED],
    models,
    controllers: [LEARNED],
    requiredCategories: ["forced_pass", "elective"],
    perCategory: 2,
    stride: 25,
  });
  const expectations = buildNodeExpectations({
    bank, models, matchSeeds: [DEV_SEED], controllers: [LEARNED], v1Baselines: false,
  });
  assert.equal(expectations.bank_decisions.length, bank.states.length * 2 * 2);
  assert.equal(expectations.full_matches.length, 2);
  for (const entry of expectations.full_matches) {
    const reference = runEdgerV2CadenceMatch({
      seed: DEV_SEED, candidateActor: entry.candidate_actor, model: models.t, cadence: LEARNED,
      opponentBotId: "edger", recordRows: true,
    });
    assert.equal(entry.action_stream_hash, reference.action_stream_hash);
    assert.equal(entry.final_state_hash, reference.final_state_hash);
    assert.deepEqual(entry.result, { winner: reference.winner, reason: reference.reason, tick: reference.tick });
    assert.equal(entry.schedule.length, reference.stats.decisions);
    assert.equal(entry.schedule_sha256, sha256Hex(JSON.stringify(entry.schedule)));
    assert.deepEqual(Object.keys(entry.schedule[0]), ["tick", "card_index", "placement_index", "delay_index", "delay_ticks"]);
    const kinds = entry.decision_kinds;
    assert.equal(kinds.elective_pass + kinds.forced_pass, entry.counts.pass_decisions);
    assert.ok(entry.overtime_start_tick === null || entry.overtime_start_tick >= 3600);
    assert.ok(entry.opponent_decisions > 0);
  }
  // Live-v1 baselines: since the November 2026 v2 promotion the live module is
  // a v2 model, so they are undefined and emission refuses them.
  assert.throws(
    () => buildNodeExpectations({ bank, models, matchSeeds: [DEV_SEED], controllers: [LEARNED] }),
    /the live Edger module is a v2 model; the live-v1 baseline is undefined/,
  );
});

test("sample tables are bounded, refuse rather than overwrite and drain incrementally", () => {
  const table = createSampleTable({ name: "t", columns: ["a", "b"], capacity: 3 });
  const row = new Float64Array(2);
  for (let index = 0; index < 5; index += 1) {
    row[0] = index;
    row[1] = index * 10;
    table.push(row);
  }
  assert.equal(table.length, 3);
  assert.equal(table.refused, 2);
  assert.equal(table.overflowed, true);
  const first = table.drain(2);
  assert.deepEqual(first, { start: 0, rows: [[0, 0], [1, 10]] });
  assert.deepEqual(table.drain(), { start: 2, rows: [[2, 20]] });
  assert.deepEqual(table.drain(), { start: 3, rows: [] });
  assert.throws(() => createSampleTable({ name: "bad", columns: ["a"], capacity: 0 }), /positive integer/);
});

test("collectors attribute candidate, opponent, tick and frame boundaries without allocation per sample", () => {
  let clock = 0;
  const collectors = createRuntimeCostCollectors({
    caps: { frames: 4, ticks: 4, candidate_decisions: 4, v1_candidate_decisions: 4, opponent_decisions: 4 },
    now: () => clock,
  });
  for (const phase of EDGER_V2_DIAGNOSTIC_PHASES.filter((name) => name !== "delay_head")) {
    clock += phase === "card_head" ? 2 : 1;
    collectors.phaseHook(phase, phase === "schedule" ? { tick: 7, kind: "forced_pass" } : undefined);
  }
  for (const phase of EDGER_V2_DIAGNOSTIC_OPPONENT_PHASES) {
    clock += 0.5;
    collectors.opponentHook(phase, phase === "construct" ? { tick: 7, play: true } : undefined);
  }
  collectors.tickParts(7, 100, 101, 104, 105);
  collectors.tickDone(99.5, 105.5);
  collectors.tickDone(106, 106.1); // terminal no-op iteration: no tick row
  collectors.frameDone(1000, 16.5, 60, 10, 2, 1, 6.6, 3, 11, 7);
  const drained = collectors.drain();
  const candidate = drained.candidate_decisions.rows[0];
  const columns = RUNTIME_COST_TABLE_COLUMNS.candidate_decisions;
  assert.equal(candidate[0], 7);
  assert.equal(candidate[1], RUNTIME_COST_KIND_CODES.forced_pass);
  assert.equal(candidate[columns.indexOf("card_head_ms")], 2);
  assert.ok(Number.isNaN(candidate[columns.indexOf("delay_head_ms")]));
  assert.equal(candidate[columns.indexOf("total_ms")], 10);
  assert.deepEqual(drained.opponent_decisions.rows[0], [7, 1, 0.5, 0.5, 0.5, 0.5, 2]);
  assert.deepEqual(drained.ticks.rows, [[7, 0, 6, 1, 3, 1]]);
  assert.deepEqual(drained.frames.rows[0], [0, 1000, 16.5, 60, 10, 2, 1, 6.6, 6, 1, 3, 1, 3, 11, 7]);
  assert.throws(() => collectors.phaseHook("encode"), /outside a decision/);
  // The live-v1 candidate fills its own table; the v2 table is untouched.
  for (const phase of EDGER_V1_BASELINE_PHASES) {
    clock += phase === "decide" ? 3 : 1;
    collectors.v1PhaseHook(phase, phase === "schedule" ? { tick: 8, kind: "play" } : undefined);
  }
  const v1 = collectors.drain();
  assert.deepEqual(v1.v1_candidate_decisions.rows, [[8, RUNTIME_COST_KIND_CODES.play, 1, 3, 1, 5]]);
  assert.deepEqual(v1.candidate_decisions.rows, []);
  assert.deepEqual(RUNTIME_COST_TABLE_COLUMNS.v1_candidate_decisions,
    ["tick", "kind", "enumerate_ms", "decide_ms", "schedule_ms", "total_ms"]);
  assert.throws(() => collectors.v1PhaseHook("decide"), /outside a decision/);
  assert.equal(collectors.overflowed(), false);
});

test("summaries use nearest-rank percentiles on raw samples and link slow callbacks to following frames", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  const summary = summarizeSamples([...values, Number.NaN]);
  assert.equal(summary.count, 100);
  assert.equal(summary.missing, 1);
  assert.equal(summary.p50, 50);
  assert.equal(summary.p95, 95);
  assert.equal(summary.p99, 99);
  assert.equal(summary.max, 100);

  const frame = (callback, advances, iterations = advances) =>
    [0, 0, 16, 60, iterations === advances ? 10 : 46, iterations, advances, 1, 1, 1, 1, 1, 1, callback, 0];
  const tables = summarizeRuntimeCostTables({
    frames: [frame(5, 1), frame(80, 1), frame(5, 3), frame(5, 3, 10)],
  });
  assert.equal(tables.frames.slow_callbacks, 1);
  assert.deepEqual(tables.frames.following_frame_advances_histogram, { 3: 1 });
  assert.equal(tables.frames.multi_tick_frames, 2);
  assert.equal(tables.frames.iterations_exceed_advances_frames, 1);
  assert.equal(tables.frames.max_loop_iterations, 10);
});

test("guarded staging generates the diagnostic module from the pinned live sources only", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const game = fs.readFileSync(path.join(ROOT, "src", "client", "webGame.js"), "utf8");
  const page = applyGuardedSubstitutions({
    file: "index.html", source: html, sourceSha256: LIVE_SOURCE_PINS["index.html"], substitutions: HTML_SUBSTITUTIONS,
  });
  const module = applyGuardedSubstitutions({
    file: "src/client/webGame.js",
    source: game,
    sourceSha256: LIVE_SOURCE_PINS["src/client/webGame.js"],
    substitutions: WEBGAME_SUBSTITUTIONS,
  });
  assert.match(page.output, /src="\.\/src\/client\/webGameRuntimeCost\.js"/);
  assert.doesNotMatch(page.output, /src\/client\/webGame\.js/);
  assert.equal(module.records.length, WEBGAME_SUBSTITUTIONS.length);
  const out = module.output;
  assert.match(out, /installEdgerV2RuntimeCostDiagnostic/);
  assert.match(out, /runtimeCost\.actionsForTick\(appState\.engine, nextTick\)/);
  assert.match(out, /appState\.engine\.step\(actions\);/);
  for (const removed of [
    "buildBotActions(nextTick)",
    "pendingActions.filter",
    "addEventListener(\"keydown\"",
    "addEventListener(\"pointerdown\"",
    "startBtn.addEventListener",
    "window.advanceTime",
    "__edgeRoyaleSmokeFinishMatch",
    "saveStoredJson(PROFILE_STORAGE_KEY",
    "total_matches * 37",
  ]) {
    assert.ok(!out.includes(removed), `${removed} must not survive`);
  }
  // The drain loop keeps its live semantics: uncapped, lag subtracted per iteration.
  assert.match(out, /while \(appState\.lagMs >= tickDurationMs\) \{[\s\S]*?stepGameTick\(\);[\s\S]*?appState\.lagMs -= tickDurationMs;/);
  assert.doesNotMatch(out, /Math\.min\(appState\.lagMs|maxTicksPerFrame/);
  // Overtime and terminal handling are untouched.
  assert.match(out, /if \(appState\.engine\.shouldStartOvertime\(\)\) \{\n    appState\.engine\.setOvertime\(true\);/);
  assert.equal(out.split("requestAnimationFrame(").length - 1, 1, "only the guarded re-arm may request frames");
  const temp = tempDir("stage-check");
  const file = path.join(temp, "webGameRuntimeCost.mjs");
  fs.writeFileSync(file, out);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  // The live files are untouched by staging.
  assert.equal(sha256Hex(game), LIVE_SOURCE_PINS["src/client/webGame.js"]);
});

test("guarded staging rejects changed sources, ambiguous markers, changed blocks and overlaps", () => {
  const source = "alpha\nbeta\ngamma\n";
  const pin = sha256Hex(source);
  const block = (start, end, text) => ({
    id: start.trim(), start, end, block_sha256: sha256Hex(text), replacement: "X\n",
  });
  const ok = applyGuardedSubstitutions({
    file: "f", source, sourceSha256: pin, substitutions: [block("beta\n", null, "beta\n")],
  });
  assert.equal(ok.output, "alpha\nX\ngamma\n");
  assert.throws(() => applyGuardedSubstitutions({
    file: "f", source: `${source} `, sourceSha256: pin, substitutions: [],
  }), /hashes to/);
  assert.throws(() => applyGuardedSubstitutions({
    file: "f", source: "a\na\n", sourceSha256: sha256Hex("a\na\n"), substitutions: [block("a\n", null, "a\n")],
  }), /occurs 2 times/);
  assert.throws(() => applyGuardedSubstitutions({
    file: "f", source, sourceSha256: pin, substitutions: [block("beta\n", null, "other\n")],
  }), /block hashes to/);
  assert.throws(() => applyGuardedSubstitutions({
    file: "f", source, sourceSha256: pin, substitutions: [block("beta\n", "delta\n", "beta\n")],
  }), /end marker not found/);
  assert.throws(() => applyGuardedSubstitutions({
    file: "f",
    source,
    sourceSha256: pin,
    substitutions: [block("alpha\n", "gamma\n", source), block("beta\n", null, "beta\n")],
  }), /overlap/);
});

test("stage server isolates the page and serves only the page closure and data", async () => {
  const root = tempDir("server");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<p>live</p>");
  fs.writeFileSync(path.join(root, "src", "a.js"), "export {};");
  fs.writeFileSync(path.join(root, "data", "m.json"), "{}");
  fs.writeFileSync(path.join(root, "MANIFEST.json"), "{}");
  const { server, url } = await startStageServer(root);
  try {
    const live = await fetch(`${url}/`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(live.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal((await fetch(`${url}/src/a.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${url}/data/m.json`)).status, 200);
    assert.equal((await fetch(`${url}/MANIFEST.json`)).status, 404);
    assert.equal((await fetch(`${url}/src/../MANIFEST.json`)).status, 404);
    assert.equal((await fetch(`${url}/src/%2e%2e/MANIFEST.json`)).status, 404);
  } finally {
    server.close();
  }
});

test("stage server refuses linked files and parents, including replacements after startup", async () => {
  const root = tempDir("server-links");
  const outside = tempDir("server-outside");
  fs.mkdirSync(path.join(root, "src", "real"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real", "a.js"), "export {};\n");
  fs.writeFileSync(path.join(outside, "external.js"), "external\n");
  fs.writeFileSync(path.join(root, "src", "replace.js"), "export {};\n");
  const { server, url } = await startStageServer(root);
  try {
    assert.equal((await fetch(`${url}/src/replace.js`)).status, 200);
    fs.symlinkSync(path.join(outside, "external.js"), path.join(root, "src", "file.js"));
    fs.symlinkSync(outside, path.join(root, "src", "directory"), "dir");
    fs.symlinkSync(path.join(root, "src", "real"), path.join(root, "src", "internal"), "dir");
    fs.symlinkSync(path.join(outside, "absent.js"), path.join(root, "src", "dangling.js"));
    fs.unlinkSync(path.join(root, "src", "replace.js"));
    fs.symlinkSync(path.join(root, "src", "real", "a.js"), path.join(root, "src", "replace.js"));
    const fifo = spawnSync("mkfifo", [path.join(root, "src", "pipe.js")]);
    assert.equal(fifo.status, 0);
    for (const file of ["file.js", "directory/external.js", "internal/a.js", "dangling.js", "replace.js", "pipe.js"]) {
      assert.equal((await fetch(`${url}/src/${file}`)).status, 404, file);
    }
    // Removing the links before freeze cannot erase the earlier server refusal.
    fs.unlinkSync(path.join(root, "src", "replace.js"));
    fs.writeFileSync(path.join(root, "src", "replace.js"), "restored\n");
    assert.equal(await (await fetch(`${url}/src/replace.js`)).text(), "restored\n");
    assert.equal((await fetch(`${url}/src/real/a.js`)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("stage server rejects malformed URLs and continues serving valid requests", async () => {
  const root = tempDir("server-malformed-url");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a b.js"), "export {};\n");
  const { server, url } = await startStageServer(root);
  try {
    for (const pathname of ["/src/%E0%A4%A", "/src/%", "/src/%GG", "/src/%FF"]) {
      const response = await fetch(`${url}${pathname}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 400, pathname);
      assert.equal(await response.text(), "Bad request");
      const valid = await fetch(`${url}/src/a%20b.js`);
      assert.equal(valid.status, 200);
      assert.equal(await valid.text(), "export {};\n");
    }
    // Exercise URL construction as well as percent-decoding, using a raw
    // request target that the client would otherwise normalize or reject.
    const response = await new Promise((resolve, reject) => {
      http.get(`${url}/`, { path: "http://[invalid" }, (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolve(incoming));
      }).once("error", reject);
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await fetch(`${url}/src/a%20b.js`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stage server closes the opened file after each aborted download", async () => {
  const root = tempDir("server-abort");
  fs.mkdirSync(path.join(root, "data"));
  const file = path.join(root, "data", "large.json");
  fs.writeFileSync(file, "");
  // A sparse file keeps the download open without reserving 64 MiB on disk.
  fs.truncateSync(file, 64 * 1024 * 1024);
  const identity = fs.statSync(file);
  const openDescriptors = () => fs.readdirSync("/dev/fd").filter((fd) => {
    try {
      const entry = fs.fstatSync(Number(fd));
      return entry.dev === identity.dev && entry.ino === identity.ino;
    } catch {
      return false;
    }
  }).length;
  const { server, url } = await startStageServer(root);
  try {
    assert.equal(openDescriptors(), 0);
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve, reject) => {
        const request = http.get(`${url}/data/large.json`, (response) => {
          response.once("data", () => {
            try {
              assert.equal(response.statusCode, 200);
              assert.equal(openDescriptors(), 1, "abort while the source file is open");
              request.destroy();
              resolve();
            } catch (error) {
              request.destroy();
              reject(error);
            }
          });
        });
        request.once("error", reject);
      });
      await waitFor(() => openDescriptors() === 0, 5000, `file close after abort ${index + 1}`);
    }
    fs.writeFileSync(path.join(root, "data", "small.json"), "{}\n");
    assert.equal(await (await fetch(`${url}/data/small.json`)).text(), "{}\n");
    assert.equal(openDescriptors(), 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("controlled elapsed jump: exact lag arithmetic yields multi-tick, catch-up and terminal no-op frames", () => {
  // Replays the generated frame loop's lag arithmetic against a match ending at T.
  const terminalTick = 6000;
  const collectors = createRuntimeCostCollectors({
    caps: { frames: 2000, ticks: 7000, candidate_decisions: 1, v1_candidate_decisions: 1, opponent_decisions: 1 },
    now: () => 0,
  });
  let tick = 0;
  let lag = 0;
  let last = 0;
  let now = 0;
  let over = false;
  const frame = () => {
    const elapsed = now - last;
    last = now;
    const before = tick;
    lag += elapsed;
    const preDrain = lag;
    let iterations = 0;
    while (lag >= 50) {
      if (!over) {
        tick += 1;
        over = tick === terminalTick;
      }
      lag -= 50;
      iterations += 1;
    }
    collectors.frameDone(now, elapsed, preDrain, lag, iterations, tick - before, 0, 0, 0, tick);
  };
  for (const step of jumpSchedule(terminalTick)) {
    let count = 0;
    while (!over) {
      if (step.frames !== undefined && count >= step.frames) {
        break;
      }
      if (step.until_tick !== undefined && tick >= step.until_tick) {
        break;
      }
      now += step.elapsed_ms;
      frame();
      count += 1;
    }
  }
  const frames = collectors.drain().frames.rows;
  const result = checkJumpFrames(frames, terminalTick);
  assert.equal(result.passed, true, JSON.stringify(result.checks, null, 1));
  // A schedule that skips the catch-up is detected.
  const broken = frames.filter((row) => row[2] !== 130);
  assert.equal(checkJumpFrames(broken, terminalTick).checks.following_catch_up.ok, false);
  assert.throws(() => jumpSchedule(900), /at least 1200/);
});

test("match comparison flags schedule, hash, overtime and collector-coverage differences", () => {
  const expected = {
    id: "x", controller: LEARNED, seed: 1,
    schedule: [{ tick: 1, card_index: 0, placement_index: 0, delay_index: 2, delay_ticks: 3 }],
    schedule_sha256: "s", counts: { decisions: 1, pass_decisions: 1, play_attempts: 0, illegal_attempts: 0 },
    decision_kinds: { play: 0, elective_pass: 1, forced_pass: 0, illegal: 0 },
    opponent_decisions: 1, action_stream_hash: "a", final_state_hash: "f",
    result: { winner: "red", reason: "r", tick: 2 }, overtime_start_tick: null,
  };
  const final = {
    status: "complete", result: { ...expected.result }, terminal_tick: 2, overtime_start_tick: null,
    schedule: structuredClone(expected.schedule), schedule_sha256: "s", counts: { ...expected.counts },
    decision_kinds: { ...expected.decision_kinds }, opponent_decisions: 1, action_stream_hash: "a",
    final_state_hash: "f", collector_refused: { frames: 0 },
  };
  const columns = RUNTIME_COST_TABLE_COLUMNS;
  const candidate = new Array(columns.candidate_decisions.length).fill(1);
  const frameRow = new Array(columns.frames.length).fill(0);
  frameRow[columns.frames.indexOf("tick_advances")] = 2;
  const rows = {
    candidate_decisions: [candidate],
    v1_candidate_decisions: [],
    opponent_decisions: [[1]],
    ticks: [[1], [2]],
    frames: [frameRow],
  };
  assert.equal(checkMatchAgainstExpectation({ final, expected, rows }).passed, true);
  const shifted = structuredClone(final);
  shifted.schedule[0].delay_ticks = 4;
  const difference = checkMatchAgainstExpectation({ final: shifted, expected });
  assert.equal(difference.checks.schedule, false);
  assert.equal(difference.schedule_difference.index, 0);
  assert.equal(checkMatchAgainstExpectation({ final: { ...final, overtime_start_tick: 3600 }, expected }).passed, false);
  assert.equal(checkMatchAgainstExpectation({ final: { ...final, action_stream_hash: "b" }, expected }).passed, false);
  assert.equal(checkMatchAgainstExpectation({ final, expected, rows: { ...rows, ticks: [[1]] } }).checks.collector_coverage, false);
  const noDelay = [...candidate];
  noDelay[columns.candidate_decisions.indexOf("delay_head_ms")] = Number.NaN;
  assert.equal(checkMatchAgainstExpectation({ final, expected, rows: { ...rows, candidate_decisions: [noDelay] } })
    .checks.delay_head_boundary, false);
  assert.equal(checkMatchAgainstExpectation({ final: null, expected }).passed, false);
  // A live-v1 baseline is covered by the v1 table alone and has no delay head.
  const v1Expected = { ...expected, kind: "v1_baseline", controller: "live_v1" };
  const v1Rows = { ...rows, candidate_decisions: [], v1_candidate_decisions: [[1, 1, 0.1, 0.2, 0.1, 0.4]] };
  const v1 = checkMatchAgainstExpectation({ final, expected: v1Expected, rows: v1Rows });
  assert.equal(v1.passed, true);
  assert.equal("delay_head_boundary" in v1.checks, false);
  assert.equal(checkMatchAgainstExpectation({ final, expected: v1Expected, rows }).checks.collector_coverage, false);
  assert.equal(checkMatchAgainstExpectation({ final, expected, rows: { ...rows, v1_candidate_decisions: [[1]] } })
    .checks.collector_coverage, false);
});

test("process listing parses ps output, CPU time and owned-group identity", () => {
  const text = [
    "  100     1   100 Ss     0:01.50 Fri Oct  3 11:41:00 2026     node worker.mjs",
    "  101   100   101 S      1:02.25 Fri Oct  3 11:41:01 2026     /x/chrome-headless-shell --a b",
    "  102   101   101 S   1:00:00.00 Fri Oct  3 11:41:02 2026     /x/chrome-headless-shell --type=renderer",
    "  103     1   103 Z      0:00.00 Fri Oct  3 11:41:03 2026     (defunct)",
  ].join("\n");
  const processes = parsePsOutput(text);
  assert.equal(processes.length, 4);
  assert.equal(parseCpuSeconds("1-00:00:01"), 86401);
  assert.equal(processes[1].cpu_s, 62.25);
  assert.equal(treeCpuSeconds(101, processes), 62.25 + 3600);
  const registry = createOwnershipRegistry({ excludePgids: [1] });
  registry.observe(100, processes, (entry) => (entry.pgid === 100 ? "worker" : "detached_descendant"));
  assert.deepEqual(registry.snapshot().map((group) => [group.pgid, group.role, group.members.length]), [
    [100, "worker", 1],
    [101, "detached_descendant", 2],
  ]);
  // A recycled pid (new start time) in a group with no known member is not ours.
  const recycled = parsePsOutput("  101     1   101 S 0:00.01 Sat Oct  4 09:00:00 2026     unrelated");
  assert.deepEqual(registry.live(recycled), []);
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Capture evidence while the per-test directories still exist. Top-level
// tests in this file run sequentially; each wrapper owns the dirs it creates.
async function withSupervisorDiagnostics(run) {
  const firstDirectory = tempDirs.length;
  try {
    return await run();
  } catch (error) {
    const diagnostics = tempDirs.slice(firstDirectory).map((outDir) => {
      const record = readJson(path.join(outDir, "supervisor", "final.json"))
        ?? readJson(path.join(outDir, "supervisor", "progress.json"));
      let workerLog;
      try {
        workerLog = fs.readFileSync(path.join(outDir, "supervisor", "worker.log"), "utf8");
      } catch (logError) {
        workerLog = `[unavailable: ${logError.code}]`;
      }
      return {
        out_dir: outDir,
        node: { version: process.version, executable: process.execPath },
        stop_reason: record?.stop_reason ?? null,
        worker_exit: record?.worker_exit ?? null,
        command: record?.command ?? null,
        limits: record?.limits ?? null,
        cleanup: record?.cleanup ?? null,
        last_worker_progress: record?.last_worker_progress ?? null,
        worker_log: workerLog,
      };
    });
    if (diagnostics.length > 0) {
      error.message += `\nSupervisor diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
    }
    throw error;
  }
}

function supervisorTest(name, run) {
  test(name, () => withSupervisorDiagnostics(run));
}

// stopWhen({ worker, supervisor }) is polled until it holds, then the test
// stops the run itself, so assertions do not race worker startup under load.
async function supervise(mode, limits = {}, options = {}, { stopWhen = null } = {}) {
  const outDir = tempDir(`supervisor-${mode}`);
  const supervision = superviseWorker({
    command: process.execPath,
    args: [FAKE_WORKER, mode],
    outDir,
    limits: {
      wallCapMs: 30_000,
      admissionFreeBytes: 0,
      reserveFreeBytes: 0,
      heartbeatTimeoutMs: 5000,
      startupTimeoutMs: 20_000,
      graceMs: 500,
      pollMs: 100,
      exitWaitMs: 3000,
      ...limits,
    },
    ...options,
  });
  if (stopWhen) {
    let settled = false;
    supervision.done.then(() => {
      settled = true;
    });
    await waitFor(() => settled || stopWhen({
      worker: readJson(path.join(outDir, "progress", "worker.json")),
      supervisor: readJson(path.join(outDir, "supervisor", "progress.json")),
    }), 20_000, `${mode} stop condition`);
    supervision.stop("test_stop");
  }
  return { outDir, record: await supervision.done };
}

supervisorTest("supervisor: completion, crash, wall cap and stalled TERM-resistant worker", async () => {
  const ok = await supervise("ok");
  assert.equal(ok.record.stop_reason, "worker_complete");
  assert.equal(ok.record.worker_exit.code, 0);
  assert.equal(ok.record.cleanup.verified, true);
  assert.ok(fs.existsSync(path.join(ok.outDir, "supervisor", "final.json")));
  assert.ok(ok.record.owned_groups.some((group) => group.role === "worker" && group.pgid === ok.record.worker.pid));

  const crash = await supervise("crash");
  assert.equal(crash.record.stop_reason, "worker_exit");
  assert.equal(crash.record.worker_exit.code, 3);
  assert.equal(crash.record.cleanup.verified, true);

  const timeout = await supervise("hang", { wallCapMs: 800 });
  assert.equal(timeout.record.stop_reason, "wall_cap");
  assert.equal(timeout.record.cleanup.verified, true);
  assert.ok(timeout.record.cleanup.term.length > 0);
  assert.ok(fs.existsSync(path.join(timeout.outDir, "supervisor", "stop.json")));
  assert.equal(alive(timeout.record.worker.pid), false);

  const stall = await supervise("stall", { heartbeatTimeoutMs: 700 });
  // Detected only after a first heartbeat; startup is not a stall.
  assert.equal(stall.record.stop_reason, "worker_stall");
  assert.ok(stall.record.cleanup.kill.length > 0, "a blocked worker ignores TERM and needs KILL");
  assert.equal(stall.record.cleanup.verified, true);
  assert.equal(stall.record.worker_exit.signal, "SIGKILL");

  const resist = await supervise("resist_term", {}, {}, { stopWhen: ({ worker }) => worker !== null });
  assert.equal(resist.record.stop_reason, "test_stop");
  assert.ok(resist.record.cleanup.kill.length > 0, "TERM is ignored, so KILL must follow");
  assert.equal(resist.record.cleanup.verified, true);

  // A worker that never reports is a startup failure, not a stall.
  const silent = await superviseWorker({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    outDir: tempDir("supervisor-silent"),
    limits: { admissionFreeBytes: 0, reserveFreeBytes: 0, startupTimeoutMs: 300, graceMs: 500, pollMs: 100 },
  }).done;
  assert.equal(silent.stop_reason, "worker_startup_timeout");
  assert.equal(silent.cleanup.verified, true);
});

supervisorTest("supervisor: a published match deadline is enforced exactly while the worker heartbeats", async () => {
  const at = 1_000_000;
  const deadlines = [deadlineRecord("item", "item", 3_600_000, at), deadlineRecord("match", "match", 360_000, at)];
  assert.equal(deadlines[1].deadline_ms, 360_000, "the declared 360 s, with nothing added");
  assert.equal(expiredDeadline({ deadlines }, at + 360_000), null, "not expired at the deadline itself");
  assert.deepEqual(expiredDeadline({ deadlines }, at + 360_001), {
    deadline: deadlines[1], expires_at_ms: at + 360_000, detected_at_ms: at + 360_001, late_by_ms: 1,
  });
  assert.equal(expiredDeadline({ deadlines: [{ id: "bad", started_at_ms: at }] }, at + 1e9), null);
  assert.equal(expiredDeadline(null, at), null);
  assert.throws(() => deadlineRecord("zero", "match", 0), /positive duration/);
  const config = buildValidationConfig({ seed: DEV_SEED, models: {}, bank: {}, expectations: {} });
  assert.equal(config.real_time.match_wall_cap_s, 360);
  assert.ok(config.deadlines.item_s > 0 && config.deadlines.bank_check_s > 0 && config.smoke.preview.match_wall_cap_s > 0);

  // The page never answers, heartbeats stay fresh, and the total cap is far
  // away: before the repair this ran into the 30 s wall cap instead.
  const hung = await supervise("deadline_hang", { pollMs: 100 });
  assert.equal(hung.record.stop_reason, "condition_deadline");
  assert.equal(hung.record.stop_detail.deadline.kind, "match");
  assert.equal(hung.record.stop_detail.deadline.deadline_ms, 700);
  assert.equal(
    hung.record.stop_detail.expires_at_ms,
    hung.record.stop_detail.deadline.started_at_ms + hung.record.stop_detail.deadline.deadline_ms,
  );
  assert.ok(hung.record.stop_detail.late_by_ms >= 0 && hung.record.stop_detail.late_by_ms < 3000,
    `detected ${hung.record.stop_detail.late_by_ms} ms late`);
  assert.ok(
    hung.record.stop_detail.detected_at_ms - hung.record.last_worker_progress.heartbeat_at_ms < 5000,
    "the worker was still heartbeating, so this is not a stall",
  );
  assert.equal(hung.record.cleanup.verified, true);
  assert.equal(typeof hung.record.cleanup.duration_ms, "number");
  assert.equal(typeof hung.record.stop_elapsed_ms, "number");
  assert.equal(alive(hung.record.worker.pid), false);

  // Teardown after the match is charged to the item, not the match.
  const handoff = await supervise("deadline_handoff", { pollMs: 100 });
  assert.equal(handoff.record.stop_reason, "worker_complete");
  assert.equal(handoff.record.cleanup.verified, true);

  // The removed slack flag is refused rather than silently ignored.
  const refused = spawnSync(process.execPath, [
    SUPERVISOR, "--out", tempDir("supervisor-flag"), "--condition-slack-s", "30", "--", process.execPath, "-e", "0",
  ], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unknown option\(s\): --condition-slack-s/);
});

supervisorTest("supervisor: disk admission, running reserve and output cap", async () => {
  const refused = await supervise("ok", { admissionFreeBytes: 3 * GIB }, { freeBytes: () => 2 * GIB });
  assert.equal(refused.record.stop_reason, "admission_free_disk");
  assert.equal(refused.record.admission.admitted, false);
  assert.equal(refused.record.worker, null);

  let calls = 0;
  const reserve = await supervise("hang", { admissionFreeBytes: 3 * GIB, reserveFreeBytes: 2 * GIB }, {
    freeBytes: () => (calls++ === 0 ? 4 * GIB : 1 * GIB),
  });
  assert.equal(reserve.record.stop_reason, "disk_reserve");
  assert.equal(reserve.record.cleanup.verified, true);

  const overflow = await supervise("write_big", { outputCapBytes: 2 * 1024 * 1024 });
  assert.equal(overflow.record.stop_reason, "output_cap");
  assert.equal(overflow.record.cleanup.verified, true);
  assert.ok(overflow.record.max_output_bytes > 2 * 1024 * 1024);
});

supervisorTest("supervisor: Chromium-like detached group is owned and killed with the worker", async () => {
  const { outDir, record } = await supervise("group", {}, {}, {
    stopWhen: ({ supervisor }) => (supervisor?.owned_groups ?? []).some((group) => group.role === "detached_descendant"),
  });
  assert.equal(record.stop_reason, "test_stop");
  const detached = record.owned_groups.find((group) => group.role === "detached_descendant");
  assert.ok(detached, JSON.stringify(record.owned_groups));
  assert.notEqual(detached.pgid, record.worker.pgid);
  assert.equal(record.cleanup.verified, true);
  const signalled = [...record.cleanup.term, ...record.cleanup.kill].map((entry) => entry.pgid);
  assert.ok(signalled.includes(detached.pgid) && signalled.includes(record.worker.pgid));
  for (const member of detached.members) {
    assert.equal(alive(member.pid), false);
  }
  const reported = JSON.parse(fs.readFileSync(path.join(outDir, "progress", "worker.json"), "utf8"));
  assert.equal(reported.owned[0].pid, detached.pgid);
});

supervisorTest("supervisor CLI: interruption cleans up both groups; a killed supervisor orphans no worker", async () => {
  const interruptOut = tempDir("supervisor-interrupt");
  const cli = spawn(process.execPath, [
    SUPERVISOR, "--out", interruptOut, "--poll-ms", "100", "--grace-ms", "500",
    "--admission-free-gib", "0", "--reserve-free-gib", "0", "--", process.execPath, FAKE_WORKER, "group",
  ], { stdio: "ignore" });
  const progressFile = path.join(interruptOut, "supervisor", "progress.json");
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(progressFile, "utf8")).owned_groups.length >= 2;
    } catch {
      return false;
    }
  }, 20_000, "two owned groups");
  const exit = new Promise((resolve) => cli.on("exit", (code) => resolve(code)));
  cli.kill("SIGTERM");
  assert.equal(await exit, 130);
  const final = JSON.parse(fs.readFileSync(path.join(interruptOut, "supervisor", "final.json"), "utf8"));
  assert.equal(final.stop_reason, "supervisor_interrupted");
  assert.equal(final.cleanup.verified, true);
  for (const group of final.owned_groups) {
    for (const member of group.members) {
      assert.equal(alive(member.pid), false, `${group.role} ${member.pid} survived`);
    }
  }

  const orphanOut = tempDir("supervisor-orphan");
  const doomed = spawn(process.execPath, [
    SUPERVISOR, "--out", orphanOut, "--poll-ms", "100",
    "--admission-free-gib", "0", "--reserve-free-gib", "0", "--", process.execPath, FAKE_WORKER, "orphan",
  ], { stdio: "ignore" });
  const workerFile = path.join(orphanOut, "progress", "worker.json");
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(workerFile, "utf8")).owned.length === 1;
    } catch {
      return false;
    }
  }, 20_000, "orphan worker start");
  const worker = JSON.parse(fs.readFileSync(workerFile, "utf8"));
  doomed.kill("SIGKILL");
  const marker = path.join(orphanOut, "orphaned.json");
  await waitFor(() => fs.existsSync(marker), 20_000, "orphan guard");
  await waitFor(() => !alive(worker.pid) && !alive(worker.owned[0].pid), 10_000, "orphan cleanup");
});

test("supervisor diagnostics survive temporary cleanup after early exit and startup timeout", async () => {
  for (const mode of ["early_exit", "startup_timeout"]) {
    let outDir;
    let failure;
    try {
      await withSupervisorDiagnostics(async () => {
        outDir = tempDir(`supervisor-diagnostic-${mode}`);
        const script = mode === "early_exit"
          ? "process.stdout.write('stdout evidence\\n'); process.stderr.write('stderr evidence\\n'); process.exit(23);"
          : "process.stderr.write('startup evidence\\n'); setInterval(() => {}, 1000);";
        const record = await superviseWorker({
          command: process.execPath,
          args: ["-e", script],
          outDir,
          limits: {
            admissionFreeBytes: 0, reserveFreeBytes: 0, startupTimeoutMs: 1000,
            graceMs: 500, pollMs: 100, exitWaitMs: 3000,
          },
        }).done;
        assert.equal(record.cleanup.verified, true);
        assert.equal(record.stop_reason, "worker_complete"); // Deliberate failure.
      });
    } catch (error) {
      failure = error;
    }
    if (outDir) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    assert.ok(failure, "the deliberately wrong stop reason must fail");
    assert.equal(failure.code, "ERR_ASSERTION", "retain the original assertion error");
    assert.equal(failure.expected, "worker_complete", "the deliberate stop-reason assertion, not an earlier one");
    assert.match(failure.message, /Supervisor diagnostics:/);
    assert.match(failure.message, /"worker_exit":/);
    if (mode === "early_exit") {
      assert.match(failure.message, /"code": 23/);
      assert.match(failure.message, /stdout evidence/);
      assert.match(failure.message, /stderr evidence/);
    } else {
      assert.match(failure.message, /worker_startup_timeout/);
      assert.match(failure.message, /"signal": "SIGTERM"/);
      assert.match(failure.message, /startup evidence/);
    }
  }
});

test("profiling matrix covers every model, controller, side and viewport once on the development seed", () => {
  const matrix = profilingMatrix(DEV_SEED);
  assert.equal(matrix.length, 24);
  assert.equal(new Set(matrix.map((entry) => entry.id)).size, 24);
  for (const entry of matrix) {
    assert.equal(entry.seed, DEV_SEED);
    assert.equal(entry.clock, "raf");
  }
});

// A synthetic, internally consistent stage plus the validation, supervisor
// and gate records a successful run writes. Real webGame/index sources are
// copied so the live pins hold; models, bank and binaries are small stand-ins.
function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

function editJson(file, edit) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(value);
  writeJsonFile(file, value);
}

test("browser pins: headed Chrome for Testing or the headless shell, with the install tree hashed", () => {
  const base = { seed: DEV_SEED, models: {}, bank: {}, expectations: {} };
  // October 6: headless correctness/smoke stays at scale 1; headed uses native
  // scale 2 with --kiosk and a per-page CDP fullscreen window.
  assert.deepEqual(buildValidationConfig(base).browser, {
    engine: "chromium-headless-shell", headless: true, device_scale_factor: 1, launch_args: [], window: null,
    display_probe_frames: 120,
  });
  assert.deepEqual(buildValidationConfig({ ...base, engine: "chromium" }).browser, {
    engine: "chromium", headless: false, device_scale_factor: 2, launch_args: ["--kiosk"],
    window: {
      mode: "cdp_fullscreen_per_page", settle_timeout_ms: 12000, retry_after_ms: 2000, settle_poll_ms: 250,
      settle_hold_ms: 1000, close_settle_ms: 1000,
    },
    display_probe_frames: 120,
  });
  assert.deepEqual(buildValidationConfig({ ...base, engine: "chromium" }).viewports,
    { portrait: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } });
  assert.throws(() => buildValidationConfig({ ...base, engine: "firefox" }), /unknown browser firefox/);
  assert.deepEqual(Object.keys(BROWSER_ENGINES), ["chromium-headless-shell", "chromium"]);

  // Links are recorded by target text and never followed; a special entry is reported.
  const root = tempDir("browser-tree");
  fs.mkdirSync(path.join(root, "App.app", "Versions", "1"), { recursive: true });
  fs.writeFileSync(path.join(root, "App.app", "Versions", "1", "Framework"), "framework");
  fs.symlinkSync("1", path.join(root, "App.app", "Versions", "Current"));
  fs.symlinkSync(path.join(os.tmpdir(), "outside"), path.join(root, "dangling"));
  const before = browserTreeDigest(root);
  assert.equal(before.files, 1);
  assert.equal(before.links, 2);
  assert.deepEqual(before.unsupported, []);
  assert.equal(browserTreeDigest(root).sha256, before.sha256, "deterministic");
  fs.writeFileSync(path.join(root, "App.app", "Versions", "1", "Framework"), "framework!");
  const changed = browserTreeDigest(root);
  assert.notEqual(changed.sha256, before.sha256);
  assert.equal(spawnSync("mkfifo", [path.join(root, "pipe")]).status, 0);
  assert.deepEqual(browserTreeDigest(root).unsupported, ["pipe"]);
});

function buildFreezeFixture() {
  const root = tempDir("freeze");
  const stage = path.join(root, "stage");
  const put = (relative, content) => {
    const file = path.join(stage, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return sha256Hex(content);
  };
  const tool = (name) => {
    const file = path.join(root, "tools", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture ${name}`);
    return { file, sha256: sha256Hex(`fixture ${name}`) };
  };
  const node = tool("node");
  // A synthetic install tree: executable, library and an internal link.
  const installDir = path.join(root, "tools", "chromium_headless_shell-1208");
  fs.mkdirSync(path.join(installDir, "lib"), { recursive: true });
  const shell = { file: path.join(installDir, "chrome-headless-shell"), lib: path.join(installDir, "lib", "libEGL.dylib") };
  fs.writeFileSync(shell.file, "fixture chrome-headless-shell");
  fs.writeFileSync(shell.lib, "fixture library");
  shell.link = path.join(installDir, "Current");
  fs.symlinkSync("lib/libEGL.dylib", shell.link);
  const tree = browserTreeDigest(installDir);
  put("index.html", fs.readFileSync(path.join(ROOT, "index.html")));
  put("src/client/webGame.js", fs.readFileSync(path.join(ROOT, "src", "client", "webGame.js")));
  put(LIVE_V1_PIN.module, fs.readFileSync(RETIRED_V1_MODULE));
  const generated = {
    [DIAGNOSTIC_HTML]: put(DIAGNOSTIC_HTML, "<p>diagnostic</p>\n"),
    [DIAGNOSTIC_MODULE]: put(DIAGNOSTIC_MODULE, "export {};\n"),
  };
  put("scripts/edger-v2-runtime-cost-browser-worker.mjs", "// fixture worker\n");
  const modelPins = {};
  const models = {};
  for (const run of ["r0", "r1", "r2"]) {
    const relative = `data/models/${run}-learned-full.json`;
    modelPins[run] = put(relative, JSON.stringify({ run }));
    models[run] = { path: relative, sha256: modelPins[run] };
  }
  const bank = { path: "data/state-bank.json", sha256: put("data/state-bank.json", "{}") };
  const fullMatches = [];
  for (const model of ["r0", "r1", "r2"]) {
    for (const controller of ["learned", "fixed_one_tick"]) {
      for (const actor of ["blue", "red"]) {
        fullMatches.push({
          id: `${DEV_SEED}-${model}-${controller}-${actor}`,
          seed: DEV_SEED, model, controller, candidate_actor: actor, result: { tick: 1500 },
        });
      }
    }
  }
  const v1Baselines = ["blue", "red"].map((actor) => ({
    id: `${DEV_SEED}-v1-${actor}`, kind: "v1_baseline", seed: DEV_SEED, model: "v1", controller: "live_v1",
    candidate_actor: actor, result: { tick: 3600 },
  }));
  const expectationsData = {
    schema_version: "edger_v2_runtime_cost_node_expectations_v2",
    match_seeds: [DEV_SEED],
    full_matches: fullMatches,
    v1_baselines: v1Baselines,
    live_v1: { module_sha256: LIVE_V1_PIN.module_sha256, artifact_sha256: LIVE_V1_PIN.artifact_sha256 },
  };
  const expectations = { path: "data/node-expectations.json", sha256: put("data/node-expectations.json", JSON.stringify(expectationsData)) };
  const config = buildValidationConfig({ seed: DEV_SEED, models, bank, expectations });
  put("config.json", `${JSON.stringify(config, null, 1)}\n`);
  const playwright = {
    version: "1.58.2", core_version: "1.58.2", lockfile_version: "1.58.2",
    browser: {
      engine: "chromium-headless-shell",
      revision: "1208",
      browser_version: "145.0.7632.6",
      install_dir: installDir,
      executable: shell.file,
      sha256: sha256Hex("fixture chrome-headless-shell"),
      tree_sha256: tree.sha256,
      tree_files: tree.files,
      tree_links: tree.links,
    },
  };
  const restage = () => writeStageManifest(stage, {
    repo: "fixture",
    git: { head: "fixture" },
    node: { version: "v20.20.2", exec_path: node.file, sha256: node.sha256 },
    playwright,
    substitutions: [],
    generated,
    pins: {
      models: modelPins, bank_sha256: bank.sha256, expectations_sha256: expectations.sha256, seed_plans: {},
      live_v1: LIVE_V1_PIN,
    },
  });
  const manifest = restage();

  const plan = buildPlan(config, expectationsData);
  const planned = plannedCoverage(plan);
  const at = (second) => new Date(Date.UTC(2026, 9, 3, 3, 0, second)).toISOString();
  const paths = {
    validation: path.join(root, "validation", "worker", "report.json"),
    supervisor: path.join(root, "validation", "supervisor", "final.json"),
    dryRun: path.join(root, "dry-run", "worker", "report.json"),
    dryRunSupervisor: path.join(root, "dry-run", "supervisor", "final.json"),
    gates: path.join(root, "out", "gates.json"),
    predecessor: path.join(root, "predecessor", "profiling-freeze.json"),
  };
  fs.mkdirSync(path.dirname(paths.predecessor), { recursive: true });
  fs.writeFileSync(paths.predecessor, "fixture predecessor freeze\n");
  const stageBinding = {
    dir: stage,
    closure_sha256: manifest.closure_sha256,
    manifest_sha256: sha256Hex(fs.readFileSync(path.join(stage, "MANIFEST.json"))),
    config_sha256: manifest.config_sha256,
    git: manifest.git,
  };
  writeJsonFile(paths.validation, {
    schema_version: BROWSER_VALIDATION_SCHEMA,
    status: "complete",
    passed: true,
    stop_reason: null,
    started_at: at(1),
    updated_at: at(50),
    stage: stageBinding,
    environment: { node: "v20.20.2", playwright, browser: config.browser, chromium_exited: true },
    coverage: {
      planned,
      completed: {
        smoke: planned.smoke_viewports,
        jump: planned.jump_matches,
        bank_checks: planned.bank_checks,
        fast_forward: planned.fast_forward_matches,
        fast_forward_v1_baseline: planned.fast_forward_v1_baseline_matches,
        real_time: planned.real_time_matches,
      },
    },
    items: plan.map((item) => ({ id: item.id, phase: item.phase, passed: true })),
    matches: plan.flatMap((item) => (item.matches ? item.matches.map((match) => match.id)
      : item.phase === "smoke" ? [] : [item.id])).map((id) => ({ id, passed: true, failed_checks: [] })),
    not_run: [],
    failures: [],
    partial_plan: null,
    limits: config.limits,
    caps: config.caps,
  });
  writeJsonFile(paths.supervisor, {
    schema_version: SUPERVISOR_SCHEMA,
    command: [node.file, "scripts/edger-v2-runtime-cost-browser-worker.mjs"],
    cwd: stage,
    out_dir: path.join(root, "validation"),
    limits: {
      wallCapMs: 5400 * 1000, admissionFreeBytes: 3 * GIB, reserveFreeBytes: 2 * GIB, outputCapBytes: 1 * GIB,
      heartbeatTimeoutMs: 120_000, startupTimeoutMs: 120_000, graceMs: 5000, pollMs: 1000, exitWaitMs: 10_000,
    },
    started_at: at(0),
    admission: { free_bytes: 4 * GIB, required_bytes: 3 * GIB, admitted: true },
    stop_reason: "worker_complete",
    worker_exit: { code: 0, signal: null },
    cleanup: { term: [], kill: [], remaining: [], verified: true, worker_reaped: true },
    last_worker_progress: { phase: "complete", deadlines: [] },
    ended_at: at(51),
  });
  const dryPlan = buildMeasurementPlan(config, expectationsData, "dry_run");
  writeJsonFile(paths.dryRun, {
    schema_version: MEASUREMENT_SCHEMA,
    mode: "dry_run",
    status: "dry_run_complete",
    passed: true,
    stop_reason: null,
    started_at: at(53),
    updated_at: at(55),
    stage: stageBinding,
    environment: { node: "v20.20.2", playwright, browser: config.browser, chromium_exited: true },
    items: dryPlan.map((item) => ({ id: item.id, phase: item.phase, passed: true })),
    incomplete: [],
    failures: [],
    caps: config.caps,
  });
  writeJsonFile(paths.dryRunSupervisor, {
    schema_version: SUPERVISOR_SCHEMA,
    command: [node.file, "scripts/edger-v2-runtime-cost-browser-worker.mjs", "--measure", "dry_run"],
    cwd: stage,
    out_dir: path.join(root, "dry-run"),
    limits: {
      wallCapMs: 1800 * 1000, admissionFreeBytes: 3 * GIB, reserveFreeBytes: 2 * GIB, outputCapBytes: 1 * GIB,
      heartbeatTimeoutMs: 120_000, startupTimeoutMs: 120_000, graceMs: 5000, pollMs: 1000, exitWaitMs: 10_000,
    },
    started_at: at(52),
    admission: { free_bytes: 4 * GIB, required_bytes: 3 * GIB, admitted: true },
    stop_reason: "worker_complete",
    worker_exit: { code: 0, signal: null },
    cleanup: { term: [], kill: [], remaining: [], verified: true, worker_reaped: true },
    last_worker_progress: { phase: "complete", deadlines: [] },
    ended_at: at(56),
  });
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  for (const log of ["npm-test.log", "targeted-tests.log", "live-smoke.log"]) {
    fs.writeFileSync(path.join(root, "out", log), "ok\n");
  }
  writeJsonFile(paths.gates, {
    schema_version: GATES_SCHEMA,
    recorded_at: at(60),
    gates: [
      { command: "npm test", result: "190/190", log: "out/npm-test.log", passed: true },
      {
        command: "node --test tests/edger-v2-runtime-cost.test.js tests/edger-v2-cadence.test.js tests/edger-v2-runtime-cost-browser.test.js",
        result: "45/45", log: "out/targeted-tests.log", passed: true,
      },
      { command: "npm run smoke:browser", result: "OK", log: "out/live-smoke.log", passed: true },
      {
        command: "edger-v2-runtime-cost-supervisor.mjs -- edger-v2-runtime-cost-browser-worker.mjs",
        result: "complete", log: "validation/", passed: true,
      },
      {
        command: "edger-v2-runtime-cost-supervisor.mjs -- edger-v2-runtime-cost-browser-worker.mjs --measure dry_run",
        result: "dry_run_complete", log: "dry-run/", passed: true,
      },
    ],
  });
  const predecessorSha256 = sha256Hex("fixture predecessor freeze\n");
  return { root, stage, modelPins, predecessorSha256, paths, manifest, restage, put, shell };
}

function freezeProblems(fixture) {
  return checkFreezeInputs({
    stageDir: fixture.stage,
    validationPath: fixture.paths.validation,
    supervisorPath: fixture.paths.supervisor,
    dryRunPath: fixture.paths.dryRun,
    dryRunSupervisorPath: fixture.paths.dryRunSupervisor,
    gatesPath: fixture.paths.gates,
    predecessorPath: fixture.paths.predecessor,
    modelPins: fixture.modelPins,
    predecessorSha256: fixture.predecessorSha256,
  }).problems;
}

test("worker preflight rejects unsupported and unlisted entries without hashing link targets", () => {
  const fixture = buildFreezeFixture();
  const manifestPath = path.join(fixture.stage, "MANIFEST.json");
  editJson(manifestPath, (manifest) => {
    manifest.node = { version: process.version, exec_path: process.execPath, sha256: sha256Hex(fs.readFileSync(process.execPath)) };
  });
  try {
    assert.deepEqual(verifyStage(fixture.stage).problems, []);
    const src = path.join(fixture.stage, "src");
    fs.symlinkSync(fixture.shell.file, path.join(src, "extra.js"));
    fs.symlinkSync(path.join(ROOT, "src", "sim"), path.join(src, "directory"), "dir");
    fs.symlinkSync(path.join(fixture.root, "absent.js"), path.join(src, "dangling.js"));
    fs.writeFileSync(path.join(src, "unlisted.js"), "export {};\n");
    const listed = path.join(src, "client", "webGame.js");
    const copy = path.join(fixture.root, "webGame-copy.js");
    fs.copyFileSync(listed, copy);
    fs.unlinkSync(listed);
    fs.symlinkSync(copy, listed);
    assert.equal(spawnSync("mkfifo", [path.join(src, "pipe.js")]).status, 0);
    const problems = verifyStage(fixture.stage).problems;
    for (const expected of ["unsupported symbolic link src/extra.js", "unsupported symbolic link src/directory",
      "unsupported symbolic link src/dangling.js", "unsupported symbolic link src/client/webGame.js",
      "unsupported FIFO src/pipe.js", "missing src/client/webGame.js", "unlisted src/unlisted.js"]) {
      assert.ok(problems.includes(expected), `${expected}: ${JSON.stringify(problems)}`);
    }
    const savedManifest = path.join(fixture.root, "manifest-copy.json");
    fs.renameSync(manifestPath, savedManifest);
    fs.symlinkSync(savedManifest, manifestPath);
    const linkedManifest = verifyStage(fixture.stage);
    assert.equal(linkedManifest.manifest, null);
    assert.ok(linkedManifest.problems.includes("unsupported symbolic link MANIFEST.json"));
    assert.ok(linkedManifest.problems.includes("missing MANIFEST.json"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function freezeOptions(fixture, out) {
  return {
    stage: fixture.stage,
    validation: fixture.paths.validation,
    supervisor: fixture.paths.supervisor,
    dryRun: fixture.paths.dryRun,
    dryRunSupervisor: fixture.paths.dryRunSupervisor,
    gates: fixture.paths.gates,
    predecessor: fixture.paths.predecessor,
    out,
    modelPins: fixture.modelPins,
    predecessorSha256: fixture.predecessorSha256,
  };
}

// Apply one tampering to a fresh fixture and require every pattern among the
// refusal reasons.
function assertRefused(label, tamper, ...patterns) {
  const fixture = buildFreezeFixture();
  tamper(fixture);
  const problems = freezeProblems(fixture);
  assert.ok(problems.length > 0, `${label}: accepted`);
  for (const pattern of patterns) {
    assert.ok(problems.some((problem) => pattern.test(problem)), `${label}: no ${pattern} in ${JSON.stringify(problems)}`);
  }
  const out = path.join(fixture.root, "freeze.json");
  assert.throws(() => freezeStage(freezeOptions(fixture, out)), /refusing to freeze/, label);
  assert.equal(fs.existsSync(out), false, `${label}: wrote a freeze`);
}

test("freeze: a complete, rehashed and bound validation freezes once, read-only", () => {
  const fixture = buildFreezeFixture();
  assert.deepEqual(freezeProblems(fixture), []);
  const out = path.join(fixture.root, "freeze", "profiling-freeze.json");
  fs.mkdirSync(path.dirname(out));
  const result = freezeStage(freezeOptions(fixture, out));
  assert.equal(result.conditions, 28);
  const frozen = JSON.parse(fs.readFileSync(out, "utf8"));
  // The original 24 v2 conditions keep their order; the four v1 baselines follow.
  assert.deepEqual(frozen.rendered_matrix.conditions.slice(0, 24), profilingMatrix(DEV_SEED));
  assert.deepEqual(frozen.rendered_matrix.conditions.slice(24), v1BaselineMatrix(DEV_SEED));
  assert.deepEqual(frozen.measurement, buildMeasurementConfig(DEV_SEED));
  assert.deepEqual(frozen.predecessor.sha256, fixture.predecessorSha256);
  assert.deepEqual([frozen.schemas.measurement, frozen.schemas.complete_path, frozen.schemas.existing_method],
    [MEASUREMENT_SCHEMA, COMPLETE_PATH_SCHEMA, EXISTING_METHOD_SCHEMA]);
  assert.equal(PREDECESSOR_FREEZE_SHA256, "800e6dc5a27ce23a41d1b8ef346ac06bc3fcbc09e805b00333d30f135ecaa3a5",
    "the CLI links the reviewed October 6 successor freeze");
  assert.equal(frozen.measurement_dry_run.report.sha256, sha256Hex(fs.readFileSync(fixture.paths.dryRun)));
  assert.deepEqual(frozen.live_v1, LIVE_V1_PIN);
  assert.deepEqual(frozen.run.worker_args, ["--measure", "full"]);
  assert.equal(frozen.stage.closure_sha256, fixture.manifest.closure_sha256);
  assert.equal(frozen.stage.files_rehashed, Object.keys(fixture.manifest.files).length);
  assert.equal(frozen.gates_file.logs["out/npm-test.log"], sha256Hex("ok\n"));
  assert.equal(frozen.rendered_matrix.match_wall_cap_s, 360);
  assert.deepEqual(frozen.deadlines, { item_s: 3600, bank_check_s: 600 });
  assert.equal(fs.statSync(out).mode & 0o222, 0, "the freeze is read-only");
  const written = fs.readFileSync(out);
  assert.throws(() => freezeStage(freezeOptions(fixture, out)), /already exists; freezes are never overwritten/);
  assert.deepEqual(fs.readFileSync(out), written);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ["profiling-freeze.json"], "no temporary file is left");
  assert.throws(() => freezeStage(freezeOptions(fixture, path.join(fixture.stage, "freeze.json"))), /inside the stage/);
  assert.throws(() => freezeStage(freezeOptions(fixture, path.join(fixture.root, "validation", "freeze.json"))),
    /inside the validation output/);
  assert.throws(() => freezeStage(freezeOptions(fixture, path.join(fixture.root, "dry-run", "freeze.json"))),
    /inside the dry-run output/);
});

test("freeze: the reviewed negative controls are refused (no gates; stale stage, changed seed, missing file)", () => {
  assertRefused("empty gates", (fixture) => editJson(fixture.paths.gates, (gates) => {
    gates.gates = [];
  }), /gate npm_test is recorded 0 times/, /gate supervised_validation is recorded 0 times/);
  assertRefused("no gate list", (fixture) => editJson(fixture.paths.gates, (gates) => {
    delete gates.gates;
  }), /gate live_browser_smoke is recorded 0 times/);
  // Review control: config seed 999 and a served file removed, manifest stale.
  assertRefused("stale manifest", (fixture) => {
    editJson(path.join(fixture.stage, "config.json"), (config) => {
      config.seed = 999;
    });
    fs.rmSync(path.join(fixture.stage, DIAGNOSTIC_HTML));
  }, /^changed config\.json$/, new RegExp(`^missing ${DIAGNOSTIC_HTML}$`), /config\.json does not match/,
  /config seed 999 is not the expectations' match seed/);
  // The same change with a consistently rewritten manifest no longer matches
  // what was validated.
  assertRefused("restaged after validation", (fixture) => {
    editJson(path.join(fixture.stage, "config.json"), (config) => {
      config.seed = 999;
    });
    fixture.restage();
  }, /different stage closure/, /different stage manifest/, /different stage config/, /config seed 999/);
  assertRefused("closure hash edited", (fixture) => editJson(path.join(fixture.stage, "MANIFEST.json"), (manifest) => {
    manifest.closure_sha256 = "0".repeat(64);
  }), /closure hash does not match/, /SHA256SUMS does not match/, /different stage manifest/);
  assertRefused("unlisted file", (fixture) => fixture.put("src/extra.js", "export {};"), /^unlisted src\/extra\.js$/);
  assertRefused("changed browser binary", (fixture) => fs.appendFileSync(fixture.shell.file, "!"),
    /pinned browser executable .* hashes to/, /pinned browser install tree .* hashes to/);
  assertRefused("changed browser library", (fixture) => fs.appendFileSync(fixture.shell.lib, "!"),
    /pinned browser install tree .* hashes to/);
  assertRefused("retargeted browser link", (fixture) => {
    fs.unlinkSync(fixture.shell.link);
    fs.symlinkSync("chrome-headless-shell", fixture.shell.link);
  }, /pinned browser install tree .* hashes to/);
  assertRefused("config names the other browser", (fixture) => {
    editJson(path.join(fixture.stage, "config.json"), (config) => {
      config.browser.engine = "chromium";
      config.browser.headless = false;
    });
    fixture.restage();
  }, /config browser chromium is not the pinned chromium-headless-shell/);
});

test("freeze: stage symbolic links and aliased output paths are refused (October 4 review controls)", () => {
  // Links are reported where they sit and never followed: to a file outside the
  // closure, to a directory, to nothing, and in place of a listed file.
  assertRefused("unlisted file link", (fixture) => {
    fs.symlinkSync(fixture.shell.file, path.join(fixture.stage, "src", "extra.js"));
  }, /^unsupported symbolic link src\/extra\.js$/);
  assertRefused("unlisted directory link", (fixture) => {
    fs.symlinkSync(path.join(ROOT, "src", "sim"), path.join(fixture.stage, "src", "linked"), "dir");
  }, /^unsupported symbolic link src\/linked$/);
  assertRefused("dangling link", (fixture) => {
    fs.symlinkSync(path.join(fixture.root, "absent.js"), path.join(fixture.stage, "src", "dangling.js"));
  }, /^unsupported symbolic link src\/dangling\.js$/);
  assertRefused("listed file replaced by an identical link", (fixture) => {
    const listed = path.join(fixture.stage, "src", "client", "webGame.js");
    const copy = path.join(fixture.root, "webGame-copy.js");
    fs.copyFileSync(listed, copy);
    fs.rmSync(listed);
    fs.symlinkSync(copy, listed);
  }, /^unsupported symbolic link src\/client\/webGame\.js$/, /^missing src\/client\/webGame\.js$/);
  const linked = buildFreezeFixture();
  fs.symlinkSync(linked.shell.file, path.join(linked.stage, "src", "extra.js"));
  assert.throws(() => linked.restage(), /unsupported entries under .*symbolic link .*extra\.js/, "manifest skipped a link");

  // Output containment compares resolved directories, and a dangling link at
  // the output name counts as taken.
  const fixture = buildFreezeFixture();
  const alias = (name, target) => {
    const file = path.join(fixture.root, name);
    fs.symlinkSync(target, file, "dir");
    return file;
  };
  const refusals = [
    [path.join(alias("stage-alias", fixture.stage), "freeze.json"), /inside the stage/],
    [path.join(alias("stage-src-alias", path.join(fixture.stage, "src")), "freeze.json"), /inside the stage/],
    [path.join(alias("validation-alias", path.join(fixture.root, "validation", "worker")), "freeze.json"),
      /inside the validation output/],
    [path.join(alias("dangling-alias", path.join(fixture.stage, "absent")), "freeze.json"),
      /does not resolve to an existing directory/],
    [path.join(fixture.root, "out", "missing", "freeze.json"), /does not resolve to an existing directory/],
    [path.join(fixture.root, "out", "npm-test.log", "freeze.json"), /is not a directory/],
  ];
  const danglingOut = path.join(fixture.root, "out", "dangling-freeze.json");
  fs.symlinkSync(path.join(fixture.stage, "freeze.json"), danglingOut);
  refusals.push([danglingOut, /already exists; freezes are never overwritten/]);
  for (const [out, pattern] of refusals) {
    assert.throws(() => freezeStage(freezeOptions(fixture, out)), pattern, out);
  }
  assert.equal(fs.existsSync(path.join(fixture.stage, "freeze.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.stage, "src", "freeze.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.root, "validation", "worker", "freeze.json")), false);
  assert.deepEqual(freezeProblems(fixture), [], "refusals left the stage and records admissible");
  // An alias to an unprotected directory still freezes, at the resolved path.
  const real = path.join(fixture.root, "freezes");
  fs.mkdirSync(real);
  const result = freezeStage(freezeOptions(fixture, path.join(alias("freezes-alias", real), "freeze.json")));
  assert.equal(result.freeze, path.join(fs.realpathSync(real), "freeze.json"));
  assert.deepEqual(fs.readdirSync(real), ["freeze.json"]);
});

test("freeze: incomplete or unbound validation, supervisor and gate records are refused", () => {
  const report = (edit) => (fixture) => editJson(fixture.paths.validation, edit);
  const supervisor = (edit) => (fixture) => editJson(fixture.paths.supervisor, edit);
  const gates = (edit) => (fixture) => editJson(fixture.paths.gates, edit);
  assertRefused("not passed", report((value) => {
    value.passed = false;
  }), /browser validation did not pass/);
  assertRefused("filtered plan", report((value) => {
    value.partial_plan = ["real_time"];
  }), /filtered plan/);
  assertRefused("missing match", report((value) => {
    value.matches.pop();
    value.coverage.completed.real_time -= 1;
  }), /completed 7 real_time, expected 8/, /not every planned match/);
  assertRefused("failed item", report((value) => {
    value.items[3].passed = false;
  }), /items are not the full plan/);
  assertRefused("report pins", report((value) => {
    value.stage.manifest_sha256 = "0".repeat(64);
    value.stage.dir = "/elsewhere";
  }), /different stage manifest/, /ran on stage \/elsewhere/);
  assertRefused("other browser", report((value) => {
    value.environment.playwright.browser.sha256 = "0".repeat(64);
  }), /different Node or Playwright/);
  assertRefused("stopped run", supervisor((value) => {
    value.stop_reason = "condition_deadline";
    value.cleanup.worker_reaped = false;
  }), /supervisor ended with condition_deadline/, /cleanup was not verified/);
  assertRefused("unadmitted", supervisor((value) => {
    value.admission.admitted = false;
  }), /did not admit/);
  assertRefused("other stage", supervisor((value) => {
    value.cwd = "/elsewhere";
  }), /did not run this stage's worker/);
  assertRefused("other report", supervisor((value) => {
    value.out_dir = "/elsewhere";
  }), /not the supervised run's report/);
  assertRefused("slack", supervisor((value) => {
    value.limits.conditionSlackMs = 30_000;
  }), /extended condition deadlines by 30000 ms/);
  assertRefused("limits", supervisor((value) => {
    value.limits.wallCapMs = 10_800_000;
  }), /limits differ from the stage config/);
  assertRefused("report outside run", supervisor((value) => {
    value.ended_at = new Date(Date.UTC(2026, 9, 3, 3, 0, 10)).toISOString();
  }), /not written inside the supervised run/);
  assertRefused("failed gate", gates((value) => {
    value.gates[0].passed = false;
  }), /gate npm test did not pass/);
  assertRefused("duplicate gate", gates((value) => {
    value.gates.push({ ...value.gates[2] });
  }), /gate live_browser_smoke is recorded 2 times/);
  assertRefused("missing log", gates((value) => {
    value.gates[1].log = "out/absent.log";
  }), /has no log at out\/absent\.log/);
  assertRefused("early gates", gates((value) => {
    value.recorded_at = new Date(Date.UTC(2026, 9, 3, 2, 0, 0)).toISOString();
  }), /recorded before the supervised validation and dry run ended/);
  assertRefused("gates before the dry run ended", gates((value) => {
    value.recorded_at = new Date(Date.UTC(2026, 9, 3, 3, 0, 55)).toISOString();
  }), /recorded before the supervised validation and dry run ended/);
});

test("freeze: the successor needs a passing bound dry run, the predecessor freeze and the frozen plans", () => {
  const dryRun = (edit) => (fixture) => editJson(fixture.paths.dryRun, edit);
  const dryRunSupervisor = (edit) => (fixture) => editJson(fixture.paths.dryRunSupervisor, edit);
  assertRefused("dry run incomplete", dryRun((value) => {
    value.incomplete = [{ item: "rendered-x" }];
    value.passed = false;
  }), /measurement dry run did not pass/);
  assertRefused("full measurement offered as the dry run", dryRun((value) => {
    value.mode = "full";
  }), new RegExp(`not ${MEASUREMENT_SCHEMA} dry_run`));
  assertRefused("dry-run item missing", dryRun((value) => {
    value.items.pop();
  }), /dry-run items are not the full dry-run plan/);
  assertRefused("dry run on another stage", dryRun((value) => {
    value.stage.config_sha256 = "0".repeat(64);
  }), /dry run ran on a different stage config/);
  assertRefused("dry run without --measure dry_run", dryRunSupervisor((value) => {
    value.command = value.command.slice(0, 2);
  }), /dry run supervisor did not run this stage's worker/);
  assertRefused("dry run limits", dryRunSupervisor((value) => {
    value.limits.wallCapMs = 5400 * 1000;
  }), /dry run supervisor limits differ/);
  assertRefused("validation run with measurement arguments", (fixture) => editJson(fixture.paths.supervisor, (value) => {
    value.command = [...value.command, "--measure", "full"];
  }), /validation supervisor did not run this stage's worker/);
  assertRefused("missing dry-run gate", (fixture) => editJson(fixture.paths.gates, (value) => {
    value.gates.pop();
  }), /gate supervised_measurement_dry_run is recorded 0 times/);
  assertRefused("changed predecessor", (fixture) => fs.appendFileSync(fixture.paths.predecessor, "!"),
    /predecessor freeze .* hashes to/);
  assertRefused("changed measurement plan", (fixture) => {
    editJson(path.join(fixture.stage, "config.json"), (config) => {
      config.measurement.complete_path.samples = 50;
    });
    fixture.restage();
  }, /config measurement plan differs/);
  assertRefused("changed display", (fixture) => {
    editJson(path.join(fixture.stage, "config.json"), (config) => {
      config.browser.device_scale_factor = 2;
    });
    fixture.restage();
  }, /config display settings differ/);
  assertRefused("changed live v1", (fixture) => {
    fixture.put(LIVE_V1_PIN.module, "export const EDGER_POLICY_MODEL = {};\n");
    fixture.restage();
  }, /differ from the live-v1 pin/);
  assertRefused("expectations replaced", (fixture) => {
    editJson(path.join(fixture.stage, "data", "node-expectations.json"), (value) => {
      value.v1_baselines = [];
    });
  }, /^changed data\/node-expectations\.json$/, /config requires live-v1 baselines but the expectations have none/);
});

test("console filter drops only the headed favicon 404 at its exact local URL", () => {
  const favicon = "http://127.0.0.1:4321/favicon.ico";
  assert.equal(retainedConsoleError({ type: "error", text: FAVICON_MISSING_RESOURCE, url: favicon }, favicon), null);
  assert.equal(retainedConsoleError({ type: "warning", text: "anything", url: "" }, favicon), null);
  // Unrelated errors are retained, including ones that mention a favicon.
  const unrelated = [
    { type: "error", text: "favicon handler threw TypeError", url: "http://127.0.0.1:4321/src/client/webGame.js" },
    { type: "error", text: "Failed to load favicon.png", url: "" },
    { type: "error", text: FAVICON_MISSING_RESOURCE, url: "http://127.0.0.1:4321/data/models/r0-learned-full.json" },
    { type: "error", text: FAVICON_MISSING_RESOURCE, url: "http://127.0.0.1:9999/favicon.ico" },
    { type: "error", text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)", url: favicon },
  ];
  for (const message of unrelated) {
    const retained = retainedConsoleError(message, favicon);
    assert.ok(retained?.startsWith(`console: ${message.text}`), JSON.stringify(message));
    if (message.url) {
      assert.ok(retained.endsWith(`(${message.url})`));
    }
  }
});

test("display admission: kiosk fullscreen passes; ordinary fullscreen, scale, focus and clipping fail", () => {
  // Geometry recorded by the October 6 kiosk and ordinary-fullscreen probes.
  const screen = { width: 1440, height: 900 };
  const expected = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, screen, chromiumPid: 41 };
  const kioskPage = {
    device_pixel_ratio: 2, inner: [390, 844], outer: [1440, 900], origin: [0, 0], visual: [390, 844, 1],
    visibility: "visible", canvas_backing: [780, 1688], canvas_css: [390, 844],
  };
  const fullscreen = { bounds: { left: 0, top: 0, width: 1440, height: 900, windowState: "fullscreen" } };
  const kiosk = checkDisplayGeometry(
    { window: fullscreen, page: kioskPage, frontmostPid: 41, capture: { width: 2880, height: 1798 } }, expected);
  assert.equal(kiosk.passed, true, JSON.stringify(kiosk.checks));
  const ordinary = checkDisplayGeometry({
    window: fullscreen,
    page: { ...kioskPage, outer: [1440, 813], origin: [0, 87] },
    frontmostPid: 41,
    capture: { width: 2880, height: 1624 },
  }, expected);
  assert.deepEqual(ordinary.failed, ["no_content_inset", "capture_covers_viewport"]);
  const fail = (input) => checkDisplayGeometry({ window: fullscreen, page: kioskPage, frontmostPid: 41, ...input }, expected).failed;
  assert.deepEqual(fail({ frontmostPid: 969 }), ["frontmost"]);
  assert.deepEqual(fail({ window: { bounds: { ...fullscreen.bounds, windowState: "normal" } } }), ["window_fullscreen"]);
  assert.deepEqual(fail({ page: { ...kioskPage, device_pixel_ratio: 1, canvas_backing: [390, 844] } }), ["device_pixel_ratio", "canvas_backing"]);
  assert.deepEqual(fail({ page: { ...kioskPage, visibility: "hidden" } }), ["visible"]);
  assert.deepEqual(fail({ page: { ...kioskPage, inner: [390, 807], visual: [390, 807, 1] } }), ["css_viewport", "visual_viewport"]);
  // Headless pages have no window to place: only viewport, scale, visibility and canvas.
  const headless = checkDisplayGeometry({ page: { ...kioskPage, device_pixel_ratio: 1, canvas_backing: [390, 844] } },
    { viewport: expected.viewport, deviceScaleFactor: 1 });
  assert.deepEqual(Object.keys(headless.checks), ["css_viewport", "visual_viewport", "device_pixel_ratio", "visible", "canvas_backing"]);
  assert.equal(headless.passed, true);
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x49484452, 12);
  png.writeUInt32BE(2880, 16);
  png.writeUInt32BE(1798, 20);
  assert.deepEqual(pngSize(png), { width: 2880, height: 1798 });
  assert.throws(() => pngSize(Buffer.alloc(24)), /not a PNG/);
});

test("plans: v1 baselines join every fast-forward context; the measurement plan is ordered and bounded", () => {
  const fullMatches = [];
  for (const model of ["r0", "r1", "r2"]) {
    for (const controller of [LEARNED, FIXED_ONE_TICK]) {
      for (const actor of ["blue", "red"]) {
        fullMatches.push({ id: `${DEV_SEED}-${model}-${controller}-${actor}`, seed: DEV_SEED, model, controller,
          candidate_actor: actor, result: { tick: 3000 } });
      }
    }
  }
  const v1 = ["blue", "red"].map((actor) => ({ id: `${DEV_SEED}-v1-${actor}`, kind: "v1_baseline", seed: DEV_SEED,
    model: "v1", controller: "live_v1", candidate_actor: actor, result: { tick: 3600 } }));
  const expectations = { full_matches: fullMatches, v1_baselines: v1 };
  const config = buildValidationConfig({ seed: DEV_SEED, models: { r0: {}, r1: {}, r2: {} }, bank: {}, expectations: {},
    engine: "chromium" });
  const coverage = plannedCoverage(buildPlan(config, expectations));
  assert.deepEqual(coverage, {
    smoke_viewports: 2, jump_matches: 2, fast_forward_contexts: 4, fast_forward_matches: 4 * 28,
    fast_forward_v1_baseline_matches: 16, bank_checks: 4, real_time_matches: 8,
  });
  assert.throws(() => buildPlan(config, { full_matches: fullMatches }), /expectations have none/);

  const full = buildMeasurementPlan(config, expectations, "full");
  const phases = full.map((item) => item.phase);
  const count = (phase) => phases.filter((name) => name === phase).length;
  assert.deepEqual([count("existing_method"), count("complete_path"), count("node_gc"), count("rendered"), count("browser_gc")],
    [15, 1, 12, 28, 14]);
  // Node paths run before any browser path; the order is phase-contiguous.
  assert.deepEqual([...new Set(phases)], ["existing_method", "complete_path", "node_gc", "rendered", "browser_gc"]);
  assert.deepEqual(full.slice(0, 4).map((item) => item.id), ["existing-r0-1", "existing-r1-1", "existing-r2-1", "existing-r0-2"]);
  const rendered = full.filter((item) => item.phase === "rendered");
  assert.deepEqual(rendered.map((item) => item.condition), [...profilingMatrix(DEV_SEED), ...v1BaselineMatrix(DEV_SEED)]);
  assert.ok(rendered.every((item) => item.window_ticks === null && item.expected.candidate_actor === item.condition.candidate_actor));
  assert.equal(rendered[24].expected.kind, "v1_baseline");
  const gc = full.filter((item) => item.phase === "browser_gc");
  assert.deepEqual(gc.slice(0, 2).map((item) => item.trace), ["untraced", "traced"]);
  assert.ok(gc.every((item) => item.window_ticks === 1200 && item.viewport === "portrait"));
  assert.equal(new Set(gc.map((item) => item.condition.id)).size, 7);

  const dry = buildMeasurementPlan(config, expectations, "dry_run");
  assert.deepEqual(dry.map((item) => item.id), [
    "existing-r0-1", "complete-path", "node-gc-r0-learned-untraced", "node-gc-r0-learned-traced",
    `rendered-${DEV_SEED}-r0-learned-blue-portrait`, `rendered-${DEV_SEED}-v1-red-desktop`,
    `browser-gc-${DEV_SEED}-r0-learned-blue-portrait-untraced`, `browser-gc-${DEV_SEED}-r0-learned-blue-portrait-traced`,
  ]);
  assert.deepEqual([dry[1].states, dry[1].warmups, dry[1].samples], [2, 2, 5]);
  assert.ok(dry.filter((item) => item.phase === "rendered" || item.phase === "browser_gc").every((item) => item.window_ticks === 200));
  assert.throws(() => buildMeasurementPlan(config, expectations, "partial"), /unknown measurement mode/);
});

test("windowed matches must end at their admitted endpoint and follow the Node schedule", () => {
  const expected = {
    schedule: [1, 2, 3, 4].map((tick) => ({ tick, card_id: null, x: null, y: null, delay_ticks: 1 })),
    result: { winner: "blue", reason: "r", tick: 4 },
  };
  const final = { status: "stopped", stop_reason: "max_ticks", terminal_tick: 2, schedule: expected.schedule.slice(0, 2),
    counts: { decisions: 2 } };
  const check = (value, windowTicks = 2) => checkWindowAgainstExpectation({ final: value, expected, windowTicks });
  assert.equal(check(final).passed, true);
  assert.deepEqual(check(final).endpoint, { requested: 2, admitted: 2, reached: 2 });
  assert.equal(check({ ...final, stop_reason: "display_lost" }).passed, false);
  const diverged = structuredClone(final);
  diverged.schedule[1].card_id = "knight";
  assert.equal(check(diverged).checks.schedule_prefix, false);
  assert.equal(check(null).passed, false);
  assert.throws(() => checkWindowAgainstExpectation({ final, expected }), /positive integer windowTicks/);

  // Catch-up burst: the page checks max_ticks after a whole frame, so a frame
  // that drains two ticks stops one past the window. Even with a schedule that
  // matches its own prefix, the overshoot is incomplete.
  const burst = { ...final, terminal_tick: 3, schedule: expected.schedule.slice(0, 3), counts: { decisions: 3 } };
  const overshoot = check(burst);
  assert.equal(overshoot.passed, false);
  assert.deepEqual(overshoot.checks, { status: true, endpoint: false, schedule_prefix: true, counts: true });
  assert.deepEqual(overshoot.endpoint, { requested: 2, admitted: 2, reached: 3 });
  // Stopping short of the window is incomplete too.
  assert.equal(check({ ...final, terminal_tick: 1, schedule: expected.schedule.slice(0, 1), counts: { decisions: 1 } }, 2)
    .checks.endpoint, false);

  // A window past the match end admits the match end, reached only by completion.
  assert.equal(windowEndpoint(expected, 10), 4);
  const complete = { status: "complete", stop_reason: null, result: expected.result, terminal_tick: 4,
    schedule: expected.schedule, counts: { decisions: 4 } };
  assert.equal(check(complete, 10).passed, true);
  assert.equal(check(complete, 4).passed, true);
  assert.equal(check({ ...complete, status: "stopped", stop_reason: "max_ticks" }, 10).checks.status, false);
});

test("browser GC pairs need an admitted partner, one admitted endpoint and equal hashes", () => {
  const window = (overrides = {}) => ({
    id: "browser-gc-c-untraced", condition: "c", trace: "untraced", window_passed: true, passed: true,
    admitted_endpoint: 1200, terminal_tick: 1200, action_stream_hash: "a", final_state_hash: "x", ...overrides,
  });
  const traced = (overrides = {}) => window({ id: "browser-gc-c-traced", trace: "traced", ...overrides });
  const admitted = admitBrowserGcPair({ entry: traced(), partner: window() });
  assert.deepEqual(admitted, {
    complete: true, problems: [], ids: ["browser-gc-c-untraced", "browser-gc-c-traced"], endpoint: 1200,
    terminal_ticks: [1200, 1200],
  });
  const problems = (entry, partner) => admitBrowserGcPair({ entry, partner }).problems;
  // The review's reproduction: tick-1200/tick-1201 partners with different
  // stream/state hashes. The later window overshot, so its own check failed.
  assert.deepEqual(problems(traced({ window_passed: false, terminal_tick: 1201, action_stream_hash: "b",
    final_state_hash: "y" }), window()), ["window_incomplete", "unequal_endpoint", "hash_mismatch"]);
  // Even if both windows were somehow passed, unequal endpoints are refused.
  assert.deepEqual(problems(traced({ terminal_tick: 1201 }), window()), ["unequal_endpoint"]);
  assert.deepEqual(problems(traced(), undefined), ["missing_partner"]);
  assert.deepEqual(problems(traced(), window({ window_passed: false, passed: false })), ["partner_incomplete"]);
  assert.deepEqual(problems(traced(), window({ admitted_endpoint: 200, terminal_tick: 200 })), ["unequal_endpoint"]);
  assert.deepEqual(problems(traced({ final_state_hash: "y" }), window()), ["hash_mismatch"]);
  assert.deepEqual(problems(traced({ action_stream_hash: null }), window({ action_stream_hash: null })),
    ["hash_mismatch"]);
  assert.deepEqual(problems(traced({ admitted_endpoint: null }), window()), ["unequal_endpoint"]);
});

test("trace and heap summaries split main-thread GC and rank sampled allocation sites", () => {
  const trace = { traceEvents: [
    { ph: "M", name: "thread_name", pid: 1, tid: 2, args: { name: "CrRendererMain" } },
    { ph: "X", name: "MinorGC", pid: 1, tid: 2, dur: 1500 },
    { ph: "X", name: "MinorGC", pid: 1, tid: 2, dur: 500 },
    { ph: "X", name: "V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL", pid: 1, tid: 9, dur: 300 },
    { ph: "X", name: "FunctionCall", pid: 1, tid: 2, dur: 9000 },
    { ph: "B", name: "MajorGC", pid: 1, tid: 2 },
  ] };
  assert.deepEqual(summarizeChromeTrace(trace), {
    events: 6,
    renderer_main_threads: 1,
    gc_events: {
      "main:MinorGC": { count: 2, sum_ms: 2, max_ms: 1.5 },
      "other:V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL": { count: 1, sum_ms: 0.3, max_ms: 0.3 },
    },
  });
  const frame = (functionName, lineNumber) => ({ functionName, url: "http://x/src/ai/botRuntime.js", lineNumber });
  const heap = summarizeHeapProfile({
    head: { callFrame: frame("(root)", 0), selfSize: 0, children: [
      { callFrame: frame("enumerate", 9), selfSize: 4096, children: [] },
      { callFrame: frame("decide", 19), selfSize: 1024, children: [{ callFrame: frame("enumerate", 9), selfSize: 1024, children: [] }] },
    ] },
    samples: [{ size: 4096 }, { size: 1024 }, { size: 1024 }],
  });
  assert.equal(heap.sampled_bytes, 6144);
  assert.deepEqual(heap.top_sites[0], { site: "enumerate botRuntime.js:10", bytes: 5120 });
});

test("tree CPU tracker counts new processes from zero and flags exits as a lower bound", () => {
  const ps = (rows) => parsePsOutput(rows.map(([pid, ppid, cpu, start]) =>
    `  ${pid}  ${ppid}  ${pid} S  ${cpu} Fri Oct  3 11:41:0${start} 2026     chrome`).join("\n"));
  const tracker = createTreeCpuTracker(10);
  tracker.sample(ps([[10, 1, "0:01.00", 0], [11, 10, "0:02.00", 1]]));
  tracker.sample(ps([[10, 1, "0:01.50", 0], [11, 10, "0:02.25", 1], [12, 10, "0:00.40", 2]]));
  tracker.sample(ps([[10, 1, "0:02.00", 0], [12, 10, "0:00.60", 2]]));
  assert.deepEqual(tracker.summary(), { cpu_s: 1.85, samples: 3, processes: 3, appeared: 1, exited: 1, lower_bound: true });
  const steady = createTreeCpuTracker(10);
  steady.sample(ps([[10, 1, "0:01.00", 0]]));
  steady.sample(ps([[10, 1, "0:03.00", 0]]));
  assert.deepEqual(steady.summary(), { cpu_s: 2, samples: 2, processes: 1, appeared: 0, exited: 0, lower_bound: false });
});

test("measurement config: dry-run and GC conditions come from the frozen rendered matrix", () => {
  const measurement = buildMeasurementConfig(DEV_SEED);
  const ids = measurement.rendered.conditions.map((condition) => condition.id);
  assert.equal(ids.length, 28);
  assert.equal(new Set(ids).size, 28);
  assert.deepEqual(measurement.rendered.conditions.slice(0, 24), profilingMatrix(DEV_SEED));
  assert.deepEqual(v1BaselineMatrix(DEV_SEED).map((condition) => condition.id), [
    `${DEV_SEED}-v1-blue-portrait`, `${DEV_SEED}-v1-red-portrait`, `${DEV_SEED}-v1-blue-desktop`, `${DEV_SEED}-v1-red-desktop`,
  ]);
  for (const id of measurement.dry_run.rendered.conditions) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(measurement.browser_gc.conditions.every((condition) => ids.includes(condition.id)));
  assert.equal(measurement.browser_gc.window_ticks / 20, 60, "60 s trace windows at 20 ticks/s");
  assert.ok(measurement.node_gc.window_s <= 60);
  assert.equal(measurement.total_wall_cap_s, 3 * 3600);
  assert.deepEqual([measurement.existing_method.invocations, measurement.existing_method.samples,
    measurement.existing_method.warmups, measurement.existing_method.budget_ms], [5, 100, 10, 5]);
  assert.deepEqual([measurement.complete_path.warmups, measurement.complete_path.samples], [10, 100]);
});

// One structured clone per path: no path may inherit another's warmed caches.
function pathModels(model, paths = ["diagnostic", "production", "observed"], run = "t") {
  return Object.fromEntries(paths.map((pathId) => [pathId, { [run]: structuredClone(model) }]));
}

let measureFixtureValue = null;
function measureFixture() {
  measureFixtureValue ??= buildMeasureFixture();
  return measureFixtureValue;
}

function buildMeasureFixture() {
  const model = randomModel(43);
  const bank = buildStateBank({
    label: "runtime-cost-measure-test-bank",
    seeds: [DEV_SEED],
    models: { t: model },
    controllers: [LEARNED],
    requiredCategories: ["forced_pass", "elective"],
    perCategory: 1,
    stride: 40,
  });
  const expectations = buildNodeExpectations({ bank, models: { t: model }, matchSeeds: [DEV_SEED], controllers: [LEARNED],
    v1Baselines: false });
  const expected = new Map(expectations.bank_decisions.map((entry) =>
    [`${entry.state}|${entry.actor}|${entry.model}|${entry.controller}`, entry.decision]));
  return { model, bank, expected };
}

test("complete path: reference-checked, ordered, raw samples, first calls and paired GC windows", async () => {
  const { model, bank, expected } = measureFixture();
  const states = bank.states.slice(0, 2);
  assert.deepEqual(completePathPlan({ states, runs: ["t"] }).slice(0, 7).map((entry) =>
    `${entry.state === states[0].id}|${entry.path}|${entry.controller}|${entry.actor}`), [
    "true|diagnostic|learned|blue", "true|diagnostic|learned|red", "true|diagnostic|fixed_one_tick|blue",
    "true|diagnostic|fixed_one_tick|red", "true|production|learned|blue", "true|production|learned|red",
    "true|observed|learned|blue",
  ]);
  const result = await measureCompletePath({ bank, modelsByPath: pathModels(model), expected, states: 2, warmups: 3,
    samples: 4 });
  assert.equal(result.schema_version, COMPLETE_PATH_SCHEMA);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.completed, result.planned);
  assert.equal(result.planned, 2 * (4 + 2 + 4));
  assert.equal(result.coverage_sha256, result.plan_sha256);
  assert.deepEqual(completePathCoverageProblems(result), []);
  for (const entry of result.combinations) {
    assert.equal(entry.warmup_ms.length, 3);
    assert.equal(entry.samples.total_ms.length, 4);
    assert.ok(entry.samples.total_ms.every((value, index) =>
      Math.abs(value - entry.samples.enumerate_ms[index] - entry.samples.decide_ms[index]) < 1e-5));
    assert.ok(["play", "elective_pass", "forced_pass"].includes(entry.decision_kind));
    assert.equal(entry.observer_refused, entry.path === "observed" ? 0 : null);
  }
  assert.deepEqual(result.first_calls.map((entry) => entry.path), ["diagnostic", "production", "observed"]);
  assert.ok(result.summary.groups["path|production"].count === 2 * 2 * 4);
  assert.equal(result.gc_trace, null);

  // A wrong reference decision aborts before any timing.
  const wrong = new Map(expected);
  const key = [...wrong.keys()][0];
  wrong.set(key, { ...wrong.get(key), delayTicks: 99 });
  const refused = await measureCompletePath({ bank, modelsByPath: pathModels(model), expected: wrong, states: 1,
    warmups: 1, samples: 1 });
  assert.equal(refused.mismatches.length, 1);
  assert.equal(refused.completed, 0);
  assert.deepEqual(completePathCoverageProblems(refused), ["reference_mismatch", "coverage"]);

  // Paired windows: traced records GC and sampled allocation within a labelled scope.
  const diagnosticOnly = () => pathModels(model, ["diagnostic"]);
  const traced = await measureCompletePath({ bank, modelsByPath: diagnosticOnly(), expected, states: 1, warmups: 1,
    samples: 2, paths: ["diagnostic"], gc: "traced" });
  assert.equal(traced.gc, "traced");
  assert.equal(traced.gc_trace.scope, GC_TRACE_SCOPE);
  assert.ok(traced.gc_trace.heap_sampling.sampled_bytes > 0);
  assert.ok(Number.isInteger(traced.gc_trace.gc_entries.count));
  assert.deepEqual(completePathCoverageProblems(traced), []);
});

test("complete path: every path validates its own model objects at its own first call", async () => {
  const { model, bank, expected } = measureFixture();
  const modelsByPath = pathModels(model);
  // policy.js reads schema_version only when it validates an object it has not
  // cached; the synthetic clock places each read.
  let fakeTime = 0;
  const reads = { diagnostic: [], production: [], observed: [] };
  for (const [pathId, { t }] of Object.entries(modelsByPath)) {
    const schema = t.schema_version;
    Object.defineProperty(t, "schema_version", { get() { reads[pathId].push(fakeTime); return schema; } });
  }
  const result = await measureCompletePath({ bank, modelsByPath, expected, states: 1, warmups: 1, samples: 1,
    now: () => ++fakeTime });
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.first_calls.map((entry) => entry.path), ["diagnostic", "production", "observed"]);
  // The identity check reads at clock 0, before any call. After that, each path
  // object gets the same cold validation, in path order: the frozen state-major
  // order puts each path's first call after the previous path's calls. A shared
  // object would leave the later paths with no validation reads at all.
  const inLoop = Object.values(reads).map((list) => list.filter((at) => at > 0));
  assert.ok(inLoop[0].length > 0);
  assert.deepEqual(inLoop.map((list) => list.length), [inLoop[0].length, inLoop[0].length, inLoop[0].length]);
  assert.ok(Math.max(...inLoop[0]) < Math.min(...inLoop[1]) && Math.max(...inLoop[1]) < Math.min(...inLoop[2]));

  // Shared model or layer objects are refused before anything runs.
  const shared = structuredClone(model);
  await assert.rejects(measureCompletePath({ bank, expected, states: 1, warmups: 1, samples: 1,
    modelsByPath: { diagnostic: { t: shared }, production: { t: shared }, observed: { t: structuredClone(model) } } }),
  /production t model shares objects with the diagnostic t model/);
  const shallow = { ...shared };
  assert.deepEqual(modelIdentityProblems({ diagnostic: { t: shared }, observed: { t: shallow } }, ["diagnostic", "observed"],
    ["t"]), ["the observed t model shares objects with the diagnostic t model"]);
  const layerShared = structuredClone(model);
  const [layerName] = Object.keys(layerShared.weights);
  layerShared.weights[layerName] = shared.weights[layerName];
  assert.equal(modelIdentityProblems({ diagnostic: { t: shared }, production: { t: layerShared } },
    ["diagnostic", "production"], ["t"]).length, 1);
  assert.deepEqual(modelIdentityProblems({ diagnostic: { t: shared } }, ["diagnostic", "production"], ["t"]),
    ["no t model object for the production path"]);

  // The CLI loader parses one object per path and model from the pinned file.
  const directory = tempDir("path-models");
  fs.writeFileSync(path.join(directory, "t.json"), JSON.stringify(model));
  const config = { models: { t: { path: "t.json", sha256: sha256Hex(fs.readFileSync(path.join(directory, "t.json"))) } } };
  const paths = ["diagnostic", "production", "observed"];
  const loaded = loadPathModels({ stageDir: directory, config, runs: ["t"], paths });
  assert.deepEqual(Object.keys(loaded), paths);
  assert.deepEqual(modelIdentityProblems(loaded, paths, ["t"]), []);
  assert.deepEqual(loaded.production.t, loaded.diagnostic.t);
});

test("complete path: the observed timer brackets the whole hook lifecycle; every path classifies", () => {
  const { model, bank } = measureFixture();
  const state = bank.states[0];
  const source = bank.sources.find((entry) => entry.id === state.source_id);
  const engine = rebuildEngineAt({ seed: source.seed, actions: source.actions, tick: state.tick });
  let clock = 0;
  const now = () => ++clock;
  const seen = [];
  const hook = (phase, detail) => seen.push({ phase, at: clock, detail });
  const call = (pathId) => timedCall({ pathId, model, engine, actor: "blue", controller: LEARNED, tick: state.tick,
    hook: pathId === "observed" ? hook : null, now });
  const observed = call("observed");
  // The timer starts at clock 1, before hook("begin"), and reads the clock
  // once more after hook("schedule").
  assert.deepEqual([seen[0].phase, seen[0].at], ["begin", 1]);
  const schedule = seen[seen.length - 1];
  assert.equal(schedule.phase, "schedule");
  assert.equal(schedule.detail.kind, observed.kind);
  assert.equal(clock, schedule.at + 1);
  assert.equal(observed.durations[2], clock - 1);
  // The unhooked paths classify the same decision and read the clock three times.
  for (const pathId of ["diagnostic", "production"]) {
    const before = clock;
    const result = call(pathId);
    assert.equal(result.kind, observed.kind, pathId);
    assert.deepEqual([clock - before, result.durations[2]], [3, 2], pathId);
  }
  assert.ok(["play", "elective_pass", "forced_pass"].includes(observed.kind));
});

test("complete path: zero, partial and unequal Node GC coverage are incomplete", async () => {
  const { model, bank, expected } = measureFixture();
  const run = (options) => measureCompletePath({ bank, modelsByPath: pathModels(model, ["diagnostic"]), expected,
    warmups: 1, samples: 1, paths: ["diagnostic"], gc: "untraced", ...options });
  // A spent window: the child exits zero with no combination completed.
  const spent = await run({ states: 1, windowMs: 0 });
  assert.equal(spent.truncated, true);
  assert.equal(spent.completed, 0);
  assert.deepEqual(completePathCoverageProblems(spent), ["truncated", "coverage"]);
  // The review's record shape: 118 planned, none completed, no mismatches.
  assert.deepEqual(completePathCoverageProblems({ planned: 118, completed: 0, truncated: true, mismatches: [],
    plan_sha256: "p", coverage_sha256: "c" }), ["truncated", "coverage"]);
  // Partial coverage: a counting clock spends the window part-way through the
  // plan (about seven reads per combination here).
  const counter = () => {
    let reads = 0;
    return () => ++reads;
  };
  const partial = await run({ states: 1, windowMs: 10, now: counter() });
  assert.equal(partial.truncated, true);
  assert.ok(partial.completed > 0 && partial.completed < partial.planned);
  assert.deepEqual(completePathCoverageProblems(partial), ["truncated", "coverage"]);
  assert.deepEqual(completePathCoverageProblems(null), ["no result"]);
  // A complete result with a forged count still fails on its identities.
  const full = await run({ states: 1 });
  assert.deepEqual(completePathCoverageProblems(full), []);
  assert.deepEqual(completePathCoverageProblems({ ...full, coverage_sha256: partial.coverage_sha256 }), ["coverage"]);

  // Pairs compare coverage identities explicitly.
  const entry = (result, trace) => ({ id: `node-gc-t-learned-${trace}`, trace, coverage_problems:
    completePathCoverageProblems(result), plan_sha256: result.plan_sha256, coverage_sha256: result.coverage_sha256 });
  const twoStates = await run({ states: 2 });
  assert.deepEqual(admitNodeGcPair({ entry: entry(full, "traced"), partner: entry(full, "untraced") }),
    { complete: true, problems: [], ids: ["node-gc-t-learned-untraced", "node-gc-t-learned-traced"] });
  assert.deepEqual(admitNodeGcPair({ entry: entry(full, "traced"), partner: undefined }).problems, ["missing_partner"]);
  assert.deepEqual(admitNodeGcPair({ entry: entry(full, "traced"), partner: entry(partial, "untraced") }).problems,
    ["partner_incomplete", "coverage_differs"]);
  assert.deepEqual(admitNodeGcPair({ entry: entry(twoStates, "traced"), partner: entry(full, "untraced") }).problems,
    ["plan_differs", "coverage_differs"]);
  // Unequal prefixes of the same plan: both truncated at different points.
  const shorter = await run({ states: 2, windowMs: 10, now: counter() });
  const longer = await run({ states: 2, windowMs: 24, now: counter() });
  assert.ok(shorter.completed > 0 && shorter.completed < longer.completed && longer.completed < longer.planned);
  assert.equal(shorter.plan_sha256, longer.plan_sha256);
  const unequal = admitNodeGcPair({ entry: entry(longer, "traced"), partner: entry(shorter, "untraced") });
  assert.deepEqual(unequal.problems, ["partner_incomplete", "window_incomplete", "coverage_differs"]);
});

test("existing method: one child invocation of the unchanged promotion timing test", () => {
  const directory = tempDir("existing-method");
  const model = createEdgerV2BootstrapModel({ modelId: "runtime-cost-existing-method-test" });
  const file = path.join(directory, "model.json");
  fs.writeFileSync(file, JSON.stringify(model));
  const out = path.join(directory, "result.json");
  const script = path.join(ROOT, "scripts", "edger-v2-runtime-cost-measure.mjs");
  const run = (sha256) => spawnSync(process.execPath, [script, "existing-method", "--model", file, "--sha256", sha256,
    "--samples", "20", "--warmups", "2", "--budget-ms", "5", "--out", out], { encoding: "utf8", timeout: 60_000 });
  const refused = run("0".repeat(64));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /hashes to/);
  const ok = run(sha256Hex(fs.readFileSync(file)));
  assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(result.schema_version, "edger_v2_runtime_cost_existing_method_v1");
  assert.deepEqual(result.options, { samples: 20, warmupSamples: 2, budgetMs: 5 });
  assert.deepEqual(Object.keys(result.timing), ["passed", "samples", "warmup_samples", "budget_ms", "p95_ms", "max_ms"]);
  assert.equal(result.process.node, process.version);
});
