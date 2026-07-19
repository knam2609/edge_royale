#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import {
  canonicalCompactJson,
  canonicalJson,
} from "./edger-corpus-core.mjs";
import { executeEdgerV2EvaluationSpecs } from "./edger-v2-evaluation-core.mjs";

const FROZEN_LEAGUE_REPORT_SCHEMA = "edger_frozen_league_report_v1";
const LIVE_V1_PATH = "artifacts/edger-training/promoted/edger_policy_current.json";
const OPPONENT_IDS = ["live_v1", "edger_heuristic", "random", "aggressive", "defender"];
const GAMES_PER_OPPONENT = 40;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    candidate: null,
    checkpoint: null,
    out: null,
    seed: 20260718,
    workers: 16,
    liveChampion: LIVE_V1_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate" && argv[index + 1]) {
      parsed.candidate = argv[++index];
    } else if (arg === "--checkpoint" && argv[index + 1]) {
      parsed.checkpoint = argv[++index];
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--live-champion" && argv[index + 1]) {
      parsed.liveChampion = argv[++index];
    }
  }
  if (!parsed.candidate || !parsed.checkpoint || !parsed.out) {
    throw new Error("--candidate, --checkpoint, and --out are required");
  }
  if (!Number.isInteger(parsed.seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be 1-32");
  }
  return parsed;
}

function buildFrozenSuite({ seed, liveChampionPath, liveChampionId }) {
  const opponents = [
    {
      key: "live_v1",
      descriptor: {
        kind: "model",
        policy_id: liveChampionId,
        checkpoint_id: null,
        model_path: path.resolve(liveChampionPath),
      },
    },
    ...OPPONENT_IDS.slice(1).map((policyId) => ({
      key: policyId,
      descriptor: {
        kind: "bot",
        policy_id: policyId,
        checkpoint_id: null,
      },
    })),
  ];
  const specs = [];
  for (const { key, descriptor } of opponents) {
    for (let pairIndex = 0; pairIndex < GAMES_PER_OPPONENT / 2; pairIndex += 1) {
      const matchSeed = seed + pairIndex;
      for (const candidateActor of ["blue", "red"]) {
        specs.push({
          spec_id: specs.length,
          group: key,
          block: null,
          pair_id: `${key}|${pairIndex}`,
          seed: matchSeed,
          candidate_actor: candidateActor,
          opponent: descriptor,
          verify_replay: true,
        });
      }
    }
  }
  return specs;
}

function suiteIdentity(specs, liveChampionChecksum) {
  return {
    schema_version: "edger_frozen_league_suite_v1",
    games_per_opponent: GAMES_PER_OPPONENT,
    live_champion_checksum: liveChampionChecksum,
    specs: specs.map((spec) => ({
      spec_id: spec.spec_id,
      group: spec.group,
      pair_id: spec.pair_id,
      seed: spec.seed,
      candidate_actor: spec.candidate_actor,
      opponent_id: spec.opponent.policy_id,
      verify_replay: spec.verify_replay,
    })),
  };
}

function summarize(results) {
  const byOpponent = {};
  for (const opponentId of OPPONENT_IDS) {
    const selected = results.filter((result) => result.group === opponentId);
    byOpponent[opponentId] = {
      games: selected.length,
      paired_seeds: new Set(selected.map((result) => result.pair_id)).size,
      wins: selected.filter((result) => result.candidate_point === 1).length,
      draws: selected.filter((result) => result.candidate_point === 0.5).length,
      losses: selected.filter((result) => result.candidate_point === 0).length,
      score: selected.reduce((sum, result) => sum + result.candidate_point, 0) /
        Math.max(1, selected.length),
    };
  }
  return byOpponent;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const candidatePath = path.resolve(args.candidate);
  const checkpointPath = path.resolve(args.checkpoint);
  const liveChampionPath = path.resolve(args.liveChampion);
  const candidateBytes = fs.readFileSync(candidatePath);
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const liveChampionBytes = fs.readFileSync(liveChampionPath);
  const candidate = validateEdgerV2PolicyModel(JSON.parse(candidateBytes));
  const liveChampion = JSON.parse(liveChampionBytes);
  const specs = buildFrozenSuite({
    seed: args.seed,
    liveChampionPath,
    liveChampionId: liveChampion.model_id,
  });
  const identity = suiteIdentity(specs, sha256(liveChampionBytes));
  const results = await executeEdgerV2EvaluationSpecs({
    candidateModelPath: candidatePath,
    specs,
    workers: args.workers,
  });
  const matchups = summarize(results);
  const scores = OPPONENT_IDS.map((opponentId) => matchups[opponentId].score);
  const replayChecks = results.filter((result) => result.replay_checked);
  const report = {
    schema_version: FROZEN_LEAGUE_REPORT_SCHEMA,
    candidate_model_id: candidate.model_id,
    candidate_model_checksum: sha256(candidateBytes),
    candidate_checkpoint_id: candidate.training?.checkpoint_id ?? null,
    candidate_checkpoint_checksum: sha256(checkpointBytes),
    seed: args.seed,
    workers: args.workers,
    suite_spec_checksum: sha256(canonicalCompactJson(identity)),
    suite: identity,
    matchups,
    frozen_league_score: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    illegal_actions: results.reduce((sum, result) => sum + result.illegal_actions, 0),
    replay_checks: {
      checked: replayChecks.length,
      passed: replayChecks.filter((result) => result.replay_passed).length,
      all_passed:
        replayChecks.length === results.length &&
        replayChecks.every((result) => result.replay_passed),
    },
    results_checksum: sha256(canonicalCompactJson(results)),
  };
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canonicalJson(report));
  console.log(canonicalJson({
    report: output,
    candidate_model_id: report.candidate_model_id,
    suite_spec_checksum: report.suite_spec_checksum,
    frozen_league_score: report.frozen_league_score,
    illegal_actions: report.illegal_actions,
    replay_checks: report.replay_checks,
  }).trimEnd());
  if (report.illegal_actions !== 0 || !report.replay_checks.all_passed) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
