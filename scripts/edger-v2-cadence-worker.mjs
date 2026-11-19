import fs from "node:fs";
import { EDGER_FULL_GRID_ACTION_SPACE_VERSION } from "../src/ai/v2/observation.js";
import os from "node:os";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import { validateEdgerV2PolicyModel } from "../src/ai/v2/policy.js";
import {
  EDGER_V2_CADENCE_REWARD_VERSION,
  encodeCadenceEpisode,
  runEdgerV2CadenceMatch,
} from "./edger-v2-cadence-core.mjs";

const models = new Map();

function loadModel(modelPath) {
  if (!models.has(modelPath)) {
    models.set(
      modelPath,
      validateEdgerV2PolicyModel(JSON.parse(fs.readFileSync(modelPath, "utf8"))),
    );
  }
  return models.get(modelPath);
}

// One game of a Fireball capture-value branch set (ninth comparison, Stage 1):
// the unforced game, which must reproduce its recorded hashes, then one
// forced game per opportunity class whose first decision did not capture.
function matchSummary(match) {
  return {
    candidate_point: match.candidate_point,
    winner: match.winner,
    reason: match.reason,
    tick: match.tick,
    score: match.score,
    action_stream_hash: match.action_stream_hash,
    final_state_hash: match.final_state_hash,
  };
}

export function runFireballBranchSpec(spec) {
  const wallStarted = performance.now();
  const model = loadModel(spec.model_path);
  const game = {
    seed: spec.seed,
    candidateActor: spec.candidate_actor,
    model,
    cadence: spec.cadence,
    opponentBotId: spec.opponent,
  };
  const own = runEdgerV2CadenceMatch({ ...game, fireballOpportunityLog: true });
  const output = {
    spec_id: spec.spec_id,
    pair_id: spec.pair_id,
    match_index: spec.match_index ?? null,
    seed: spec.seed,
    candidate_actor: spec.candidate_actor,
    opponent: spec.opponent,
    own: matchSummary(own),
    identity: own.action_stream_hash === spec.expected_action_stream_hash &&
      own.final_state_hash === spec.expected_final_state_hash &&
      own.candidate_point === spec.expected_candidate_point,
    classes: {},
  };
  if (output.identity) {
    for (const [category, first] of Object.entries(own.fireball_opportunities)) {
      if (first === null) {
        output.classes[category] = { opportunity: false };
        continue;
      }
      output.classes[category] = { opportunity: true, first, branched: !first.own_captures };
      if (first.own_captures) {
        continue;
      }
      const branch = runEdgerV2CadenceMatch({
        ...game,
        forcedFireball: { decision_index: first.decision_index, category },
      });
      if (!branch.forced_fireball) {
        throw new Error(`forced ${category} decision ${first.decision_index} was never reached`);
      }
      output.classes[category].forced = {
        ...matchSummary(branch),
        cast: branch.forced_fireball,
        delta: branch.candidate_point - own.candidate_point,
      };
    }
  }
  output.wall_seconds = (performance.now() - wallStarted) / 1000;
  return output;
}

export function runCadenceSpec(spec) {
  if (spec.kind === "fireball-branch") {
    return runFireballBranchSpec(spec);
  }
  const wallStarted = performance.now();
  const model = loadModel(spec.model_path);
  // A model opponent (snapshot league or head-to-head); `opponent` is then
  // only its label.
  const opponentModel = spec.opponent_model_path ? loadModel(spec.opponent_model_path) : null;
  const match = runEdgerV2CadenceMatch({
    seed: spec.seed,
    candidateActor: spec.candidate_actor,
    model,
    cadence: spec.cadence,
    opponentBotId: spec.opponent,
    opponentModel,
    mode: spec.kind === "collect" ? "sample" : "deterministic",
    recordRows: spec.kind === "collect",
    probeStride: spec.kind === "probe" ? spec.probe_stride : 0,
    rewardVersion: spec.reward_version ?? EDGER_V2_CADENCE_REWARD_VERSION,
    recordFireballAim: spec.kind === "collect" && spec.fireball_aim === true,
  });
  const { rows, probes, ...summary } = match;
  const output = {
    ...summary,
    spec_id: spec.spec_id,
    pair_id: spec.pair_id,
    match_index: spec.match_index ?? null,
    ...(opponentModel ? { opponent_model_sha256: spec.opponent_model_sha256 } : {}),
  };
  if (spec.kind === "collect") {
    const { header, body } = encodeCadenceEpisode({
      rows,
      rewardVersion: spec.reward_version ?? EDGER_V2_CADENCE_REWARD_VERSION,
      meta: {
        episode_id: spec.episode_id,
        seed: spec.seed,
        candidate_actor: spec.candidate_actor,
        opponent: spec.opponent,
        // Snapshot games name the critic stratum explicitly and bind the
        // opponent actor; every other header is unchanged.
        ...(opponentModel
          ? { opponent_stratum: spec.opponent_stratum, opponent_model_sha256: spec.opponent_model_sha256 }
          : {}),
        cadence: spec.cadence,
        mode: "sample",
        sampling_temperature: 1,
        model_sha256: spec.model_sha256,
        ...(model.action_space_version === EDGER_FULL_GRID_ACTION_SPACE_VERSION
          ? { action_space_version: model.action_space_version }
          : {}),
        result: { tick: match.tick, winner: match.winner, reason: match.reason, score: match.score },
      },
    });
    fs.mkdirSync(spec.out_dir, { recursive: true });
    const headerPath = path.join(spec.out_dir, `${spec.episode_id}.json`);
    fs.writeFileSync(path.join(spec.out_dir, `${spec.episode_id}.bin`), body);
    fs.writeFileSync(headerPath, `${JSON.stringify(header)}\n`);
    output.header = headerPath;
    output.rows = rows.length;
    output.play_rows = rows.filter((row) => row.card_index !== 0).length;
    output.bytes = body.length;
  }
  if (spec.kind === "probe") {
    output.probes = probes;
  }
  // Node 20 has no per-thread CPU clock; each worker owns one core, so wall
  // time per match is the compute-cost measure.
  output.wall_seconds = (performance.now() - wallStarted) / 1000;
  return output;
}

if (parentPort) {
  if (os.endianness() !== "LE") {
    throw new Error("cadence trajectories are written little-endian only");
  }
  parentPort.on("message", (message) => {
    if (message.type === "stop") {
      parentPort.close();
      return;
    }
    try {
      parentPort.postMessage({ ok: true, result: runCadenceSpec(message.spec) });
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        spec_id: message.spec?.spec_id,
        error: error instanceof Error ? error.stack : String(error),
      });
    }
  });
}
