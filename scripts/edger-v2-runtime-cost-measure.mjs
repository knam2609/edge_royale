#!/usr/bin/env node
// Node measurement paths for the Edger v2 runtime-cost study.
//
// Run from a runtime-cost stage as child processes of the browser worker's
// measurement mode, one at a time, each writing one JSON result:
//
//   existing-method  One independent invocation of the unchanged promotion
//                    timing test (evaluateTiming: five scenario fixtures,
//                    legal actions pre-enumerated, production selector) for one
//                    checkpoint. Only its p95/max are reported by that method.
//   complete-path    The complete candidate decision path on every frozen bank
//                    state, actor, model and controller: legal enumeration,
//                    observation, masks, encoding, card/placement heads, the
//                    learned delay head, decode, scheduling and action
//                    construction, with warmups and raw samples. The production
//                    learned selector is a separate path, and the same diagnostic
//                    path with the browser collector hook attached measures
//                    observer overhead. --gc traced|untraced runs a bounded,
//                    paired allocation/GC window; traced timings are labelled and
//                    never mixed with untraced ones.
//
// Every timed decision is first checked against the Node reference decision
// for that state/actor/model/controller; a mismatch aborts before timing. Each
// path gets its own parsed model objects, so no path inherits another's warmed
// model/layer caches.

import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { selectEdgerV2PolicyDecision, validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import {
  EDGER_V2_DIAGNOSTIC_CONTROLLERS,
  decideEdgerV2Diagnostic,
} from "./edger-v2-runtime-cost-adapter.js";
import { createRuntimeCostCollectors, summarizeSamples } from "./edger-v2-runtime-cost-collectors.js";
import { rebuildEngineAt, sha256Hex } from "./edger-v2-runtime-cost-core.mjs";

export const EXISTING_METHOD_SCHEMA = "edger_v2_runtime_cost_existing_method_v1";
// v2: model objects per path, the observed path brackets the whole hook
// lifecycle, every path classifies its decision, plan/coverage identities and
// a labelled GC trace scope.
export const COMPLETE_PATH_SCHEMA = "edger_v2_runtime_cost_complete_path_v2";

export const COMPLETE_PATHS = Object.freeze({
  diagnostic: "diagnostic adapter, complete path (the browser driver's candidate decision)",
  production: "production learned selector (selectEdgerV2PolicyDecision) with the same enumeration, " +
    "scheduling and action construction; learned controller only",
  observed: "diagnostic path with the browser collector phase hook attached (observer overhead)",
});

export const COMPLETE_PATH_BOUNDARIES = Object.freeze({
  enumerate_ms: "enumerateLegalCardActions for the candidate actor; on the observed path it also holds " +
    "hook(\"begin\")",
  decide_ms: "from after enumeration through the decision, legality check, schedule row, action construction " +
    "and decision classification; on the observed path also the phase hooks through hook(\"schedule\")",
  total_ms: "enumeration through classification; one performance.now() pair per boundary. Every path does the " +
    "same bookkeeping and classification; only the observed path calls hooks, and its total brackets the whole " +
    "hook lifecycle from hook(\"begin\") through hook(\"schedule\"), so observed minus diagnostic is observer overhead",
  warmup_ms: "total_ms of each warmup call, in order; the first is that combination's first call",
  first_calls: "the first call of each path with each model: every path parses its own model objects before any " +
    "call, so this first call includes the cold model-validation and convolution-kernel cache work. It is " +
    "not cold JIT or process startup: one process serves every path and controller, and process costs are " +
    "recorded separately",
});

// What a traced window's GC entries and heap samples cover. They are not
// candidate-only allocations.
export const GC_TRACE_SCOPE = "the whole timed loop after every state is rebuilt: warmups, samples, reference " +
  "checks, collector setup, per-combination bookkeeping and the per-combination state-hash check";

const ACTORS = Object.freeze(["blue", "red"]);
const CONTROLLERS = Object.freeze([EDGER_V2_DIAGNOSTIC_CONTROLLERS.LEARNED, EDGER_V2_DIAGNOSTIC_CONTROLLERS.FIXED_ONE_TICK]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function decisionKey(decision) {
  return JSON.stringify({ action: decision.action, delayTicks: decision.delayTicks, indices: decision.indices });
}

// Load a model by path, refusing any byte difference from its pin. Each call
// parses a fresh object, so the compiled-model cache starts cold.
export function loadPinnedModel(file, sha256) {
  const bytes = fs.readFileSync(file);
  const actual = sha256Hex(bytes);
  if (actual !== sha256) {
    throw new Error(`${file} hashes to ${actual}, not ${sha256}`);
  }
  return validateEdgerV2PolicyModel(JSON.parse(bytes.toString("utf8")));
}

// One freshly parsed object per path and model, all before any timed call
// (path order, then run order). policy.js caches validation by model identity
// and convolution kernels by layer identity, so sharing an object would hand
// later paths the caches an earlier path warmed.
export function loadPathModels({ stageDir, config, runs, paths }) {
  return Object.fromEntries(paths.map((pathId) => [pathId, Object.fromEntries(runs.map((run) =>
    [run, loadPinnedModel(path.join(stageDir, config.models[run].path), config.models[run].sha256)]))]));
}

// Every object reachable from a model (layers and their arrays). Numeric
// arrays are leaves.
function reachableObjects(value, seen) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return seen;
  }
  seen.add(value);
  if (Array.isArray(value) && typeof value[0] !== "object") {
    return seen;
  }
  for (const child of Object.values(value)) {
    reachableObjects(child, seen);
  }
  return seen;
}

// Problems if a path lacks a model or any object (model or layer) is shared
// between two path/model entries.
export function modelIdentityProblems(modelsByPath, paths, runs) {
  const problems = [];
  const owners = new Map();
  for (const pathId of paths) {
    for (const run of runs) {
      const model = modelsByPath[pathId]?.[run];
      if (!model) {
        problems.push(`no ${run} model object for the ${pathId} path`);
        continue;
      }
      const label = `${pathId} ${run}`;
      for (const object of reachableObjects(model, new Set())) {
        const owner = owners.get(object);
        if (owner) {
          problems.push(`the ${label} model shares objects with the ${owner} model`);
          break;
        }
        owners.set(object, label);
      }
    }
  }
  return problems;
}

// What the driver does after deciding: next-decision tick, schedule row,
// legality check against the already-enumerated list and the action object.
function scheduleAndConstruct(decision, legalActions, tick, actor) {
  const row = {
    tick,
    card_index: decision.indices?.card_index ?? null,
    placement_index: decision.indices?.placement_index ?? null,
    delay_index: decision.indices?.delay_index ?? null,
    delay_ticks: decision.delayTicks,
  };
  const action = decision.action;
  if (action?.type !== "PLAY_CARD") {
    return { nextTick: tick + decision.delayTicks, row, action: null };
  }
  const legal = legalActions.some((candidate) =>
    candidate.cardId === action.cardId && candidate.x === action.x && candidate.y === action.y);
  return {
    nextTick: tick + decision.delayTicks,
    row,
    action: legal ? { tick, type: "PLAY_CARD", actor, cardId: action.cardId, x: action.x, y: action.y } : null,
  };
}

function kindOf(decision, legalActions) {
  if (decision.action?.type === "PLAY_CARD") {
    return "play";
  }
  return legalActions.some((candidate) => candidate.type === "PLAY_CARD") ? "elective_pass" : "forced_pass";
}

// One timed call of a path. Returns [enumerate_ms, decide_ms, total_ms], the
// decision and its kind. Every path classifies the decision, as the browser
// driver does; the observed path's timer brackets hook("begin") through
// hook("schedule").
export function timedCall({ pathId, model, engine, actor, controller, tick, hook, now }) {
  const observed = pathId === "observed";
  const start = now();
  if (observed) {
    hook("begin");
  }
  const legalActions = enumerateLegalCardActions({ engine, actor, model });
  const enumerated = now();
  if (observed) {
    hook("enumerate");
  }
  const decision = pathId === "production"
    ? selectEdgerV2PolicyDecision({ model, engine, actor, legalActions })
    : decideEdgerV2Diagnostic({
        model, engine, actor, legalActions, controller, phaseHook: observed ? hook : null,
      });
  const built = scheduleAndConstruct(decision, legalActions, tick, actor);
  const kind = kindOf(decision, legalActions);
  if (observed) {
    hook("schedule", { tick, kind });
  }
  const end = now();
  return { durations: [enumerated - start, end - enumerated, end - start], decision, kind, built };
}

const combinationIdentity = (entry) => [entry.state, entry.path, entry.model, entry.controller, entry.actor];

// Ordered combinations: state-major, then model, controller, actor, then the
// production selector (learned only) for each model and actor, then the
// observed path. The order is frozen with the configuration.
export function completePathPlan({ states, runs, controllers = CONTROLLERS, paths = ["diagnostic", "production", "observed"] }) {
  const plan = [];
  for (const state of states) {
    for (const pathId of paths) {
      for (const run of runs) {
        for (const controller of pathId === "production" ? controllers.filter((c) => c === "learned") : controllers) {
          for (const actor of ACTORS) {
            plan.push({ state: state.id, path: pathId, model: run, controller, actor });
          }
        }
      }
    }
  }
  return plan;
}

// Bounded GC/allocation tracing: GC performance entries and V8's sampling heap
// profiler including objects already collected by minor/major GC, so sampled
// bytes estimate allocation, not only retained memory.
async function startGcTrace({ samplingInterval, entryCap }) {
  const entries = [];
  let refused = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entries.length < entryCap) {
        entries.push([entry.startTime, entry.duration, entry.detail?.kind ?? null]);
      } else {
        refused += 1;
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  return {
    async stop() {
      const { profile } = await session.post("HeapProfiler.stopSampling");
      await session.post("HeapProfiler.disable");
      session.disconnect();
      // GC entries are delivered asynchronously; let pending ones arrive.
      await new Promise((resolve) => setTimeout(resolve, 50));
      observer.disconnect();
      return { entries, refused, profile };
    },
  };
}

// Allocation sites by sampled self size, aggregated over the profile tree.
export function summarizeHeapProfile(profile, top = 20) {
  const sites = new Map();
  const walk = (node) => {
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url ? path.basename(frame.url) : ""}:${frame.lineNumber + 1}`;
    sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(profile.head);
  const sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  return {
    sampled_bytes: sampledBytes,
    samples: profile.samples.length,
    top_sites: [...sites.entries()].sort((left, right) => right[1] - left[1]).slice(0, top)
      .map(([site, bytes]) => ({ site, bytes })),
  };
}

export function summarizeGcEntries(entries) {
  const byKind = {};
  for (const [, duration, kind] of entries) {
    const entry = byKind[kind ?? "unknown"] ?? { count: 0, sum_ms: 0, max_ms: 0 };
    entry.count += 1;
    entry.sum_ms = round(entry.sum_ms + duration);
    entry.max_ms = round(Math.max(entry.max_ms, duration));
    byKind[kind ?? "unknown"] = entry;
  }
  return { count: entries.length, by_kind: byKind, durations_ms: summarizeSamples(entries.map((entry) => entry[1])) };
}

// Time the complete path on bank states. modelsByPath maps path -> run -> a
// model object parsed for that path alone (loadPathModels); shared objects are
// refused before anything runs. expected maps "state|actor|run|controller" ->
// the reference decision.
export async function measureCompletePath({
  bank,
  modelsByPath,
  expected,
  controllers = CONTROLLERS,
  paths = ["diagnostic", "production", "observed"],
  runs = Object.keys(modelsByPath[paths[0]] ?? {}),
  states = null,
  warmups = 10,
  samples = 100,
  gc = null,
  windowMs = null,
  heapSamplingInterval = 32768,
  gcEntryCap = 100_000,
  now = () => performance.now(),
}) {
  const identityProblems = modelIdentityProblems(modelsByPath, paths, runs);
  if (identityProblems.length > 0) {
    throw new Error(`refusing model objects that would share caches:\n- ${identityProblems.join("\n- ")}`);
  }
  const chosen = states === null ? bank.states : bank.states.slice(0, states);
  const sources = new Map(bank.sources.map((source) => [source.id, source]));
  const plan = completePathPlan({ states: chosen, runs, controllers, paths });
  // Every state is rebuilt by replay before timing or tracing starts (59 states
  // hold a few MB), so replay work never interleaves with timed calls.
  const rebuildStart = now();
  const engines = new Map();
  for (const state of chosen) {
    const source = sources.get(state.source_id);
    const engine = rebuildEngineAt({ seed: source.seed, actions: source.actions, tick: state.tick });
    if (engine.getStateHash() !== state.state_hash) {
      throw new Error(`bank state ${state.id} did not rebuild to its hash`);
    }
    engines.set(state.id, { state, engine });
  }
  const rebuildMs = now() - rebuildStart;
  const combinations = [];
  const firstCalls = [];
  const firstSeen = new Set();
  const mismatches = [];
  const trace = gc === "traced" ? await startGcTrace({ samplingInterval: heapSamplingInterval, entryCap: gcEntryCap }) : null;
  const started = now();
  let truncated = false;
  for (const entry of plan) {
    if (windowMs !== null && now() - started >= windowMs) {
      truncated = true;
      break;
    }
    const { state, engine } = engines.get(entry.state);
    const model = modelsByPath[entry.path][entry.model];
    const controller = entry.path === "production" ? "learned" : entry.controller;
    const reference = expected.get(`${state.id}|${entry.actor}|${entry.model}|${controller}`);
    const collectors = entry.path === "observed"
      ? createRuntimeCostCollectors({
          caps: { candidate_decisions: warmups + samples, v1_candidate_decisions: 1, opponent_decisions: 1, ticks: 1, frames: 1 },
          now,
        })
      : null;
    const call = () => timedCall({
      pathId: entry.path, model, engine, actor: entry.actor, controller, tick: state.tick,
      hook: collectors?.phaseHook ?? null, now,
    });
    const warmupMs = [];
    let kind = null;
    for (let index = 0; index < warmups; index += 1) {
      const result = call();
      warmupMs.push(round(result.durations[2]));
      if (index === 0) {
        if (!reference || decisionKey(result.decision) !== JSON.stringify(reference)) {
          mismatches.push({ ...entry, reference: reference ?? null, actual: JSON.parse(decisionKey(result.decision)) });
        }
        kind = result.kind;
        const firstKey = `${entry.path}|${entry.model}`;
        if (!firstSeen.has(firstKey)) {
          firstSeen.add(firstKey);
          firstCalls.push({ ...entry, ms: warmupMs[0] });
        }
      }
    }
    if (mismatches.length > 0) {
      break;
    }
    const enumerate = [];
    const decide = [];
    const total = [];
    for (let index = 0; index < samples; index += 1) {
      const { durations } = call();
      enumerate.push(round(durations[0]));
      decide.push(round(durations[1]));
      total.push(round(durations[2]));
    }
    combinations.push({
      ...entry,
      categories: state.categories?.[entry.actor] ?? [],
      decision_kind: kind,
      warmup_ms: warmupMs,
      samples: { enumerate_ms: enumerate, decide_ms: decide, total_ms: total },
      observer_refused: collectors ? collectors.refused().candidate_decisions : null,
    });
    if (engine.getStateHash() !== state.state_hash) {
      throw new Error(`the ${entry.path} path mutated bank state ${state.id}`);
    }
  }
  const elapsedMs = now() - started;
  const traced = trace ? await trace.stop() : null;
  return {
    schema_version: COMPLETE_PATH_SCHEMA,
    gc: gc ?? "untraced_primary",
    paths: Object.fromEntries(paths.map((pathId) => [pathId, COMPLETE_PATHS[pathId]])),
    boundaries: COMPLETE_PATH_BOUNDARIES,
    order: "state-major; per state: paths in order, then model, controller, actor",
    warmups,
    samples,
    planned: plan.length,
    completed: combinations.length,
    truncated,
    plan_sha256: sha256Hex(JSON.stringify(plan.map(combinationIdentity))),
    coverage_sha256: sha256Hex(JSON.stringify(combinations.map(combinationIdentity))),
    window_ms: windowMs,
    rebuild_ms: round(rebuildMs),
    elapsed_ms: round(elapsedMs),
    mismatches,
    first_calls: firstCalls,
    gc_trace: traced
      ? {
          scope: GC_TRACE_SCOPE,
          gc_entries: summarizeGcEntries(traced.entries),
          gc_entries_refused: traced.refused,
          heap_sampling: { interval_bytes: heapSamplingInterval, ...summarizeHeapProfile(traced.profile) },
        }
      : null,
    combinations,
    summary: summarizeCompletePath(combinations),
  };
}

// Nearest-rank summaries of total_ms by combination, path, model/controller/
// actor, state category and decision kind. Warmups are summarized apart.
export function summarizeCompletePath(combinations) {
  const groups = new Map();
  const add = (key, values) => {
    const list = groups.get(key) ?? [];
    list.push(...values);
    groups.set(key, list);
  };
  for (const entry of combinations) {
    const base = `${entry.path}`;
    add(`path|${base}`, entry.samples.total_ms);
    add(`model|${base}|${entry.model}|${entry.controller}|${entry.actor}`, entry.samples.total_ms);
    add(`kind|${base}|${entry.decision_kind}`, entry.samples.total_ms);
    for (const category of entry.categories) {
      add(`category|${base}|${category}|${entry.actor}`, entry.samples.total_ms);
    }
    add(`first_warmup|${base}`, entry.warmup_ms.slice(0, 1));
    add(`later_warmups|${base}`, entry.warmup_ms.slice(1));
  }
  return {
    groups: Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, summarizeSamples(values)])),
    per_combination: combinations.map((entry) => ({
      state: entry.state, path: entry.path, model: entry.model, controller: entry.controller, actor: entry.actor,
      total_ms: summarizeSamples(entry.samples.total_ms),
    })),
  };
}

// Why a complete-path result does not cover its whole plan: a missing result,
// reference mismatches, a spent window or any planned combination not
// completed. Empty means complete. Partial output stays on disk as an
// incomplete condition.
export function completePathCoverageProblems(result) {
  if (!result) {
    return ["no result"];
  }
  const problems = [];
  if (result.mismatches.length > 0) {
    problems.push("reference_mismatch");
  }
  if (result.truncated !== false) {
    problems.push("truncated");
  }
  if (!(result.planned > 0) || result.completed !== result.planned || result.coverage_sha256 !== result.plan_sha256) {
    problems.push("coverage");
  }
  return problems;
}

// The stage's pinned inputs for complete-path runs.
export function loadStageInputs(stageDir) {
  const config = readJson(path.join(stageDir, "config.json"));
  const bankBytes = fs.readFileSync(path.join(stageDir, config.bank.path));
  if (sha256Hex(bankBytes) !== config.bank.sha256) {
    throw new Error("staged bank does not match its pin");
  }
  const expectationsBytes = fs.readFileSync(path.join(stageDir, config.expectations.path));
  if (sha256Hex(expectationsBytes) !== config.expectations.sha256) {
    throw new Error("staged expectations do not match their pin");
  }
  const expectations = JSON.parse(expectationsBytes.toString("utf8"));
  const expected = new Map(expectations.bank_decisions.map((entry) =>
    [`${entry.state}|${entry.actor}|${entry.model}|${entry.controller}`, entry.decision]));
  return { config, bank: JSON.parse(bankBytes.toString("utf8")), expected };
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

function integer(args, key, fallback) {
  const value = Number(args[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }
  return value;
}

function processRecord(cpuStart, wallStart) {
  const cpu = process.cpuUsage(cpuStart);
  return {
    pid: process.pid,
    node: process.version,
    exec_argv: process.execArgv,
    cpu_s: Math.round((cpu.user + cpu.system) / 1e4) / 100,
    wall_ms: round(performance.now() - wallStart),
  };
}

function writeResult(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function existingMethodCommand(args) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const model = loadPinnedModel(required(args, "model"), required(args, "sha256"));
  // Imported here: only this path uses the promotion evaluator, unchanged.
  const { evaluateTiming } = await import("./edger-evaluation-core.mjs");
  const options = {
    samples: integer(args, "samples", 100),
    warmupSamples: integer(args, "warmups", 10),
    budgetMs: Number(args["budget-ms"] ?? 5),
  };
  const timing = evaluateTiming(model, options);
  writeResult(required(args, "out"), {
    schema_version: EXISTING_METHOD_SCHEMA,
    method: "scripts/edger-evaluation-core.mjs evaluateTiming, unchanged: five scenario fixtures, legal " +
      "actions pre-enumerated, production selector via selectEdgerAction; reports only p95/max",
    model: { path: args.model, sha256: args.sha256 },
    options,
    timing,
    process: processRecord(cpuStart, wallStart),
  });
}

async function completePathCommand(args) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const stage = path.resolve(args.stage ?? ".");
  const { config, bank, expected } = loadStageInputs(stage);
  const runs = String(args.runs ?? Object.keys(config.models).join(",")).split(",");
  const paths = String(args.paths ?? "diagnostic,production,observed").split(",");
  const modelsByPath = loadPathModels({ stageDir: stage, config, runs, paths });
  const gc = args.gc === undefined ? null : args.gc;
  if (gc !== null && gc !== "traced" && gc !== "untraced") {
    throw new Error("--gc must be traced or untraced");
  }
  const result = await measureCompletePath({
    bank,
    modelsByPath,
    expected,
    runs,
    controllers: String(args.controllers ?? CONTROLLERS.join(",")).split(","),
    paths,
    states: args.states === undefined ? null : integer(args, "states", 0),
    warmups: integer(args, "warmups", 10),
    samples: integer(args, "samples", 100),
    gc,
    windowMs: args["window-s"] === undefined ? null : Number(args["window-s"]) * 1000,
  });
  writeResult(required(args, "out"), { ...result, process: processRecord(cpuStart, wallStart) });
  if (result.mismatches.length > 0) {
    process.exitCode = 1;
  }
}

const COMMANDS = { "existing-method": existingMethodCommand, "complete-path": completePathCommand };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command) {
    console.error(`usage: edger-v2-runtime-cost-measure.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
    process.exit(2);
  }
  command(args).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
