#!/usr/bin/env node
// Runtime-cost harness, Node validation slice.
//
//   bank    Build the development state bank from reference matches on the
//           first N development seeds; fails if any category lacks coverage.
//   verify  Rebuild every bank state and compare the browser-safe adapter with
//           the frozen cadence reference and the production learned selector,
//           then compare full matches (schedule, counts, stream and final-state
//           hashes) with the timing hook off and on.
//   expect  Emit the frozen reference's bank decisions and full-match
//           expectations (schedule, counts, hashes, result, overtime start)
//           that the staged browser harness must reproduce, plus the live-v1
//           cost baselines checked against an independent Node reference. Uses
//           the same bank and match seeds; it selects no new seeds.
//
// Models must match the confirmation pins. Seeds must be development seeds of
// the base plan and absent from the replication plan's confirmation array.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDeepStrictEqual } from "node:util";

import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import {
  EDGER_V2_ACTORS,
  EDGER_V2_CONTROLLER_LIST,
  EDGER_V2_NODE_EQUIVALENCE_SCHEMA,
  EDGER_V2_RUNTIME_COST_MODEL_PINS,
  EDGER_V2_STATE_BANK_SCHEMA,
  buildNodeExpectations,
  buildStateBank,
  checkBankEquivalence,
  checkFullMatch,
  sha256Hex,
} from "./edger-v2-runtime-cost-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANK_LABEL = "edger-runtime-cost-bank-20261002";
// Live v1 for the cost baselines: the generated runtime module and the
// canonical promoted JSON it was generated from.
export const LIVE_V1_MODULE = "src/ai/generated/edgerPolicyCurrent.js";
export const LIVE_V1_ARTIFACT = "artifacts/edger-training/promoted/edger_policy_current.json";
const MISMATCH_CAP = 50;
const CLOSURE_SCRIPTS = Object.freeze([
  "scripts/edger-v2-cadence-core.mjs",
  "scripts/edger-v2-runtime-cost-adapter.js",
  "scripts/edger-v2-runtime-cost-core.mjs",
  "scripts/edger-v2-runtime-cost.mjs",
  "package.json",
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      args[key] = next !== undefined && !next.startsWith("--") ? argv[++index] : true;
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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function sha256File(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadPinnedModels(modelDir) {
  const models = {};
  const hashes = {};
  for (const [run, expected] of Object.entries(EDGER_V2_RUNTIME_COST_MODEL_PINS)) {
    const file = path.join(modelDir, `${run}-learned-full.json`);
    const bytes = fs.readFileSync(file);
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(`${run} model ${file} hashes to ${actual}, expected ${expected}`);
    }
    models[run] = validateEdgerV2PolicyModel(JSON.parse(bytes.toString("utf8")));
    hashes[run] = actual;
  }
  return { models, hashes };
}

// Seeds must be development seeds and disjoint from the reserved confirmation set.
function loadSeedPlans(args) {
  const basePath = required(args, "base-plan");
  const replicationPath = required(args, "replication-plan");
  const base = readJson(basePath);
  const replication = readJson(replicationPath);
  if (base.schema_version !== "edger_v2_cadence_seed_plan_v1" || !Array.isArray(base.development)) {
    throw new Error(`${basePath} is not a base cadence seed plan`);
  }
  if (
    replication.schema_version !== "edger_v2_cadence_replication_seed_plan_v1" ||
    !Array.isArray(replication.confirmation)
  ) {
    throw new Error(`${replicationPath} is not a replication seed plan`);
  }
  const development = new Set(base.development);
  const confirmation = new Set(replication.confirmation);
  return {
    base,
    record: {
      base_plan_sha256: sha256File(basePath),
      replication_plan_sha256: sha256File(replicationPath),
    },
    assertDevelopment(seeds) {
      for (const seed of seeds) {
        if (!development.has(seed)) {
          throw new Error(`seed ${seed} is not a base-plan development seed`);
        }
        if (confirmation.has(seed)) {
          throw new Error(`seed ${seed} is a reserved confirmation seed`);
        }
      }
    },
  };
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function provenance(args) {
  const closure = {};
  const files = [
    ...listFiles(path.join(ROOT, "src")).map((file) => path.relative(ROOT, file)),
    ...CLOSURE_SCRIPTS,
  ].sort();
  for (const file of files) {
    closure[file] = sha256File(path.join(ROOT, file));
  }
  let git = null;
  if (args["git-root"] && args["git-root"] !== true) {
    const run = (...gitArgs) => execFileSync("git", ["-C", args["git-root"], ...gitArgs]);
    git = {
      head: run("rev-parse", "HEAD").toString().trim(),
      tracked_diff_sha256: sha256Hex(run("diff", "HEAD", "--binary")),
    };
  }
  return {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? null,
    root: ROOT,
    git,
    closure_sha256: sha256Hex(JSON.stringify(closure)),
    closure,
  };
}

function writeJson(filePath, value) {
  const text = `${JSON.stringify(value)}\n`;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, text);
  return sha256Hex(text);
}

function cap(list) {
  return { count: list.length, first: list.slice(0, MISMATCH_CAP) };
}

async function bankCommand(args) {
  const plans = loadSeedPlans(args);
  const count = positiveInteger(args.seeds ?? 2, "--seeds");
  const seeds = plans.base.development.slice(0, count);
  plans.assertDevelopment(seeds);
  const { models, hashes } = loadPinnedModels(required(args, "model-dir"));
  const started = performance.now();
  const bank = buildStateBank({
    label: BANK_LABEL,
    seeds,
    models,
    stride: positiveInteger(args.stride ?? 10, "--stride"),
    perCategory: positiveInteger(args["per-category"] ?? 5, "--per-category"),
    provenance: {
      model_sha256: hashes,
      seed_plans: plans.record,
      source: provenance(args),
    },
  });
  const outPath = required(args, "out");
  const digest = writeJson(outPath, bank);
  console.log(JSON.stringify({
    bank: path.resolve(outPath),
    sha256: digest,
    states: bank.states.length,
    sources: bank.sources.length,
    pool_states: bank.pool_states,
    coverage: bank.coverage,
    seconds: Math.round(performance.now() - started) / 1000,
  }, null, 1));
}

// Pinned bank, development match seeds and models shared by verify and expect.
function loadVerifiedInputs(args) {
  const plans = loadSeedPlans(args);
  const bankPath = required(args, "bank");
  const bankDigest = sha256File(bankPath);
  if (bankDigest !== required(args, "bank-sha256")) {
    throw new Error(`bank ${bankPath} hashes to ${bankDigest}, not the pinned value`);
  }
  const bank = readJson(bankPath);
  if (bank.schema_version !== EDGER_V2_STATE_BANK_SCHEMA) {
    throw new Error(`unexpected bank schema ${bank.schema_version}`);
  }
  plans.assertDevelopment(bank.seeds);
  const matchSeeds = String(args["match-seeds"] ?? plans.base.development[0])
    .split(",")
    .map((seed) => positiveInteger(seed, "--match-seeds"));
  plans.assertDevelopment(matchSeeds);
  const { models, hashes } = loadPinnedModels(required(args, "model-dir"));
  if (JSON.stringify(hashes) !== JSON.stringify(bank.model_sha256)) {
    throw new Error("bank was built from different models");
  }
  return { plans, bankPath, bankDigest, bank, matchSeeds, models, hashes };
}

async function verifyCommand(args) {
  const { plans, bankPath, bankDigest, bank, matchSeeds, models, hashes } = loadVerifiedInputs(args);

  const started = performance.now();
  const bankResult = checkBankEquivalence({ bank, models });
  const bankSeconds = (performance.now() - started) / 1000;

  const fullMatches = [];
  for (const seed of matchSeeds) {
    for (const [run, model] of Object.entries(models)) {
      for (const controller of EDGER_V2_CONTROLLER_LIST) {
        for (const candidateActor of EDGER_V2_ACTORS) {
          const conditionStart = performance.now();
          const result = checkFullMatch({ seed, candidateActor, model, controller });
          fullMatches.push({
            model: run,
            ...result,
            mismatches: cap(result.mismatches),
            seconds: Math.round(performance.now() - conditionStart) / 1000,
          });
          console.error(
            `full match ${seed} ${run} ${controller} ${candidateActor}: ` +
            `${result.mismatches.length === 0 ? "match" : "MISMATCH"} ` +
            `(${result.reference.counts.decisions} decisions)`,
          );
        }
      }
    }
  }

  const fullMismatches = fullMatches.reduce((sum, entry) => sum + entry.mismatches.count, 0);
  const passed = bankResult.mismatches.length === 0 && fullMismatches === 0;
  const report = {
    schema_version: EDGER_V2_NODE_EQUIVALENCE_SCHEMA,
    passed,
    scope: "node_only; browser stream/state equivalence and smoke are pending",
    bank: { path: path.resolve(bankPath), sha256: bankDigest, states: bank.states.length },
    model_sha256: hashes,
    seed_plans: plans.record,
    bank_equivalence: {
      decisions: bankResult.decisions,
      seconds: Math.round(bankSeconds * 1000) / 1000,
      tally: bankResult.tally,
      mismatches: cap(bankResult.mismatches),
    },
    full_match_equivalence: {
      seeds: matchSeeds,
      conditions: fullMatches.length,
      mismatches: fullMismatches,
      results: fullMatches,
    },
    source: provenance(args),
  };
  const outPath = required(args, "out");
  const digest = writeJson(outPath, report);
  console.log(JSON.stringify({
    passed,
    report: path.resolve(outPath),
    sha256: digest,
    bank_decisions: bankResult.decisions,
    bank_mismatches: bankResult.mismatches.length,
    full_match_conditions: fullMatches.length,
    full_match_mismatches: fullMismatches,
  }, null, 1));
  if (!passed) {
    process.exitCode = 1;
  }
}

async function expectCommand(args) {
  const { plans, bankPath, bankDigest, bank, matchSeeds, models, hashes } = loadVerifiedInputs(args);
  const started = performance.now();
  const artifactBytes = fs.readFileSync(path.join(ROOT, LIVE_V1_ARTIFACT));
  if (!isDeepStrictEqual(JSON.parse(artifactBytes.toString("utf8")), EDGER_POLICY_MODEL)) {
    throw new Error(`${LIVE_V1_MODULE} does not hold the model in ${LIVE_V1_ARTIFACT}`);
  }
  const expectations = buildNodeExpectations({ bank, models, matchSeeds });
  const report = {
    ...expectations,
    live_v1: {
      module: LIVE_V1_MODULE,
      module_sha256: sha256File(path.join(ROOT, LIVE_V1_MODULE)),
      artifact: LIVE_V1_ARTIFACT,
      artifact_sha256: sha256Hex(artifactBytes),
      model_id: EDGER_POLICY_MODEL.model_id,
    },
    bank: { path: path.resolve(bankPath), sha256: bankDigest, states: bank.states.length },
    match_seeds: matchSeeds,
    model_sha256: hashes,
    seed_plans: plans.record,
    source: provenance(args),
  };
  const outPath = required(args, "out");
  const digest = writeJson(outPath, report);
  console.log(JSON.stringify({
    expectations: path.resolve(outPath),
    sha256: digest,
    bank_decisions: expectations.bank_decisions.length,
    full_matches: expectations.full_matches.length,
    v1_baselines: expectations.v1_baselines.map((entry) => `${entry.id} ${entry.result.reason} ${entry.result.tick}`),
    overtime_conditions: expectations.full_matches
      .filter((entry) => entry.overtime_start_tick !== null)
      .map((entry) => entry.id),
    seconds: Math.round(performance.now() - started) / 1000,
  }, null, 1));
}

const COMMANDS = { bank: bankCommand, verify: verifyCommand, expect: expectCommand };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]];
  if (!command) {
    console.error(`usage: edger-v2-runtime-cost.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
    process.exit(2);
  }
  command(args).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
