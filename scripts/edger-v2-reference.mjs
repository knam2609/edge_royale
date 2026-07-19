#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import { canonicalJson } from "./edger-corpus-core.mjs";
import {
  EDGER_V2_REFERENCE_REPORT_SCHEMA,
  executeEdgerV2EvaluationSpecs,
} from "./edger-v2-evaluation-core.mjs";

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    champion: "artifacts/edger-training/promoted/edger_policy_current.json",
    anchors: [],
    out: null,
    seed: 20260718,
    workers: 16,
    gamesPerOpponent: 200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--champion" && argv[index + 1]) {
      parsed.champion = argv[++index];
    } else if (arg === "--anchors" && argv[index + 1]) {
      parsed.anchors = argv[++index].split(",").filter(Boolean);
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--games-per-opponent" && argv[index + 1]) {
      parsed.gamesPerOpponent = Number.parseInt(argv[++index], 10);
    }
  }
  if (!parsed.out) {
    throw new Error("--out is required");
  }
  if (
    !Number.isInteger(parsed.gamesPerOpponent) ||
    parsed.gamesPerOpponent < 2 ||
    parsed.gamesPerOpponent % 2 !== 0
  ) {
    throw new Error("--games-per-opponent must be a positive even integer");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be 1-32");
  }
  if (parsed.anchors.length > 4) {
    throw new Error("at most four historical anchors are supported");
  }
  return parsed;
}

function modelDescriptor(modelPath) {
  const resolved = path.resolve(modelPath);
  const model = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateEdgerPolicyModel(model);
  return {
    kind: "model",
    policy_id: model.model_id,
    checkpoint_id: null,
    model_path: resolved,
  };
}

function buildSpecs({ args, opponents }) {
  const specs = [];
  for (const opponent of opponents) {
    const group = opponent.kind === "bot"
      ? "heuristic"
      : `anchor:${opponent.policy_id}`;
    for (let pairIndex = 0; pairIndex < args.gamesPerOpponent / 2; pairIndex += 1) {
      for (const candidateActor of ["blue", "red"]) {
        specs.push({
          spec_id: specs.length,
          group,
          block: null,
          pair_id: `${group}|${pairIndex}`,
          seed: args.seed + pairIndex,
          candidate_actor: candidateActor,
          opponent,
          verify_replay: true,
        });
      }
    }
  }
  return specs;
}

function summarize(results) {
  const groups = {};
  for (const result of results) {
    const groupResults = groups[result.group] ?? [];
    groupResults.push(result);
    groups[result.group] = groupResults;
  }
  return Object.fromEntries(
    Object.entries(groups).map(([group, groupResults]) => [
      group,
      {
        games: groupResults.length,
        paired_seeds: new Set(groupResults.map((result) => result.pair_id)).size,
        wins: groupResults.filter((result) => result.candidate_point === 1).length,
        draws: groupResults.filter((result) => result.candidate_point === 0.5).length,
        losses: groupResults.filter((result) => result.candidate_point === 0).length,
        score: groupResults.reduce(
          (sum, result) => sum + result.candidate_point,
          0,
        ) / groupResults.length,
      },
    ]),
  );
}

try {
  const args = parseArgs(process.argv.slice(2));
  const championPath = path.resolve(args.champion);
  const champion = JSON.parse(fs.readFileSync(championPath, "utf8"));
  validateEdgerPolicyModel(champion);
  const opponents = [
    { kind: "bot", policy_id: "edger_heuristic", checkpoint_id: null },
    ...args.anchors.map(modelDescriptor),
  ];
  const specs = buildSpecs({ args, opponents });
  const results = await executeEdgerV2EvaluationSpecs({
    candidateModelPath: championPath,
    specs,
    workers: args.workers,
  });
  const matchups = summarize(results);
  const scores = Object.values(matchups).map((matchup) => matchup.score);
  const report = {
    schema_version: EDGER_V2_REFERENCE_REPORT_SCHEMA,
    model_id: champion.model_id,
    model_checksum: sha256File(championPath),
    seed: args.seed,
    workers: args.workers,
    games_per_opponent: args.gamesPerOpponent,
    specs_checksum: sha256Json(specs.map((spec) => ({
      group: spec.group,
      pair_id: spec.pair_id,
      seed: spec.seed,
      candidate_actor: spec.candidate_actor,
      opponent_id: spec.opponent.policy_id,
    }))),
    results_checksum: sha256Json(results),
    generated_matches: results.length,
    matchups,
    frozen_league_mean:
      scores.reduce((sum, score) => sum + score, 0) / scores.length,
    illegal_actions: results.reduce((sum, result) => sum + result.illegal_actions, 0),
    replay_checks: {
      checked: results.filter((result) => result.replay_checked).length,
      passed: results.filter(
        (result) => result.replay_checked && result.replay_passed,
      ).length,
    },
  };
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canonicalJson(report));
  console.log(canonicalJson({
    report: output,
    model_id: report.model_id,
    generated_matches: report.generated_matches,
    frozen_league_mean: report.frozen_league_mean,
    illegal_actions: report.illegal_actions,
    replay_checks: report.replay_checks,
  }).trimEnd());
  if (
    report.illegal_actions !== 0 ||
    report.replay_checks.checked !== report.generated_matches ||
    report.replay_checks.passed !== report.generated_matches
  ) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
