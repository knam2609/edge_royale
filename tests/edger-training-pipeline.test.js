import test from "node:test";
import assert from "node:assert/strict";

import { createRng } from "../src/sim/random.js";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import { sampleMaskedActionIndex } from "../scripts/edger-training-core.mjs";
import {
  checkPromotionReport,
  evaluateScenarioLeague,
  evaluateTiming,
  wilsonLowerBound,
} from "../scripts/edger-evaluation-core.mjs";

test("masked policy sampling is deterministic for a seeded RNG", () => {
  const first = createRng(1234);
  const second = createRng(1234);
  const logits = [-2, 0, 4, 1];

  assert.deepEqual(
    sampleMaskedActionIndex({ logits, rng: first, temperature: 0.75 }),
    sampleMaskedActionIndex({ logits, rng: second, temperature: 0.75 }),
  );
});

test("Wilson lower bound reflects confidence, not only point win rate", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(13, 20) < 0.65);
  assert.ok(wilsonLowerBound(30, 30) > 0.88);
});

test("scenario league reports heuristic-relative categories", () => {
  const report = evaluateScenarioLeague(EDGER_POLICY_MODEL);

  assert.ok(typeof report.candidate_aggregate === "number");
  assert.ok(typeof report.heuristic_aggregate === "number");
  for (const category of ["defense", "spell_value", "tower_finishing", "elixir_punishment", "pocket_pressure"]) {
    assert.ok(report.categories[category], `missing ${category}`);
    assert.ok(typeof report.categories[category].passed === "boolean");
  }
});

test("timing report includes p95 and budget fields", () => {
  const timing = evaluateTiming(EDGER_POLICY_MODEL, { samples: 3, budgetMs: 5 });

  assert.equal(timing.samples, 3);
  assert.equal(timing.budget_ms, 5);
  assert.ok(Number.isFinite(timing.p95_ms));
  assert.ok(Number.isFinite(timing.max_ms));
});

test("promotion report refuses failed gates", () => {
  const result = checkPromotionReport({
    gates: {
      schema: { passed: true },
      benchmark: { passed: false, reason: "benchmark gate failed" },
    },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ["benchmark: benchmark gate failed"]);
});
