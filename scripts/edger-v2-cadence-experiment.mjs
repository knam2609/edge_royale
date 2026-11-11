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

import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import {
  buildDatasetManifest,
  createTrainingEpisode,
  deriveDecisionSequence,
  splitForEpisodeId,
  storeTrainingEpisode,
  writeDatasetManifest,
} from "./edger-corpus-core.mjs";
import {
  EDGER_V2_CADENCES,
  EDGER_V2_CADENCE_REWARD_VERSION,
  EDGER_V2_POLICY_DIAGNOSTICS_SCHEMA,
  deriveLabelledSeeds,
  encodeCadenceEpisode,
  lcgSeedPrefix,
  runEdgerV2CadenceMatch,
} from "./edger-v2-cadence-core.mjs";
import { assertRewardVersion } from "./edger-reward-core.mjs";
import {
  EDGER_V2_PLAYSTYLE_DIAGNOSTICS_SCHEMA,
  PLAYSTYLE_CHECKPOINT_TICKS,
  PLAYSTYLE_RESPONSE_CLASSES,
  PLAYSTYLE_RESPONSE_WINDOW_TICKS,
  emptyResponseCounts,
} from "./edger-playstyle-core.mjs";
import { TICK_RATE } from "../src/sim/config.js";
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

// Pool the per-game policy diagnostics (definitions in edger-v2-cadence-core.mjs).
// Every decision of every game counts once; per-game means give the spread
// across games. Descriptive only: no threshold reads these values.
export function summarizePolicyDiagnostics(results) {
  if (results.some((result) => !result.stats?.policy_diagnostics)) {
    throw new Error("results have no policy diagnostics; re-evaluate the model with this code");
  }
  const perGame = results.map((result) => result.stats.policy_diagnostics);
  const total = (key) => perGame.reduce((sum, game) => sum + game[key], 0);
  const spread = (sumKey, countKey) => {
    const means = perGame
      .filter((game) => game[countKey] > 0)
      .map((game) => game[sumKey] / game[countKey])
      .sort((a, b) => a - b);
    return { games: means.length, p05: percentile(means, 0.05), p50: percentile(means, 0.5), p95: percentile(means, 0.95) };
  };
  const maximum = (head) => perGame.reduce((best, game) => {
    const value = game.max_abs_legal_logit[head];
    return value === null ? best : best === null ? value : Math.max(best, value);
  }, null);
  const decisions = total("decisions");
  const choice = total("choice_decisions");
  const delayDecisions = total("delay_entropy_decisions");
  const chosenDelay = histogramQuantiles(results.reduce(
    (histogram, result) => mergeHistogram(histogram, result.stats.chosen_delay_histogram),
    {},
  ));
  const heads = { card: maximum("card"), placement: maximum("placement"), delay: maximum("delay") };
  const present = Object.values(heads).filter((value) => value !== null);
  return {
    schema_version: EDGER_V2_POLICY_DIAGNOSTICS_SCHEMA,
    entropy_units: "nats",
    games: results.length,
    decisions,
    decisions_per_game: results.length === 0 ? null : decisions / results.length,
    choice_decisions: choice,
    forced_pass_decisions: decisions - choice,
    pass_fraction_of_decisions: decisions === 0 ? null : total("pass_decisions") / decisions,
    pass_fraction_of_choice_decisions: choice === 0 ? null : total("pass_choice_decisions") / choice,
    card_entropy_given_choice: choice === 0
      ? null
      : { mean: total("card_entropy_sum_given_choice") / choice, per_game_mean: spread("card_entropy_sum_given_choice", "choice_decisions") },
    delay_entropy: delayDecisions === 0
      ? null
      : { mean: total("delay_entropy_sum") / delayDecisions, per_game_mean: spread("delay_entropy_sum", "delay_entropy_decisions") },
    chosen_delay_ticks_mean: chosenDelay.mean,
    minimum_delay_fraction: decisions === 0 ? null : total("minimum_delay_decisions") / decisions,
    max_abs_legal_logit: { ...heads, any_head: present.length === 0 ? null : Math.max(...present) },
  };
}

function spreadOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: mean(sorted), p05: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function responseShares(counts) {
  return {
    threats: counts.threats,
    shares: Object.fromEntries(PLAYSTYLE_RESPONSE_CLASSES.map((kind) => [
      kind,
      counts.threats === 0 ? null : counts[kind] / counts.threats,
    ])),
  };
}

function addResponseCounts(target, source) {
  for (const key of ["threats", ...PLAYSTYLE_RESPONSE_CLASSES]) {
    target[key] += source[key];
  }
  return target;
}

// Pool the per-game playstyle diagnostics (definitions in
// edger-playstyle-core.mjs). Counts are pooled over every game; per-game
// values give the spread across games. Descriptive only: no threshold reads
// these values.
export function summarizePlaystyleDiagnostics(results) {
  if (results.some((result) => !result.stats?.playstyle_diagnostics)) {
    throw new Error("results have no playstyle diagnostics; re-evaluate the model with this code");
  }
  const perGame = results.map((result) => result.stats.playstyle_diagnostics);
  const minutes = results.reduce((total, result) => total + result.tick, 0) / (60 * TICK_RATE);
  const wasted = perGame.map((game) => game.wasted_elixir);
  const totalWasted = wasted.reduce((total, value) => total + value, 0);

  const responses = { ...emptyResponseCounts(), censored: 0, counter_delay_ticks_sum: 0 };
  const inHand = emptyResponseCounts();
  const byCard = {};
  for (const game of perGame) {
    const counts = game.counter_responses;
    addResponseCounts(responses, counts);
    responses.censored += counts.censored;
    responses.counter_delay_ticks_sum += counts.counter_delay_ticks_sum;
    addResponseCounts(inHand, counts.strong_counter_in_hand);
    for (const [card, cardCounts] of Object.entries(counts.by_threat_card)) {
      byCard[card] ??= emptyResponseCounts();
      addResponseCounts(byCard[card], cardCounts);
    }
  }
  const counterResponses = responses.strong + responses.partial;

  const giant = { plays: 0, into_affordable_strong_answer: 0, into_affordable_answer: 0, opponent_counter_credit_sum: 0 };
  for (const game of perGame) {
    for (const key of Object.keys(giant)) {
      giant[key] += game.giant_plays[key];
    }
  }

  const checkpoints = Object.fromEntries(Object.entries(PLAYSTYLE_CHECKPOINT_TICKS).map(([label, tick]) => {
    const reached = perGame.map((game) => game.checkpoints[label]).filter((parts) => parts !== null);
    return [label, {
      tick,
      games: reached.length,
      terms: reached.length === 0
        ? null
        : Object.fromEntries(["v1", "material", "threat", "readiness", "support", "position"].map((term) => [
            term,
            spreadOf(reached.map((parts) => parts[term])),
          ])),
    }];
  }));

  return {
    schema_version: EDGER_V2_PLAYSTYLE_DIAGNOSTICS_SCHEMA,
    games: results.length,
    wasted_elixir: {
      per_game: results.length === 0 ? null : spreadOf(wasted),
      per_minute: minutes === 0 ? null : totalWasted / minutes,
    },
    counter_responses: {
      window_ticks: PLAYSTYLE_RESPONSE_WINDOW_TICKS,
      ...responseShares(responses),
      censored: responses.censored,
      counter_response_delay_ticks_mean: counterResponses === 0 ? null : responses.counter_delay_ticks_sum / counterResponses,
      given_strong_counter_in_hand: responseShares(inHand),
      by_threat_card: Object.fromEntries(Object.keys(byCard).sort().map((card) => [card, responseShares(byCard[card])])),
    },
    giant_plays: {
      plays: giant.plays,
      plays_per_game: results.length === 0 ? null : giant.plays / results.length,
      into_affordable_strong_answer_fraction: giant.plays === 0 ? null : giant.into_affordable_strong_answer / giant.plays,
      into_affordable_answer_fraction: giant.plays === 0 ? null : giant.into_affordable_answer / giant.plays,
      opponent_counter_credit_mean: giant.plays === 0 ? null : giant.opponent_counter_credit_sum / giant.plays,
    },
    checkpoints,
  };
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
    policy_diagnostics: summarizePolicyDiagnostics(results),
    playstyle_diagnostics: summarizePlaystyleDiagnostics(results),
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

// One model's routine diagnostics over its evaluation files (one per
// opponent): pooled over every game once, and per opponent.
export function policyDiagnosticsReport(evaluations, { label = null } = {}) {
  if (evaluations.length === 0) {
    throw new Error("--evaluations needs at least one evaluation file");
  }
  const [first] = evaluations.map(({ report }) => report);
  const opponents = new Set();
  for (const { file, report } of evaluations) {
    if (report.schema_version !== "edger_v2_cadence_evaluation_v1" || report.deterministic_choices !== true) {
      throw new Error(`${file} is not a deterministic cadence evaluation`);
    }
    if (report.model_sha256 !== first.model_sha256 || report.cadence !== first.cadence) {
      throw new Error(`${file} evaluates a different model or cadence`);
    }
    if (opponents.has(report.opponent)) {
      throw new Error(`${file} repeats opponent ${report.opponent}`);
    }
    opponents.add(report.opponent);
  }
  return {
    schema_version: "edger_v2_policy_diagnostics_report_v1",
    label,
    model: first.model,
    model_sha256: first.model_sha256,
    cadence: first.cadence,
    population: "every candidate decision in the listed evaluation games, each counted once",
    inputs: evaluations.map(({ file, sha256, report }) => ({
      path: file,
      sha256,
      opponent: report.opponent,
      seed_set: report.seed_selection?.set ?? null,
      pairs: report.pairs,
      games: report.results.length,
    })),
    pooled: summarizePolicyDiagnostics(evaluations.flatMap(({ report }) => report.results)),
    by_opponent: Object.fromEntries(evaluations.map(({ report }) => [
      report.opponent,
      summarizePolicyDiagnostics(report.results),
    ])),
    playstyle: playstyleReport(evaluations),
  };
}

// Playstyle diagnostics came after the policy diagnostics. Evaluations that
// predate them still pool their policy diagnostics, with playstyle null; a
// mixture of older and newer files is refused.
function playstyleReport(evaluations) {
  const hasPlaystyle = evaluations.map(({ report }) =>
    report.results.length > 0 && report.results.every((result) => result.stats?.playstyle_diagnostics));
  if (hasPlaystyle.every((value) => !value)) {
    return null;
  }
  const missing = evaluations.filter((_, index) => !hasPlaystyle[index]).map(({ file }) => file);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} predate the playstyle diagnostics; re-evaluate every opponent with this code`);
  }
  return {
    pooled: summarizePlaystyleDiagnostics(evaluations.flatMap(({ report }) => report.results)),
    by_opponent: Object.fromEntries(evaluations.map(({ report }) => [
      report.opponent,
      summarizePlaystyleDiagnostics(report.results),
    ])),
  };
}

async function commandDiagnostics(args) {
  const evaluations = asList(required(args, "evaluations")).map((file) => ({
    file: path.resolve(file),
    sha256: sha256File(file),
    report: JSON.parse(fs.readFileSync(file, "utf8")),
  }));
  writeJson(required(args, "out"), policyDiagnosticsReport(evaluations, { label: args.label ?? null }));
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

export function collectionSpecs({
  plan,
  iteration,
  pairsPerIteration,
  modelPath,
  modelSha256,
  cadence,
  outDir,
  rewardVersion = EDGER_V2_CADENCE_REWARD_VERSION,
}) {
  assertRewardVersion(rewardVersion);
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
      reward_version: rewardVersion,
    }),
  });
}

async function collect({
  plan,
  iteration,
  pairsPerIteration,
  modelPath,
  cadence,
  outDir,
  workers,
  out,
  rewardVersion = EDGER_V2_CADENCE_REWARD_VERSION,
}) {
  const specs = collectionSpecs({
    plan, iteration, pairsPerIteration, modelPath, modelSha256: sha256File(modelPath), cadence, outDir, rewardVersion,
  });
  const started = Date.now();
  const results = await runCadenceSpecs(specs, { workers, onResult: progress(`collect it${iteration} ${cadence}`) });
  const collection = {
    schema_version: "edger_v2_cadence_collection_v1",
    iteration,
    cadence,
    reward_version: rewardVersion,
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
      // Identify the game itself, independent of the reward fields the body
      // also stores, so collections under different rewards can be compared.
      action_stream_hash: result.action_stream_hash,
      final_state_hash: result.final_state_hash,
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
    rewardVersion: assertRewardVersion(String(args.reward ?? EDGER_V2_CADENCE_REWARD_VERSION)),
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

export function heldoutCaptureRecord(report) {
  const capture = report.opportunity_capture;
  return {
    rows: capture.model.opportunity.rows,
    capture_rate: capture.model.opportunity.capture_rate,
    mean_p_fireball: capture.model.opportunity.mean_p_fireball,
    parent_capture_rate: capture.parent.opportunity.capture_rate,
    parent_mean_p_fireball: capture.parent.opportunity.mean_p_fireball,
    capture_rate_below_parent: capture.capture_rate_below_parent,
    mean_p_fireball_below_parent: capture.mean_p_fireball_below_parent,
  };
}

// The learner command for one train-arm iteration. A warm start (the first
// iteration of an arm given --initial-checkpoint) restarts Adam and lets the
// learner check that only the critic head differs from the parent.
export function trainIterationArguments({
  checkpoint, parentCheckpoint, collection, cadence, arm, iteration, out, metricsOut,
  learningRate, lossMode, cardKlCoefficient, cardKlRows, decomposeEvery, torchSeed, rewardVersion,
  warmStart = false,
}) {
  return [
    "train-iteration",
    "--checkpoint", checkpoint,
    "--parent", parentCheckpoint,
    "--collection", collection,
    "--delay-mode", cadence,
    "--arm", arm,
    "--iteration", String(iteration),
    "--out", out,
    "--metrics-out", metricsOut,
    "--learning-rate", learningRate,
    "--loss-mode", lossMode,
    "--card-kl-coefficient", cardKlCoefficient,
    "--card-kl-rows", cardKlRows,
    "--decompose-every", decomposeEvery,
    "--seed", torchSeed,
    "--reward-version", rewardVersion,
    ...(warmStart ? ["--start-from-warmup"] : []),
  ];
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
  // Weights for iteration 0 from a finished critic_head warm-up arm. The
  // parent stays the reference and plays iteration 0: the learner refuses a
  // warm-up whose actor differs from the parent's.
  const initialCheckpoint = args["initial-checkpoint"] ? path.resolve(args["initial-checkpoint"]) : null;
  const iterations = Number(args.iterations ?? 6);
  const pairsPerIteration = Number(args["pairs-per-iteration"] ?? 32);
  const workers = Number(args.workers ?? 7);
  const learningRate = String(args["learning-rate"] ?? "0.001");
  const probes = asList(args.probes).map((value) => path.resolve(value));
  const heldout = args.heldout ? path.resolve(args.heldout) : null;
  const budgetMinutes = Number(args["budget-minutes"] ?? 150);
  const lossMode = String(args["loss-mode"] ?? "full");
  const cardKlCoefficient = String(args["card-kl-coefficient"] ?? "0");
  const cardKlRows = String(args["card-kl-rows"] ?? "all");
  const decomposeEvery = String(args["decompose-every"] ?? "0");
  const torchSeed = String(args["torch-seed"] ?? "20260926");
  const rewardVersion = assertRewardVersion(String(args.reward ?? EDGER_V2_CADENCE_REWARD_VERSION));
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
    card_kl_coefficient: Number(cardKlCoefficient),
    card_kl_rows: cardKlRows,
    decompose_every: Number(decomposeEvery),
    torch_seed: Number(torchSeed),
    reward_version: rewardVersion,
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
  if (initialCheckpoint) {
    status.initial_checkpoint = initialCheckpoint;
    status.initial_checkpoint_sha256 = sha256File(initialCheckpoint);
  }
  const armStarted = Date.now();
  let checkpoint = initialCheckpoint ?? parentCheckpoint;
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
      rewardVersion,
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
    const train = python(trainIterationArguments({
      checkpoint,
      parentCheckpoint,
      collection: path.join(iterationDir, "collection.json"),
      cadence,
      arm,
      iteration,
      out: nextCheckpoint,
      metricsOut: path.join(iterationDir, "learner-metrics.json"),
      learningRate,
      lossMode,
      cardKlCoefficient,
      cardKlRows,
      decomposeEvery,
      torchSeed,
      rewardVersion,
      warmStart: Boolean(initialCheckpoint) && iteration === 0,
    }), logPath);
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
      record.opportunity_capture = heldoutCaptureRecord(
        JSON.parse(fs.readFileSync(path.join(iterationDir, "heldout.json"), "utf8")),
      );
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
  if (heldout) {
    // Held-out Fireball capture below the parent's is a diagnostic failure,
    // reported rather than stopping the arm.
    status.capture_below_parent_iterations = status.iterations
      .filter((record) => record.opportunity_capture?.capture_rate_below_parent === true)
      .map((record) => record.iteration);
    status.capture_diagnostic = status.capture_below_parent_iterations.length > 0 ? "failed" : "passed";
  }
  status.finished_at = new Date().toISOString();
  status.wall_seconds = (Date.now() - armStarted) / 1000;
  status.final_checkpoint = checkpoint;
  status.final_model = model;
  status.stop_reason ??= "completed";
  writeJson(statusPath, status);
  console.log(JSON.stringify({ arm, stop_reason: status.stop_reason, final_model: model }));
}

// ---------------------------------------------------------------------------
// Conversion of a train-arm collection to production training episodes
//
// The production learner (edger-dataset.mjs cache, edger-v2-training.py
// vtrace) reads edger_training_episode_v1 episodes, while train-arm keeps
// compact cadence trajectories whose bodies may be pruned. Conversion
// regenerates every game from the collection's recorded model, seed, side and
// opponent, refuses any game whose body differs from the recorded header, and
// requires the production derivation to reproduce every cadence row exactly.
// Episode IDs hash the whole episode, policy and collector labels included,
// and the IDs fix the production split and order; the labels are therefore
// constants here, never arguments.

export const CADENCE_CONVERSION_SCHEMA = "edger_v2_cadence_conversion_v1";
export const CADENCE_CONVERSION_COLLECTOR = "edger_v2_cadence_conversion_v1";

function sameValues(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function denseCadenceBoard(row, size) {
  const board = new Array(size).fill(0);
  row.board_indices.forEach((cell, index) => {
    board[cell] = row.board_values[index];
  });
  return board;
}

// Names of the fields in which a production decision sample differs from the
// cadence row it must reproduce; empty when they agree exactly.
export function cadenceRowMismatches(sample, row, { actor, opponent }) {
  const fields = [];
  const check = (name, same) => {
    if (!same) {
      fields.push(name);
    }
  };
  check("tick", sample.tick === row.tick);
  check("actor", sample.actor === actor);
  check("opponent_stratum", sample.opponent_stratum === opponent);
  check("delay_ticks", sample.delay_ticks === row.delay_ticks);
  check("card_index", sample.selected.card_index === row.card_index);
  check("placement_index", sample.selected.placement_index === row.placement_index);
  check("delay_index", sample.selected.delay_index === row.delay_index);
  check("behavior_log_probability", sample.behavior_log_probability === row.behavior_log_probability);
  check("vtrace_eligible", sample.vtrace_eligible === true);
  check("reward", sample.reward === row.reward);
  check("discounted_return", sample.discounted_return === row.discounted_return);
  check("board", sameValues(sample.board, denseCadenceBoard(row, sample.board.length)));
  check("global", sameValues(sample.global, row.global));
  check("card_mask", sameValues(sample.legal_masks.card, row.card_mask));
  check("placement_mask", sameValues(
    sample.legal_masks.placement.flatMap((value, cell) => (value ? [cell] : [])),
    row.placement_legal,
  ));
  // Cadence trajectories carry no delay mask: every delay bin is legal.
  check("delay_mask", sample.legal_masks.delay.every((value) => value === 1));
  return fields;
}

export function cadenceTrainingEpisode({ item, match, model }) {
  const opponentActor = item.candidate_actor === "blue" ? "red" : "blue";
  return createTrainingEpisode({
    seed: item.seed,
    initialCardState: match.replay.initial_card_state,
    actions: match.replay.actions,
    events: match.replay.events,
    result: match.replay.result,
    finalStateHash: match.final_state_hash,
    policies: {
      [item.candidate_actor]: {
        policy_id: model.model_id,
        checkpoint_id: model.training?.checkpoint_id ?? null,
        behavior_probabilities: "known",
      },
      [opponentActor]: { policy_id: item.opponent, behavior_probabilities: "unknown" },
    },
    source: { kind: "simulator", collector: CADENCE_CONVERSION_COLLECTOR },
    decisions: match.rows.map((row) => ({
      tick: row.tick,
      actor: item.candidate_actor,
      action: row.action,
      delay_ticks: row.delay_ticks,
      behavior_log_probability: row.behavior_log_probability,
      opponent_stratum: item.opponent,
    })),
  });
}

function conversionFailure(message, report) {
  const error = new Error(message);
  error.report = report;
  return error;
}

export function convertCadenceCollection({ collectionPath, headersDir = null, store, manifestOut }) {
  const started = performance.now();
  const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
  if (collection.schema_version !== "edger_v2_cadence_collection_v1") {
    throw new Error(`${collectionPath} is not a cadence collection`);
  }
  // The production derivation computes reward v1 only.
  const collectionReward = collection.reward_version ?? EDGER_V2_CADENCE_REWARD_VERSION;
  if (collectionReward !== EDGER_V2_CADENCE_REWARD_VERSION) {
    throw new Error(`${collectionPath} uses ${collectionReward}; convert-collection supports ${EDGER_V2_CADENCE_REWARD_VERSION} only`);
  }
  const modelSha256 = sha256File(collection.model);
  const report = {
    schema_version: CADENCE_CONVERSION_SCHEMA,
    collector: CADENCE_CONVERSION_COLLECTOR,
    collection: path.resolve(collectionPath),
    collection_sha256: sha256File(collectionPath),
    iteration: collection.iteration,
    cadence: collection.cadence,
    model: collection.model,
    model_sha256: modelSha256,
    recorded_model_sha256: collection.model_sha256,
    headers_dir: headersDir ? path.resolve(headersDir) : null,
    store: path.resolve(store),
    passed: false,
    episodes: [],
  };
  if (modelSha256 !== collection.model_sha256) {
    throw conversionFailure(`collecting model ${collection.model} differs from the collection's recorded SHA-256`, report);
  }
  const model = validateEdgerV2PolicyModel(JSON.parse(fs.readFileSync(collection.model, "utf8")));
  const uris = [];
  for (const item of [...collection.episodes].sort((left, right) => left.match_index - right.match_index)) {
    const headerPath = headersDir ? path.join(headersDir, `${item.episode_id}.json`) : item.header;
    const header = JSON.parse(fs.readFileSync(headerPath, "utf8"));
    const recorded = {
      episode_id: item.episode_id,
      seed: item.seed,
      candidate_actor: item.candidate_actor,
      opponent: item.opponent,
      cadence: collection.cadence,
      mode: "sample",
      model_sha256: collection.model_sha256,
    };
    const headerProblems = Object.entries(recorded).filter(([key, value]) => header[key] !== value).map(([key]) => key);
    if (headerProblems.length > 0) {
      throw conversionFailure(`${item.episode_id}: header disagrees with the collection on ${headerProblems.join(", ")}`, report);
    }
    const match = runEdgerV2CadenceMatch({
      seed: item.seed,
      candidateActor: item.candidate_actor,
      model,
      cadence: collection.cadence,
      opponentBotId: item.opponent,
      mode: "sample",
      recordRows: true,
      returnReplay: true,
    });
    const bodySha256 = encodeCadenceEpisode({ rows: match.rows, meta: {} }).header.body_sha256;
    if (bodySha256 !== header.body_sha256 || match.rows.length !== header.rows) {
      throw conversionFailure(`${item.episode_id}: regenerated body differs from the recorded header`, report);
    }
    const episode = cadenceTrainingEpisode({ item, match, model });
    const stored = storeTrainingEpisode({ episode, store, verifyReplay: true });
    uris.push(stored.uri);
    const samples = deriveDecisionSequence(episode).samples;
    const mismatchedRows = [];
    const fieldCounts = {};
    match.rows.forEach((row, index) => {
      const fields = index < samples.length
        ? cadenceRowMismatches(samples[index], row, { actor: item.candidate_actor, opponent: item.opponent })
        : ["missing"];
      if (fields.length > 0) {
        mismatchedRows.push(index);
        fields.forEach((field) => {
          fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
        });
      }
    });
    report.episodes.push({
      match_index: item.match_index,
      cadence_episode: item.episode_id,
      body_sha256: bodySha256,
      episode_id: episode.episode_id,
      split: splitForEpisodeId(episode.episode_id),
      rows: match.rows.length,
      derived_samples: samples.length,
      row_mismatches: mismatchedRows.length + Math.max(0, samples.length - match.rows.length),
      mismatched_fields: fieldCounts,
    });
  }
  report.rows = report.episodes.reduce((sum, episode) => sum + episode.rows, 0);
  report.row_mismatches = report.episodes.reduce((sum, episode) => sum + episode.row_mismatches, 0);
  report.splits = { train: 0, validation: 0, test: 0 };
  report.split_rows = { train: 0, validation: 0, test: 0 };
  for (const episode of report.episodes) {
    report.splits[episode.split] += 1;
    report.split_rows[episode.split] += episode.rows;
  }
  report.wall_seconds = (performance.now() - started) / 1000;
  if (report.row_mismatches > 0) {
    throw conversionFailure(`${report.row_mismatches} derived rows differ from the cadence rows`, report);
  }
  const manifest = buildDatasetManifest({ episodeUris: uris });
  const converted = report.episodes.map((episode) => episode.episode_id).sort();
  if (!sameValues(manifest.shards.map((shard) => shard.episode_id), converted)) {
    throw conversionFailure("manifest shards differ from the converted episodes", report);
  }
  writeDatasetManifest(manifestOut, manifest);
  report.passed = true;
  report.manifest = path.resolve(manifestOut);
  report.manifest_sha256 = sha256File(manifestOut);
  report.manifest_hash = manifest.manifest_hash;
  report.wall_seconds = (performance.now() - started) / 1000;
  return report;
}

async function commandConvertCollection(args) {
  const manifestOut = required(args, "manifest-out");
  const reportOut = args["report-out"] ?? `${manifestOut}.conversion.json`;
  if (fs.existsSync(manifestOut) || fs.existsSync(reportOut)) {
    throw new Error(`conversion output already exists: ${fs.existsSync(manifestOut) ? manifestOut : reportOut}`);
  }
  let report;
  try {
    report = convertCadenceCollection({
      collectionPath: required(args, "collection"),
      headersDir: args.headers ?? null,
      store: required(args, "store"),
      manifestOut,
    });
  } catch (error) {
    if (error.report) {
      // A failed check leaves no manifest, only the report that explains it.
      writeJson(`${reportOut}.failed`, { ...error.report, error: error.message });
    }
    throw error;
  }
  writeJson(reportOut, report);
  console.log(JSON.stringify({
    episodes: report.episodes.length,
    rows: report.rows,
    row_mismatches: report.row_mismatches,
    splits: report.splits,
    manifest_hash: report.manifest_hash,
    wall_seconds: report.wall_seconds,
  }));
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
  diagnostics: commandDiagnostics,
  "convert-collection": commandConvertCollection,
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
