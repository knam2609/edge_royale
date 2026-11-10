import fs from "node:fs";
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

export function runCadenceSpec(spec) {
  const wallStarted = performance.now();
  const match = runEdgerV2CadenceMatch({
    seed: spec.seed,
    candidateActor: spec.candidate_actor,
    model: loadModel(spec.model_path),
    cadence: spec.cadence,
    opponentBotId: spec.opponent,
    mode: spec.kind === "collect" ? "sample" : "deterministic",
    recordRows: spec.kind === "collect",
    probeStride: spec.kind === "probe" ? spec.probe_stride : 0,
    rewardVersion: spec.reward_version ?? EDGER_V2_CADENCE_REWARD_VERSION,
  });
  const { rows, probes, ...summary } = match;
  const output = {
    ...summary,
    spec_id: spec.spec_id,
    pair_id: spec.pair_id,
    match_index: spec.match_index ?? null,
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
        cadence: spec.cadence,
        mode: "sample",
        sampling_temperature: 1,
        model_sha256: spec.model_sha256,
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
