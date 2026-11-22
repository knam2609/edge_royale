import test from "node:test";
import assert from "node:assert/strict";

import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import {
  checkPromotionReport,
  evaluateScenarioLeague,
  evaluateScenarioFeasibility,
  evaluateTiming,
  wilsonLowerBound,
} from "../scripts/edger-evaluation-core.mjs";
import {
  createEdgerV2BootstrapModel,
  getEdgerV2ActorParameterCount,
} from "../src/ai/v2/policy.js";

test("v2 shadow actor stays below the deployment parameter cap", () => {
  const model = createEdgerV2BootstrapModel();
  assert.equal(model.schema_version, "edger_policy_model_v2");
  assert.ok(getEdgerV2ActorParameterCount(model) < 50_000);
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

test("every tactical minimum is reachable with a legal action and the fixed deck", () => {
  const report = evaluateScenarioFeasibility();
  assert.equal(report.passed, true, JSON.stringify(report));
  const spell = report.scenarios.find((scenario) => scenario.category === "spell_value");
  assert.equal(spell.minimum, 0.7);
  assert.equal(spell.maximum_score, 0.96);
  assert.equal(spell.best_action.cardId, "arrows");
  for (const scenario of report.scenarios) {
    assert.equal(scenario.valid_fixed_decks, true);
    assert.equal(scenario.production_arena, true);
    assert.ok(scenario.maximum_score >= scenario.minimum);
  }
  const impossible = evaluateScenarioFeasibility({ minimums: { spell_value: 1.3 } });
  assert.equal(impossible.passed, false);
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

test("tactical pass means every category minimum is met; beating the heuristic is reported only", () => {
  const strict = evaluateScenarioLeague(EDGER_POLICY_MODEL);
  // Live v1 misses the spell, finishing and pocket minimums.
  assert.equal(strict.passed, false);
  assert.equal(strict.categories.spell_value.passed, false);
  const lenient = evaluateScenarioLeague(EDGER_POLICY_MODEL, {
    minimums: { defense: 0, spell_value: 0, tower_finishing: 0, elixir_punishment: 0, pocket_pressure: 0 },
  });
  // Below the heuristic's aggregate, yet passing once every minimum is met.
  assert.ok(lenient.candidate_aggregate < lenient.heuristic_aggregate);
  assert.equal(lenient.improved_over_heuristic, false);
  assert.equal(lenient.passed, true);
});

test("legacy promotion check ignores the reported tactical scenarios", () => {
  const result = checkPromotionReport({
    gates: { schema: { passed: true }, benchmark: { passed: true } },
    scenarios: { passed: false, blocking: false },
  });
  assert.deepEqual(result, { passed: true, failures: [] });
});
