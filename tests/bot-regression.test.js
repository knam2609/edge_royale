import test from "node:test";
import assert from "node:assert/strict";

import { runBenchmark, runBenchmarkMatrix, runBotMatch, runEdgerBenchmarkSuite } from "../src/ai/benchmark.js";
import { EDGER_BOT_ID, INTERNAL_BASELINE_BOTS } from "../src/ai/botRuntime.js";

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
    bots: [EDGER_BOT_ID, "random", "aggressive"],
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

test("Edger clears the initial internal baseline benchmark floor", () => {
  const suite = runEdgerBenchmarkSuite({
    opponents: INTERNAL_BASELINE_BOTS,
    seed: 20260630,
    roundsPerOpponent: 30,
    maxTicks: 6040,
  });

  assert.deepEqual(suite.opponents, INTERNAL_BASELINE_BOTS);
  for (const pair of suite.pairs) {
    assert.ok(pair.resolved > 0, `${pair.opponent} produced no resolved games`);
    assert.ok(pair.win_rate >= 0.6, `${pair.opponent} win rate ${pair.win_rate}`);
  }
});
