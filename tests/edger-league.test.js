import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { EDGER_BOT_ID, HEURISTIC_BOT_ID } from "../src/ai/botRuntime.js";
import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";
import {
  deriveDecisionSequence,
  loadTrainingEpisode,
} from "../scripts/edger-corpus-core.mjs";
import {
  LEAGUE_MODEL_OPPONENT_STRATUM,
  leagueOpponentStratum,
  makeMatchSpecs,
} from "../scripts/edger-league-core.mjs";

const LIVE_V1_MODEL = path.resolve("artifacts/edger-training/promoted/edger_policy_current.json");

test("league model opponents share the edger stratum and bots keep their id", () => {
  assert.equal(LEAGUE_MODEL_OPPONENT_STRATUM, EDGER_BOT_ID);
  assert.equal(
    leagueOpponentStratum({ kind: "model", policy_id: "edger_policy_bootstrap_20260701" }),
    EDGER_BOT_ID,
  );
  assert.equal(
    leagueOpponentStratum({ kind: "model", policy_id: "historical_anchor_0" }),
    EDGER_BOT_ID,
  );
  assert.equal(
    leagueOpponentStratum({ kind: "bot", policy_id: HEURISTIC_BOT_ID }),
    HEURISTIC_BOT_ID,
  );
  assert.throws(() => leagueOpponentStratum({ policy_id: HEURISTIC_BOT_ID }), /kind/);
  assert.throws(() => leagueOpponentStratum({ kind: "bot" }), /policy_id/);
});

test("the league scheduler reproduces the September allocation and maps every opponent to a stratum", () => {
  const champion = { kind: "model", policy_id: "edger_policy_bootstrap_20260701", score: 0.5 };
  const league = { champion, historical: [], contenders: [] };
  const specs = makeMatchSpecs({ matches: 1000, seed: 20260718, league });
  assert.deepEqual(makeMatchSpecs({ matches: 1000, seed: 20260718, league }), specs);
  const pairs = specs.filter((spec) => spec.main_actor === "blue");
  assert.equal(pairs.length, 500);
  assert.equal(pairs.filter((spec) => spec.opponent === champion).length, 396);
  assert.equal(pairs.filter((spec) => spec.opponent.policy_id === HEURISTIC_BOT_ID).length, 104);
  for (let index = 0; index < specs.length; index += 2) {
    assert.equal(specs[index].seed, specs[index + 1].seed);
    assert.equal(specs[index].opponent, specs[index + 1].opponent);
    assert.deepEqual([specs[index].main_actor, specs[index + 1].main_actor], ["blue", "red"]);
  }
  const strata = new Set(specs.map((spec) => leagueOpponentStratum(spec.opponent)));
  assert.deepEqual([...strata].sort(), [EDGER_BOT_ID, HEURISTIC_BOT_ID]);
});

function runLeagueWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../scripts/edger-league-worker.mjs", import.meta.url),
      { workerData },
    );
    worker.once("message", (message) => {
      if (message.ok) {
        resolve(message.results);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once("error", reject);
  });
}

test("league rollouts record the edger stratum for model opponents and keep their ids in provenance", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-league-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainModel = createEdgerV2BootstrapModel();
  const mainModelPath = path.join(root, "main.json");
  fs.writeFileSync(mainModelPath, JSON.stringify(mainModel));
  const liveModel = JSON.parse(fs.readFileSync(LIVE_V1_MODEL, "utf8"));
  const modelOpponent = {
    kind: "model",
    policy_id: liveModel.model_id,
    checkpoint_id: "live-checkpoint",
    model_path: LIVE_V1_MODEL,
    league_rating: null,
    score: 0.5,
  };
  const botOpponent = {
    kind: "bot",
    policy_id: HEURISTIC_BOT_ID,
    checkpoint_id: null,
    league_rating: null,
  };
  const specs = [
    { match_index: 0, pair_index: 0, seed: 20261120, main_actor: "blue", allocation_bucket: "champion", opponent: modelOpponent },
    { match_index: 1, pair_index: 1, seed: 20261121, main_actor: "red", allocation_bucket: "heuristic", opponent: botOpponent },
  ];
  const results = await runLeagueWorker({
    mainModelPath,
    mainPolicyId: mainModel.model_id,
    mainCheckpointId: null,
    mainLeagueRating: null,
    temperature: 1,
    store: path.join(root, "store"),
    specs,
  });

  assert.deepEqual(
    results.map((result) => [result.opponent, result.opponent_stratum]),
    [[liveModel.model_id, EDGER_BOT_ID], [HEURISTIC_BOT_ID, HEURISTIC_BOT_ID]],
  );
  for (const [index, result] of results.entries()) {
    const episode = loadTrainingEpisode(result.uri);
    const opponentActor = specs[index].main_actor === "blue" ? "red" : "blue";
    const strata = new Set(episode.decision_stream.map((decision) => decision.opponent_stratum));
    assert.deepEqual([...strata], [result.opponent_stratum]);
    assert.equal(episode.policies[opponentActor].policy_id, specs[index].opponent.policy_id);
    assert.equal(episode.policies[opponentActor].checkpoint_id, specs[index].opponent.checkpoint_id);
    const samples = deriveDecisionSequence(episode).samples;
    assert.ok(samples.length > 0);
    assert.ok(samples.every((sample) => sample.opponent_stratum === result.opponent_stratum));
  }
});
