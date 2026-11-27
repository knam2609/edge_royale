import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark, runBenchmarkMatrix, runBotMatch, runEdgerBenchmarkSuite } from "../src/ai/benchmark.js";
import { EDGER_BOT_ID, HEURISTIC_BOT_ID, INTERNAL_BASELINE_BOTS } from "../src/ai/botRuntime.js";
import { EDGER_RETIRED_V1_MODEL } from "../scripts/edger-harness-opponents.mjs";

const SMOKE_MAX_TICKS = 120;

test("bot match smoke run returns structured score payload", () => {
  const match = runBotMatch({
    blueBot: EDGER_BOT_ID,
    redBot: "random",
    seed: 404,
    maxTicks: SMOKE_MAX_TICKS,
  });

  assert.ok(["blue", "red", null].includes(match.result?.winner ?? null));
  assert.ok(typeof match.tick === "number" && match.tick > 0);
  assert.ok(typeof match.score.blue_tower_hp === "number");
  assert.ok(typeof match.score.red_tower_hp === "number");
  assert.ok(match.tick <= SMOKE_MAX_TICKS);
});

test("benchmark output is deterministic for same seed and config", () => {
  const config = {
    botA: EDGER_BOT_ID,
    botB: "aggressive",
    seed: 707,
    rounds: 2,
    maxTicks: SMOKE_MAX_TICKS,
  };

  const first = runBenchmark(config);
  const second = runBenchmark(config);

  assert.deepEqual(first, second);
  assert.equal(first.rounds, config.rounds);
  assert.equal(first.winsA + first.winsB + first.draws, config.rounds);
  assert.ok(first.resolved >= 0);
});

test("benchmark matrix is deterministic and enumerates pairwise bots", () => {
  const config = {
    bots: [EDGER_BOT_ID, HEURISTIC_BOT_ID, "random"],
    seed: 202,
    roundsPerPair: 1,
    maxTicks: SMOKE_MAX_TICKS,
  };

  const first = runBenchmarkMatrix(config);
  const second = runBenchmarkMatrix(config);

  assert.deepEqual(first, second);
  assert.equal(first.pairs.length, 3);
  assert.ok(first.pairs.every((pair) => pair.rounds === config.roundsPerPair));
});

test("short benchmark smoke run preserves accounting invariants", () => {
  const result = runBenchmark({
    botA: EDGER_BOT_ID,
    botB: "random",
    rounds: 2,
    seed: 202,
    maxTicks: SMOKE_MAX_TICKS,
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.winsA + result.winsB + result.draws, 2);
  assert.ok(result.resolved >= 0);
  assert.ok(result.winRateA >= 0 && result.winRateA <= 1);
});

test("benchmark suite can evaluate Edger against frozen heuristic", () => {
  const suite = runEdgerBenchmarkSuite({
    opponents: ["heuristic"],
    seed: 303,
    roundsPerOpponent: 1,
    maxTicks: SMOKE_MAX_TICKS,
  });

  assert.deepEqual(suite.opponents, [HEURISTIC_BOT_ID]);
  assert.equal(suite.pairs.length, 1);
  assert.equal(suite.pairs[0].opponent, HEURISTIC_BOT_ID);
  assert.equal(suite.pairs[0].rounds, 1);
});

test("Edger clears the initial internal baseline benchmark floor", () => {
  const suite = runEdgerBenchmarkSuite({
    opponents: INTERNAL_BASELINE_BOTS,
    seed: 20260630,
    roundsPerOpponent: 30,
    maxTicks: 6040,
  });

  assert.deepEqual(suite.opponents, INTERNAL_BASELINE_BOTS);
  assert.equal(suite.arena, "production");
  for (const pair of suite.pairs) {
    assert.ok(pair.resolved > 0, `${pair.opponent} produced no resolved games`);
    assert.ok(pair.win_rate >= 0.6, `${pair.opponent} win rate ${pair.win_rate}`);
    assert.equal(pair.off_list, 0, `${pair.opponent}: Edger played outside its own legal list`);
  }
});

// The single-tower arena still plays the games it played before the gate moved
// (values from the pre-change code, November 28, 2026): the legacy v1 evaluator
// passes its v1 model there, and selectBotDecision keeps every non-v2 bot's
// delay roll before its selection.
test("the benchmark arena keeps the legacy v1 evaluator's and the baselines' games", () => {
  const v1 = runBotMatch({
    blueBot: EDGER_BOT_ID,
    redBot: "aggressive",
    seed: 707,
    maxTicks: 6040,
    edgerModel: EDGER_RETIRED_V1_MODEL,
    arena: "benchmark",
  });
  assert.equal(v1.tick, 3600);
  assert.equal(v1.result.winner, "blue");
  assert.deepEqual(v1.score, { blue_crowns: 1, red_crowns: 0, blue_tower_hp: 1534, red_tower_hp: 0 });
  assert.deepEqual(v1.off_list, { blue: 0, red: 0 });

  const bots = runBotMatch({ blueBot: "aggressive", redBot: "defender", seed: 505, maxTicks: 6040, arena: "benchmark" });
  assert.equal(bots.tick, 6000);
  assert.equal(bots.result.winner, null);
  assert.deepEqual(bots.score, { blue_crowns: 1, red_crowns: 1, blue_tower_hp: 0, red_tower_hp: 0 });
});

test("the benchmark counts Edger plays outside its own legal list", () => {
  // The full-grid decoder's tile centres are not in the benchmark arena's list.
  const benchmarkArena = runBotMatch({ blueBot: EDGER_BOT_ID, redBot: "random", seed: 404, maxTicks: 600, arena: "benchmark" });
  assert.ok(benchmarkArena.off_list.blue > 0);
  const production = runBotMatch({ blueBot: EDGER_BOT_ID, redBot: "random", seed: 404, maxTicks: 600 });
  assert.deepEqual(production.off_list, { blue: 0, red: 0 });
  assert.throws(() => runBotMatch({ blueBot: EDGER_BOT_ID, redBot: "random", seed: 1, arena: "elsewhere" }), /unknown benchmark arena/);
});
