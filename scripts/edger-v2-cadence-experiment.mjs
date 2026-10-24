#!/usr/bin/env node
// Diagnostic-only driver for the v2 decision-cadence experiment. It evaluates
// and trains local shadow copies of a v2 parent under the learned delay and a
// fixed one-tick cadence. It never touches live v1, promotion reports or
// production campaign storage; every output goes under --work-dir/--out.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { createRng } from "../src/sim/random.js";
import {
  EDGER_V2_CADENCES,
  deriveLabelledSeeds,
  lcgSeedPrefix,
} from "./edger-v2-cadence-core.mjs";
import { spawnNativePython } from "./python-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_SCRIPT = path.join(ROOT, "scripts", "edger-v2-cadence-experiment.py");

export const CADENCE_SEED_LABELS = Object.freeze({
  development: "edger-cadence-dev-20260926",
  training: "edger-cadence-train-20260926",
  probe: "edger-cadence-probe-20260926",
});

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const values = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        values.push(argv[++index]);
      }
      args[key] = values.length === 0 ? true : values.length === 1 ? values[0] : values;
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

function asList(value) {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 1)}\n`);
}

// ---------------------------------------------------------------------------
// Seeds

export function frozenSuiteSeeds() {
  const excluded = new Set();
  for (const base of [20260718, 20260630, 1337]) {
    for (const seed of lcgSeedPrefix(base, 20_000)) {
      excluded.add(seed);
    }
  }
  for (const seed of [20260718, 20260719, 20260720, 606]) {
    excluded.add(seed);
  }
  for (let seed = 6201; seed <= 6305; seed += 1) {
    excluded.add(seed);
  }
  return excluded;
}

// Production league allocation (scripts/edger-league.mjs selectOpponent) with
// no historical or contender snapshots: champion below 0.4, heuristic in
// [0.4, 0.6), and both snapshot buckets fall back to the champion.
export function trainingOpponentSchedule({ pairs, seed = 20260927 }) {
  const rng = createRng(seed);
  const schedule = [];
  for (let index = 0; index < pairs; index += 1) {
    const allocation = rng();
    schedule.push(allocation >= 0.4 && allocation < 0.6 ? "edger_heuristic" : "edger");
  }
  return schedule;
}

export function buildCadenceSeedPlan({ development = 200, probe = 8, training = 192 } = {}) {
  const frozen = frozenSuiteSeeds();
  const developmentSeeds = deriveLabelledSeeds({
    label: CADENCE_SEED_LABELS.development, count: development, exclude: frozen,
  });
  const probeExclude = new Set([...frozen, ...developmentSeeds]);
  const probeSeeds = deriveLabelledSeeds({
    label: CADENCE_SEED_LABELS.probe, count: probe, exclude: probeExclude,
  });
  const trainingExclude = new Set([...probeExclude, ...probeSeeds]);
  const trainingSeeds = deriveLabelledSeeds({
    label: CADENCE_SEED_LABELS.training, count: training, exclude: trainingExclude,
  });
  const all = [...developmentSeeds, ...probeSeeds, ...trainingSeeds];
  if (new Set(all).size !== all.length || all.some((seed) => frozen.has(seed))) {
    throw new Error("cadence seed sets are not disjoint from each other and the frozen suites");
  }
  return {
    schema_version: "edger_v2_cadence_seed_plan_v1",
    labels: CADENCE_SEED_LABELS,
    frozen_exclusion_count: frozen.size,
    development: developmentSeeds,
    probe: probeSeeds,
    training: trainingSeeds,
    training_opponents: trainingOpponentSchedule({ pairs: trainingSeeds.length }),
  };
}

export const CADENCE_REPLICATION_LABELS = Object.freeze({
  trainingPrefix: "edger-cadence-train-20260927",
  confirmation: "edger-cadence-confirm-20260927",
});

// Independent training replications of the cadence arms. Each replicate gets
// new training seeds (engine, sampler and opponent RNGs all derive from them)
// and its own opponent schedule, while development and probe seeds stay those
// of the base plan so every evaluation remains paired with earlier results.
// Confirmation seeds are reserved, never used for training or development.
export function buildReplicationSeedPlans(basePlan, { replicates = ["r1", "r2"], training = 192, confirmation = 200 } = {}) {
  const regenerated = buildCadenceSeedPlan({
    development: basePlan.development.length,
    probe: basePlan.probe.length,
    training: basePlan.training.length,
  });
  for (const key of ["development", "probe", "training", "training_opponents"]) {
    if (JSON.stringify(regenerated[key]) !== JSON.stringify(basePlan[key])) {
      throw new Error(`base seed plan ${key} does not match its labelled derivation`);
    }
  }
  const exclude = new Set([
    ...frozenSuiteSeeds(), ...basePlan.development, ...basePlan.probe, ...basePlan.training,
  ]);
  const confirmationSeeds = deriveLabelledSeeds({
    label: CADENCE_REPLICATION_LABELS.confirmation, count: confirmation, exclude,
  });
  confirmationSeeds.forEach((seed) => exclude.add(seed));
  const plans = {};
  replicates.forEach((replicate, index) => {
    const label = `${CADENCE_REPLICATION_LABELS.trainingPrefix}-${replicate}`;
    const seeds = deriveLabelledSeeds({ label, count: training, exclude });
    seeds.forEach((seed) => exclude.add(seed));
    const opponentScheduleSeed = 20260927 + 1000 * (index + 1);
    plans[replicate] = {
      schema_version: "edger_v2_cadence_seed_plan_v1",
      replicate,
      labels: { ...basePlan.labels, training: label },
      frozen_exclusion_count: basePlan.frozen_exclusion_count,
      development: basePlan.development,
      probe: basePlan.probe,
      training: seeds,
      opponent_schedule_seed: opponentScheduleSeed,
      training_opponents: trainingOpponentSchedule({ pairs: seeds.length, seed: opponentScheduleSeed }),
    };
  });
  return {
    schema_version: "edger_v2_cadence_replication_seed_plan_v1",
    labels: CADENCE_REPLICATION_LABELS,
    base_training_seeds: basePlan.training.length,
    confirmation: confirmationSeeds,
    confirmation_note: "reserved; not used for training, development or model selection in this experiment",
    replicates: plans,
  };
}

// Evaluation seed sets and the plan schema that carries each: development
// seeds live in base and per-run plans, reserved confirmation seeds only in
// the replication plan.
export const CADENCE_EVALUATION_SEED_SETS = Object.freeze({
  development: "edger_v2_cadence_seed_plan_v1",
  confirmation: "edger_v2_cadence_replication_seed_plan_v1",
});

// Every seed array in a plan, keyed by its path (nested replicate plans
// included). Opponent schedules are strings, not seeds.
export function collectPlanSeedSets(plan, prefix = "") {
  const sets = {};
  for (const [key, value] of Object.entries(plan ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(Number.isInteger)) {
        sets[name] = value;
      }
    } else if (value && typeof value === "object") {
      Object.assign(sets, collectPlanSeedSets(value, name));
    }
  }
  return sets;
}

// The evaluation set is always named, so passing the replication plan for
// development or a per-run plan for confirmation fails instead of silently
// replaying development seeds. The whole named set must be duplicate-free and
// disjoint from the frozen suites, every other seed set in the plan and every
// plan in `excludePlans` (e.g. the base plan whose training seeds made r0).
export function selectEvaluationSeeds(plan, { set, pairs, excludePlans = [] }) {
  const schema = CADENCE_EVALUATION_SEED_SETS[set];
  if (!schema) {
    throw new Error(`seed set must be one of ${Object.keys(CADENCE_EVALUATION_SEED_SETS).join(", ")}; got ${set}`);
  }
  if (plan?.schema_version !== schema) {
    throw new Error(`${set} seeds come from a ${schema} plan; got ${plan?.schema_version ?? "an unversioned plan"}`);
  }
  const available = plan[set];
  if (!Array.isArray(available) || available.length === 0) {
    throw new Error(`seed plan has no ${set} seed set`);
  }
  if (!Number.isInteger(pairs) || pairs < 1) {
    throw new Error(`pairs must be a positive integer; got ${pairs}`);
  }
  if (pairs > available.length) {
    throw new Error(`requested ${pairs} ${set} pairs but the plan holds ${available.length}`);
  }
  const chosen = new Set(available);
  if (chosen.size !== available.length || !available.every(Number.isInteger)) {
    throw new Error(`${set} seed set must hold distinct integer seeds`);
  }
  const frozen = frozenSuiteSeeds();
  const frozenSeed = available.find((seed) => frozen.has(seed));
  if (frozenSeed !== undefined) {
    throw new Error(`${set} seed ${frozenSeed} belongs to a frozen evaluation suite`);
  }
  const others = [
    ...Object.entries(collectPlanSeedSets(plan)).filter(([name]) => name !== set),
    ...excludePlans.flatMap((other, index) => Object.entries(collectPlanSeedSets(other))
      .map(([name, seeds]) => [`excluded plan ${index} ${name}`, seeds])),
  ];
  for (const [name, seeds] of others) {
    const shared = seeds.find((seed) => chosen.has(seed));
    if (shared !== undefined) {
      throw new Error(`${set} seed ${shared} also appears in ${name}`);
    }
  }
  return available.slice(0, pairs);
}

// ---------------------------------------------------------------------------
// Worker pool with dynamic scheduling

export async function runCadenceSpecs(specs, { workers = Math.max(1, os.cpus().length - 1), onResult } = {}) {
  const queue = [...specs];
  const results = [];
  const poolSize = Math.min(workers, specs.length);
  await Promise.all(Array.from({ length: poolSize }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./edger-v2-cadence-worker.mjs", import.meta.url));
    const next = () => {
      const spec = queue.shift();
      if (!spec) {
        worker.postMessage({ type: "stop" });
        return;
      }
      worker.postMessage({ type: "run", spec });
    };
    worker.on("message", (message) => {
      if (!message.ok) {
        worker.terminate();
        reject(new Error(`cadence spec ${message.spec_id} failed: ${message.error}`));
        return;
      }
      results.push(message.result);
      onResult?.(message.result, results.length, specs.length);
      next();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    next();
  })));
  return results.sort((left, right) => left.spec_id - right.spec_id);
}

function pairedSpecs({ seeds, kind, modelPath, cadence, opponentFor, extra = () => ({}) }) {
  const specs = [];
  seeds.forEach((seed, pairIndex) => {
    for (const candidateActor of ["blue", "red"]) {
      specs.push({
        spec_id: specs.length,
        match_index: specs.length,
        pair_id: `pair-${pairIndex}`,
        kind,
        seed,
        candidate_actor: candidateActor,
        model_path: path.resolve(modelPath),
        cadence,
        opponent: opponentFor(pairIndex),
        ...extra(pairIndex, candidateActor, specs.length),
      });
    }
  });
  return specs;
}

function progress(label) {
  let last = 0;
  return (_, done, total) => {
    const now = Date.now();
    if (done === total || now - last > 15_000) {
      last = now;
      console.error(`[${new Date().toISOString()}] ${label}: ${done}/${total}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Statistics

export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (trials === 0) {
    return [0, 1];
  }
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function pairScores(results) {
  const pairs = new Map();
  for (const result of results) {
    const list = pairs.get(result.pair_id) ?? [];
    list.push(result.candidate_point);
    pairs.set(result.pair_id, list);
  }
  return new Map([...pairs].map(([pairId, points]) => [
    pairId,
    points.reduce((sum, value) => sum + value, 0) / points.length,
  ]));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

export function bootstrapMeanInterval(values, { seed = 20260926, resamples = 10_000 } = {}) {
  if (values.length === 0) {
    return { mean: null, lower: null, upper: null, n: 0 };
  }
  const rng = createRng(seed);
  const means = new Float64Array(resamples);
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(rng() * values.length)];
    }
    means[sample] = total / values.length;
  }
  const sorted = Array.from(means).sort((left, right) => left - right);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    lower: percentile(sorted, 0.025),
    upper: percentile(sorted, 0.975),
    n: values.length,
  };
}

function logChoose(n, k) {
  let total = 0;
  for (let index = 1; index <= k; index += 1) {
    total += Math.log(n - k + index) - Math.log(index);
  }
  return total;
}

export function exactSignTest(positive, negative) {
  const n = positive + negative;
  if (n === 0) {
    return 1;
  }
  const k = Math.min(positive, negative);
  let tail = 0;
  for (let index = 0; index <= k; index += 1) {
    tail += Math.exp(logChoose(n, index) - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

export function pairedContrast(treatment, control, options = {}) {
  const treated = pairScores(treatment);
  const baseline = pairScores(control);
  const differences = [];
  for (const [pairId, score] of treated) {
    if (!baseline.has(pairId)) {
      throw new Error(`pair ${pairId} missing from the control condition`);
    }
    differences.push(score - baseline.get(pairId));
  }
  if (differences.length !== baseline.size) {
    throw new Error("paired contrast requires identical seed pairs");
  }
  const positive = differences.filter((value) => value > 0).length;
  const negative = differences.filter((value) => value < 0).length;
  return {
    ...bootstrapMeanInterval(differences, options),
    pairs_better: positive,
    pairs_worse: negative,
    pairs_tied: differences.length - positive - negative,
    sign_test_p: exactSignTest(positive, negative),
  };
}

function mergeHistogram(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

function histogramQuantiles(histogram) {
  const entries = Object.entries(histogram).map(([key, count]) => [Number(key), count]).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const at = (fraction) => {
    if (total === 0) {
      return null;
    }
    const target = fraction * (total - 1);
    let cumulative = 0;
    for (const [value, count] of entries) {
      cumulative += count;
      if (cumulative - 1 >= target) {
        return value;
      }
    }
    return entries.at(-1)[0];
  };
  const mean = total === 0 ? null : entries.reduce((sum, [value, count]) => sum + value * count, 0) / total;
  return { count: total, mean, p05: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), max: entries.at(-1)?.[0] ?? null };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeCondition(results, { bootstrapSeed = 20260926 } = {}) {
  const games = results.length;
  const wins = results.filter((result) => result.candidate_point === 1).length;
  const draws = results.filter((result) => result.candidate_point === 0.5).length;
  const score = mean(results.map((result) => result.candidate_point));
  const pairInterval = bootstrapMeanInterval([...pairScores(results).values()], { seed: bootstrapSeed });
  const sum = (key) => results.reduce((total, result) => total + result.stats[key], 0);
  const decisions = sum("decisions");
  const histograms = { chosen: {}, chosenAfterPlay: {}, realized: {}, deployment: {} };
  for (const result of results) {
    mergeHistogram(histograms.chosen, result.stats.chosen_delay_histogram);
    mergeHistogram(histograms.chosenAfterPlay, result.stats.chosen_delay_after_play_histogram);
    mergeHistogram(histograms.realized, result.stats.realized_interval_histogram);
    mergeHistogram(histograms.deployment, result.stats.deployment_interval_histogram);
  }
  const ticks = results.map((result) => result.tick).sort((a, b) => a - b);
  const byReason = {};
  for (const result of results) {
    byReason[result.reason] = (byReason[result.reason] ?? 0) + 1;
  }
  const deploymentsByCard = {};
  for (const result of results) {
    mergeHistogram(deploymentsByCard, result.stats.deployments_by_card);
  }
  return {
    games,
    paired_seeds: pairScores(results).size,
    wins,
    draws,
    losses: games - wins - draws,
    score,
    score_wilson_95: wilsonInterval(score * games, games),
    score_paired_bootstrap_95: [pairInterval.lower, pairInterval.upper],
    match_ticks: { mean: mean(ticks), p50: percentile(ticks, 0.5), p05: percentile(ticks, 0.05), p95: percentile(ticks, 0.95) },
    end_reasons: byReason,
    decisions_per_game: decisions / games,
    pass_fraction_of_decisions: sum("pass_decisions") / Math.max(1, decisions),
    play_attempts_per_game: sum("play_attempts") / games,
    successful_deployments_per_game: sum("successful_deployments") / games,
    rejected_attempts: sum("play_attempts") - sum("successful_deployments"),
    illegal_attempts: sum("illegal_attempts"),
    opponent_deployments_per_game: sum("opponent_deployments") / games,
    first_deployment_tick_mean: mean(results.map((result) => result.stats.first_deployment_tick).filter((value) => value !== null)),
    full_elixir_ticks_per_game: sum("full_elixir_ticks") / games,
    full_elixir_fraction_of_ticks: sum("full_elixir_ticks") / Math.max(1, results.reduce((total, result) => total + result.tick, 0)),
    chosen_delay_ticks: histogramQuantiles(histograms.chosen),
    chosen_delay_after_play_ticks: histogramQuantiles(histograms.chosenAfterPlay),
    realized_decision_interval_ticks: histogramQuantiles(histograms.realized),
    deployment_interval_ticks: histogramQuantiles(histograms.deployment),
    chosen_delay_histogram: histograms.chosen,
    deployments_by_card: deploymentsByCard,
    inference_ms_per_game: sum("inference_ms") / games,
    inference_ms_per_decision: sum("inference_ms") / Math.max(1, decisions),
    wall_seconds_per_game: mean(results.map((result) => result.wall_seconds)),
    wall_seconds_total: results.reduce((total, result) => total + result.wall_seconds, 0),
  };
}

// ---------------------------------------------------------------------------
// Commands

async function commandSeeds(args) {
  const plan = buildCadenceSeedPlan({
    development: Number(args.development ?? 200),
    probe: Number(args.probe ?? 8),
    training: Number(args.training ?? 192),
  });
  writeJson(required(args, "out"), plan);
  console.log(JSON.stringify({ out: path.resolve(args.out), sha256: sha256File(args.out) }));
}

async function commandReplicateSeeds(args) {
  const basePath = required(args, "base");
  const outDir = path.resolve(required(args, "out-dir"));
  const replication = buildReplicationSeedPlans(JSON.parse(fs.readFileSync(basePath, "utf8")), {
    replicates: asList(args.replicates ?? ["r1", "r2"]),
    training: Number(args.training ?? 192),
    confirmation: Number(args.confirmation ?? 200),
  });
  const files = {};
  for (const [replicate, plan] of Object.entries(replication.replicates)) {
    const file = path.join(outDir, `seed-plan-${replicate}.json`);
    writeJson(file, plan);
    files[replicate] = { path: file, sha256: sha256File(file) };
  }
  const master = path.join(outDir, "replication-seed-plan.json");
  writeJson(master, { ...replication, base_plan_sha256: sha256File(basePath), replicate_files: files });
  console.log(JSON.stringify({ master, sha256: sha256File(master), replicate_files: files }));
}

async function commandEvaluate(args) {
  const seedsFile = required(args, "seeds");
  const plan = JSON.parse(fs.readFileSync(seedsFile, "utf8"));
  const pairs = Number(required(args, "pairs"));
  const seedSet = required(args, "seed-set");
  const excludeFiles = asList(args["exclude-seed-plans"]);
  const seeds = selectEvaluationSeeds(plan, {
    set: seedSet,
    pairs,
    excludePlans: excludeFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8"))),
  });
  const cadence = required(args, "cadence");
  const opponent = required(args, "opponent");
  const modelPath = required(args, "model");
  const specs = pairedSpecs({ seeds, kind: "evaluate", modelPath, cadence, opponentFor: () => opponent });
  const started = Date.now();
  const results = await runCadenceSpecs(specs, {
    workers: Number(args.workers ?? 7),
    onResult: progress(`${args.label ?? "evaluate"} ${cadence} vs ${opponent}`),
  });
  // Deterministic choices: repeating a spec must reproduce its action stream.
  const repeats = await runCadenceSpecs(specs.slice(0, 2), { workers: 2 });
  const repeatFailures = repeats.filter((repeat) =>
    repeat.action_stream_hash !== results[repeat.spec_id].action_stream_hash ||
    repeat.final_state_hash !== results[repeat.spec_id].final_state_hash);
  if (repeatFailures.length > 0 || results.some((result) => result.stats.illegal_attempts > 0)) {
    throw new Error("cadence evaluation failed its repeatability or legality check");
  }
  writeJson(required(args, "out"), {
    schema_version: "edger_v2_cadence_evaluation_v1",
    label: args.label ?? null,
    model: path.resolve(modelPath),
    model_sha256: sha256File(modelPath),
    cadence,
    opponent,
    seeds_file_sha256: sha256File(seedsFile),
    seed_selection: {
      set: seedSet,
      plan_schema_version: plan.schema_version,
      excluded_seed_plans: excludeFiles.map((file) => ({ path: path.resolve(file), sha256: sha256File(file) })),
      seeds,
    },
    pairs,
    deterministic_choices: true,
    repeat_checked_specs: repeats.length,
    wall_seconds: (Date.now() - started) / 1000,
    summary: summarizeCondition(results),
    results,
  });
}

async function commandProbe(args) {
  const plan = JSON.parse(fs.readFileSync(required(args, "seeds"), "utf8"));
  const cadence = required(args, "cadence");
  const modelPath = required(args, "model");
  const specs = pairedSpecs({
    seeds: plan.probe,
    kind: "probe",
    modelPath,
    cadence,
    opponentFor: () => "edger",
    extra: () => ({ probe_stride: Number(args.stride ?? 1) }),
  });
  const results = await runCadenceSpecs(specs, { workers: Number(args.workers ?? 7), onResult: progress(`probe ${cadence}`) });
  writeJson(required(args, "out"), {
    schema_version: "edger_v2_cadence_probe_v1",
    model: path.resolve(modelPath),
    model_sha256: sha256File(modelPath),
    cadence,
    stride: Number(args.stride ?? 1),
    probes: results.flatMap((result) => result.probes),
    games: results.map(({ probes, ...rest }) => rest),
  });
}

export function collectionSpecs({ plan, iteration, pairsPerIteration, modelPath, modelSha256, cadence, outDir }) {
  const start = iteration * pairsPerIteration;
  const seeds = plan.training.slice(start, start + pairsPerIteration);
  if (seeds.length !== pairsPerIteration) {
    throw new Error(`seed plan has too few training pairs for iteration ${iteration}`);
  }
  return pairedSpecs({
    seeds,
    kind: "collect",
    modelPath,
    cadence,
    opponentFor: (pairIndex) => plan.training_opponents[start + pairIndex],
    extra: (pairIndex, actor) => ({
      episode_id: `it${iteration}-pair${start + pairIndex}-${actor}`,
      out_dir: outDir,
      model_sha256: modelSha256,
    }),
  });
}

async function collect({ plan, iteration, pairsPerIteration, modelPath, cadence, outDir, workers, out }) {
  const specs = collectionSpecs({
    plan, iteration, pairsPerIteration, modelPath, modelSha256: sha256File(modelPath), cadence, outDir,
  });
  const started = Date.now();
  const results = await runCadenceSpecs(specs, { workers, onResult: progress(`collect it${iteration} ${cadence}`) });
  const collection = {
    schema_version: "edger_v2_cadence_collection_v1",
    iteration,
    cadence,
    model: path.resolve(modelPath),
    model_sha256: sha256File(modelPath),
    sampling_temperature: 1,
    wall_seconds: (Date.now() - started) / 1000,
    rollout_worker_seconds: results.reduce((sum, result) => sum + result.wall_seconds, 0),
    environment_ticks: results.reduce((sum, result) => sum + result.tick, 0),
    rows: results.reduce((sum, result) => sum + result.rows, 0),
    play_rows: results.reduce((sum, result) => sum + result.play_rows, 0),
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    sampled_play_summary: summarizeCondition(results),
    episodes: results.map((result) => ({
      match_index: result.match_index,
      episode_id: path.basename(result.header, ".json"),
      header: result.header,
      seed: result.seed,
      candidate_actor: result.candidate_actor,
      opponent: result.opponent,
      rows: result.rows,
      play_rows: result.play_rows,
      tick: result.tick,
      candidate_point: result.candidate_point,
      successful_deployments: result.stats.successful_deployments,
    })),
  };
  writeJson(out, collection);
  return collection;
}

async function commandCollect(args) {
  const plan = JSON.parse(fs.readFileSync(required(args, "seeds"), "utf8"));
  await collect({
    plan,
    iteration: Number(required(args, "iteration")),
    pairsPerIteration: Number(args["pairs-per-iteration"] ?? 32),
    modelPath: required(args, "model"),
    cadence: required(args, "cadence"),
    outDir: required(args, "out-dir"),
    workers: Number(args.workers ?? 7),
    out: required(args, "out"),
  });
}

function python(argv, logPath) {
  const result = spawnNativePython([PYTHON_SCRIPT, ...argv], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (logPath) {
    fs.appendFileSync(logPath, `$ python ${argv.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`);
  }
  return result;
}

// Keep every episode header (it records the body SHA-256) and delete the
// bodies; sampled trajectories are reproducible from model, seed and side.
export function pruneEpisodeBodies(episodesDir, headersDir) {
  fs.mkdirSync(headersDir, { recursive: true });
  let headers = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(episodesDir)) {
    const source = path.join(episodesDir, name);
    if (name.endsWith(".json")) {
      fs.copyFileSync(source, path.join(headersDir, name));
      headers += 1;
    } else if (name.endsWith(".bin")) {
      bytes += fs.statSync(source).size;
    }
  }
  fs.rmSync(episodesDir, { recursive: true, force: true });
  return { headers, body_bytes_deleted: bytes, headers_dir: headersDir };
}

async function commandTrainArm(args) {
  const arm = required(args, "arm");
  const cadence = required(args, "cadence");
  if (!Object.values(EDGER_V2_CADENCES).includes(cadence)) {
    throw new Error(`unknown cadence ${cadence}`);
  }
  const plan = JSON.parse(fs.readFileSync(required(args, "seeds"), "utf8"));
  const workDir = path.resolve(required(args, "work-dir"));
  const parentCheckpoint = path.resolve(required(args, "parent-checkpoint"));
  const parentModel = path.resolve(required(args, "parent-model"));
  const iterations = Number(args.iterations ?? 6);
  const pairsPerIteration = Number(args["pairs-per-iteration"] ?? 32);
  const workers = Number(args.workers ?? 7);
  const learningRate = String(args["learning-rate"] ?? "0.001");
  const probes = asList(args.probes).map((value) => path.resolve(value));
  const heldout = args.heldout ? path.resolve(args.heldout) : null;
  const budgetMinutes = Number(args["budget-minutes"] ?? 150);
  const lossMode = String(args["loss-mode"] ?? "full");
  const decomposeEvery = String(args["decompose-every"] ?? "0");
  const torchSeed = String(args["torch-seed"] ?? "20260926");
  // Episodes may live outside the work directory (e.g. off a synced or nearly
  // full volume); pruning deletes bodies after a successful update and keeps
  // the headers, whose body checksums pin what the learner consumed.
  const episodesRoot = args["episodes-root"] ? path.resolve(args["episodes-root"]) : null;
  const pruneEpisodes = args["prune-episodes"] === true;
  const logPath = path.join(workDir, "train-arm.log");
  fs.mkdirSync(workDir, { recursive: true });
  const statusPath = path.join(workDir, "arm-status.json");
  const status = {
    schema_version: "edger_v2_cadence_arm_status_v1",
    arm,
    cadence,
    loss_mode: lossMode,
    decompose_every: Number(decomposeEvery),
    torch_seed: Number(torchSeed),
    seeds_file: path.resolve(args.seeds),
    seeds_file_sha256: sha256File(args.seeds),
    episodes_root: episodesRoot,
    prune_episodes: pruneEpisodes,
    learning_rate: Number(learningRate),
    parent_checkpoint: parentCheckpoint,
    parent_checkpoint_sha256: sha256File(parentCheckpoint),
    parent_model: parentModel,
    parent_model_sha256: sha256File(parentModel),
    iterations_planned: iterations,
    pairs_per_iteration: pairsPerIteration,
    started_at: new Date().toISOString(),
    iterations: [],
    stop_reason: null,
  };
  const armStarted = Date.now();
  let checkpoint = parentCheckpoint;
  let model = parentModel;
  const firstIteration = Number(args["start-iteration"] ?? 0);
  if (firstIteration > 0) {
    // Resume after an interrupted run from the last completed iteration.
    const previous = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const completed = previous.iterations.find((record) => record.iteration === firstIteration - 1);
    if (!completed?.checkpoint || sha256File(completed.checkpoint) !== completed.checkpoint_sha256) {
      throw new Error(`cannot resume: iteration ${firstIteration - 1} is not complete and verified`);
    }
    status.iterations = previous.iterations.filter((record) => record.iteration < firstIteration);
    status.resumed_at_iteration = firstIteration;
    checkpoint = completed.checkpoint;
    model = completed.model;
  }
  for (let iteration = firstIteration; iteration < iterations; iteration += 1) {
    const iterationDir = path.join(workDir, `iter${iteration}`);
    const episodesDir = episodesRoot
      ? path.join(episodesRoot, arm, `iter${iteration}`)
      : path.join(iterationDir, "episodes");
    const collection = await collect({
      plan,
      iteration,
      pairsPerIteration,
      modelPath: model,
      cadence,
      outDir: episodesDir,
      workers,
      out: path.join(iterationDir, "collection.json"),
    });
    const record = {
      iteration,
      input_model_sha256: sha256File(model),
      collection_wall_seconds: collection.wall_seconds,
      rollout_worker_seconds: collection.rollout_worker_seconds,
      environment_ticks: collection.environment_ticks,
      rows: collection.rows,
      play_rows: collection.play_rows,
      sampled_score: collection.sampled_play_summary.score,
      sampled_successful_deployments_per_game: collection.sampled_play_summary.successful_deployments_per_game,
    };
    const deployments = collection.episodes.reduce((sum, episode) => sum + episode.successful_deployments, 0);
    if (deployments === 0) {
      status.stop_reason = `collapse: zero successful deployments in iteration ${iteration}`;
      status.iterations.push(record);
      break;
    }
    const nextCheckpoint = path.join(iterationDir, "checkpoint.pt");
    const learnerStarted = Date.now();
    const train = python([
      "train-iteration",
      "--checkpoint", checkpoint,
      "--parent", parentCheckpoint,
      "--collection", path.join(iterationDir, "collection.json"),
      "--delay-mode", cadence,
      "--arm", arm,
      "--iteration", String(iteration),
      "--out", nextCheckpoint,
      "--metrics-out", path.join(iterationDir, "learner-metrics.json"),
      "--learning-rate", learningRate,
      "--loss-mode", lossMode,
      "--decompose-every", decomposeEvery,
      "--seed", torchSeed,
    ], logPath);
    record.learner_wall_seconds = (Date.now() - learnerStarted) / 1000;
    if (train.status !== 0) {
      status.stop_reason = `learner failed in iteration ${iteration}: ${(train.stderr ?? "").split("\n").filter(Boolean).at(-1)}`;
      status.iterations.push(record);
      break;
    }
    if (pruneEpisodes) {
      record.episodes_pruned = pruneEpisodeBodies(episodesDir, path.join(iterationDir, "episode-headers"));
    }
    const nextModel = path.join(iterationDir, "model.json");
    const exported = python([
      "export", "--checkpoint", nextCheckpoint, "--out", nextModel,
      "--model-id", `edger_v2_cadence_diagnostic_${arm}_iter${iteration}`,
    ], logPath);
    if (exported.status !== 0) {
      throw new Error(`export failed: ${exported.stderr}`);
    }
    if (probes.length > 0) {
      const probe = python([
        "probe", "--checkpoint", nextCheckpoint, "--parent", parentCheckpoint,
        "--probes", ...probes, "--out", path.join(iterationDir, "probe-drift.json"),
      ], logPath);
      if (probe.status !== 0) {
        throw new Error(`probe failed: ${probe.stderr}`);
      }
    }
    if (heldout) {
      const held = python([
        "heldout", "--checkpoint", nextCheckpoint, "--parent", parentCheckpoint,
        "--dataset", heldout, "--out", path.join(iterationDir, "heldout.json"),
      ], logPath);
      if (held.status !== 0) {
        throw new Error(`held-out evaluation failed: ${held.stderr}`);
      }
    }
    record.checkpoint = nextCheckpoint;
    record.checkpoint_sha256 = sha256File(nextCheckpoint);
    record.model = nextModel;
    record.model_sha256 = sha256File(nextModel);
    record.iteration_wall_seconds = (Date.now() - armStarted) / 1000;
    status.iterations.push(record);
    writeJson(statusPath, status);
    checkpoint = nextCheckpoint;
    model = nextModel;
    if (iteration === firstIteration) {
      const projectedMinutes = ((Date.now() - armStarted) / 60_000) * (iterations - firstIteration);
      status.projected_minutes_after_first_iteration = projectedMinutes;
      if (projectedMinutes > budgetMinutes) {
        status.stop_reason = `budget: projected ${projectedMinutes.toFixed(1)} minutes exceeds ${budgetMinutes}`;
        break;
      }
    }
  }
  status.finished_at = new Date().toISOString();
  status.wall_seconds = (Date.now() - armStarted) / 1000;
  status.final_checkpoint = checkpoint;
  status.final_model = model;
  status.stop_reason ??= "completed";
  writeJson(statusPath, status);
  console.log(JSON.stringify({ arm, stop_reason: status.stop_reason, final_model: model }));
}

async function commandSummarize(args) {
  const inputs = Object.fromEntries(asList(required(args, "condition")).map((entry) => {
    const [label, filePath] = entry.split("=");
    return [label, JSON.parse(fs.readFileSync(filePath, "utf8"))];
  }));
  const contrasts = {};
  for (const entry of asList(args.contrast)) {
    const [name, pair] = entry.split("=");
    const [treatment, control] = pair.split(",");
    contrasts[name] = {
      treatment,
      control,
      ...pairedContrast(inputs[treatment].results, inputs[control].results),
    };
  }
  writeJson(required(args, "out"), {
    schema_version: "edger_v2_cadence_summary_v1",
    conditions: Object.fromEntries(Object.entries(inputs).map(([label, input]) => [label, {
      model: input.model,
      model_sha256: input.model_sha256,
      cadence: input.cadence,
      opponent: input.opponent,
      ...input.summary,
    }])),
    contrasts,
  });
}

const COMMANDS = {
  seeds: commandSeeds,
  "replicate-seeds": commandReplicateSeeds,
  evaluate: commandEvaluate,
  probe: commandProbe,
  collect: commandCollect,
  "train-arm": commandTrainArm,
  summarize: commandSummarize,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command) {
    console.error(`usage: edger-v2-cadence-experiment.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
    process.exit(2);
  }
  command(args).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
