import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  EDGER_V2_EVALUATION_PROFILES,
  buildEdgerV2EvaluationSpecs,
  evaluateEdgerV2Candidate,
  executeEdgerV2EvaluationSpecs,
  pairedBootstrapLowerBound,
  validateExternalCampaignReport,
  validateEdgerV2ReferenceReport,
} from "../scripts/edger-v2-evaluation-core.mjs";
import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";
import { SCENARIO_FIXTURES } from "../scripts/edger-evaluation-core.mjs";
import { OPPORTUNITY_BANK_SCHEMA, opportunityState } from "../scripts/edger-opportunity-bank.mjs";
import { EDGER_COMPATIBILITY_COHORT, canonicalCompactJson, sha256Hex } from "../scripts/edger-corpus-core.mjs";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";

const CHAMPION_MODEL = "artifacts/edger-training/promoted/edger_policy_current.json";

// The bootstrap actor always passes. This one plays: PASS is penalised and
// Fireball preferred whenever legal; zero weights aim at the lowest-index
// tile, so its Fireballs mostly miss.
function playingModel() {
  const model = createEdgerV2BootstrapModel({ modelId: "reported-skills-test" });
  model.weights.card_head.bias.splice(0, 9, -2, 0, 0, 0, 0, 0, 0, 0, 1);
  return model;
}

// A valid two-entry bank (one lethal, one cluster) from the tactical fixtures,
// as in tests/edger-tactical-scoring.test.js. Validation and scoring only.
function writeUnitBank(filePath) {
  const digest = (value) => sha256Hex(canonicalCompactJson(value));
  const episodeId = "0000005a" + "0".repeat(56); // stable split bucket 90
  const fixture = (id) => SCENARIO_FIXTURES.find((f) => f.id === id);
  const bank = {
    schema_version: OPPORTUNITY_BANK_SCHEMA,
    compatibility_cohort: EDGER_COMPATIBILITY_COHORT,
    source_manifest_hash: "a".repeat(64),
    sampling: "first_per_episode_actor_class_v1",
    opportunity_rule: { tower_damage: FIREBALL_CONFIG.tower_damage, radius_tiles: FIREBALL_CONFIG.radius_tiles, cluster_troops: 3, lethal_first: true },
    episodes: [{ episode_id: episodeId, checksum: "b".repeat(64), replay_checksum: "c".repeat(64) }],
    entries: ["finish_low_tower", "spell_cluster_value"].map((id) => {
      const state = opportunityState(fixture(id).makeEngine());
      return { episode_id: episodeId, tick: 1, actor: "red", category: id === "finish_low_tower" ? "lethal" : "cluster", state, state_sha256: digest(state) };
    }),
  };
  bank.bank_sha256 = digest(bank);
  fs.writeFileSync(filePath, JSON.stringify(bank));
}

const PROMOTION_GATE_NAMES = [
  "acceptance_profile",
  "schema_and_size",
  "pytorch_js_parity",
  "champion",
  "anchors",
  "weak_baselines",
  "frozen_league",
  "safety",
  "skill_report_inputs",
  "replay",
  "generated_js_timing",
  "full_test_suite",
  "browser_smoke",
];

// A full report that passes every gate, bound to the model's ID and checksum.
// Its reported sections fall short of every tactical and Fireball minimum.
function passingPromotionReport(model, checksum) {
  return {
    schema_version: "edger_v2_evaluation_report_v2",
    profile: "full",
    candidate_model_id: model.model_id,
    candidate_artifact_checksum: checksum,
    matchups: {},
    frozen_league_mean: 0.5,
    gates: Object.fromEntries(PROMOTION_GATE_NAMES.map((name) => [name, { passed: true }])),
    reported: {
      tactical_scenarios: {
        blocking: false, minimums_met: false, candidate_aggregate: 0.3, heuristic_aggregate: 0.852,
        categories: { spell_value: { candidate_score: 0, minimum_met: false } },
      },
      heldout_fireball: {
        blocking: false, minimums_met: false,
        categories: { lethal: { count: 27, candidate_captures: 0 }, cluster: { count: 53, candidate_captures: 0 } },
      },
      match_skills: {
        blocking: false,
        pooled_excluding_safety: {
          games: 2,
          deployments_per_game: { fireball: 0, giant: 0.5 },
          fireball_opportunities: { lethal: { captures: 0, decisions: 3, games_with_capture: 0, games_with_opportunity: 1 } },
        },
      },
    },
    promotion: { passed: true, failures: [] },
  };
}

function modelDescriptor(policyId) {
  return {
    kind: "model",
    policy_id: policyId,
    checkpoint_id: policyId,
    model_path: `/tmp/${policyId}.json`,
  };
}

test("full v2 evaluation plan contains both champion blocks and 10,000 repeated safety games", () => {
  const profile = EDGER_V2_EVALUATION_PROFILES.full;
  const specs = buildEdgerV2EvaluationSpecs({
    seed: 7401,
    profile,
    champion: modelDescriptor("champion"),
    heuristic: { kind: "bot", policy_id: "edger_heuristic" },
    anchors: [0, 1, 2, 3].map((index) => modelDescriptor(`anchor_${index}`)),
    weakBaselines: ["random", "aggressive", "defender"].map((policyId) => ({
      kind: "bot",
      policy_id: policyId,
    })),
  });
  const safety = specs.filter((spec) => spec.group === "safety");
  const champion = specs.filter((spec) => spec.group === "champion");

  assert.equal(safety.length, 10_000);
  assert.equal(new Set(safety.map((spec) => spec.repeat_id)).size, 5_000);
  assert.ok(
    [...new Set(safety.map((spec) => spec.repeat_id))].every(
      (repeatId) => safety.filter((spec) => spec.repeat_id === repeatId).length === 2,
    ),
  );
  assert.equal(champion.length, 800);
  assert.equal(champion.filter((spec) => spec.block === "A").length, 400);
  assert.equal(champion.filter((spec) => spec.block === "B").length, 400);
});

test("paired bootstrap lower bound uses whole paired seeds", () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    pair_id: `pair_${Math.floor(index / 2)}`,
    candidate_point: 1,
  }));
  assert.equal(
    pairedBootstrapLowerBound(results, { seed: 7, resamples: 100 }),
    1,
  );
});

test("v2 references are bound to the evaluated champion", () => {
  const reference = {
    schema_version: "edger_v2_reference_report_v1",
    model_id: "champion_a",
    matchups: {},
    frozen_league_mean: 0.5,
  };
  assert.equal(
    validateEdgerV2ReferenceReport(reference, {
      championModelId: "champion_a",
    }),
    reference,
  );
  assert.throws(
    () => validateEdgerV2ReferenceReport(reference, {
      championModelId: "champion_b",
    }),
    /does not match champion/,
  );
});

test("external test and browser reports are bound to the campaign Git commit", () => {
  const commit = "a".repeat(40);
  assert.equal(
    validateExternalCampaignReport(
      { passed: true, git_commit: commit },
      { label: "browser smoke", expectedGitCommit: commit },
    ).passed,
    true,
  );
  const mismatch = validateExternalCampaignReport(
    { passed: true, git_commit: "b".repeat(40) },
    { label: "browser smoke", expectedGitCommit: commit },
  );
  assert.equal(mismatch.passed, false);
  assert.match(mismatch.reason, /does not match/);
});

test("a missing opportunity bank fails preflight closed; tactical and Fireball results are reported, not gates", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-preflight-"));
  try {
    const candidateModelPath = path.join(root, "candidate.json");
    fs.writeFileSync(candidateModelPath, JSON.stringify(createEdgerV2BootstrapModel()));
    const report = await evaluateEdgerV2Candidate({
      candidateModelPath,
      championModelPath: "artifacts/edger-training/promoted/edger_policy_current.json",
      profileName: "full",
      workers: 1,
    });
    assert.equal(report.schema_version, "edger_v2_evaluation_report_v2");
    assert.equal(report.gates.pytorch_js_parity.passed, true);
    assert.equal(report.gates.tactical_scenarios, undefined);
    assert.equal(report.gates.heldout_fireball, undefined);
    assert.equal(report.gates.skill_report_inputs.passed, false);
    assert.match(report.gates.skill_report_inputs.reason, /opportunity-bank is required/);
    assert.equal(report.reported.tactical_scenarios.blocking, false);
    assert.equal(report.reported.tactical_scenarios.feasibility_passed, true);
    assert.equal(typeof report.reported.tactical_scenarios.minimums_met, "boolean");
    assert.equal(report.reported.tactical_scenarios.passed, undefined);
    assert.equal(report.reported.heldout_fireball.blocking, false);
    assert.match(report.reported.heldout_fireball.reason, /opportunity-bank is required/);
    assert.equal(report.reported.match_skills.pooled_excluding_safety.games, 0);
    assert.equal(report.generated_matches, 0);
    assert.equal(report.match_suite_skipped, true);
    assert.equal(report.promotion.passed, false);
    for (const gate of ["champion", "weak_baselines", "anchors", "frozen_league", "safety", "replay"]) {
      assert.equal(report.gates[gate].passed, false);
      assert.equal(report.gates[gate].skipped, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v2 promotion command refuses an incomplete report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-promote-refusal-"));
  const modelPath = path.join(root, "model.json");
  const reportPath = path.join(root, "report.json");
  const model = createEdgerV2BootstrapModel();
  fs.writeFileSync(modelPath, JSON.stringify(model));
  fs.writeFileSync(reportPath, JSON.stringify({
    schema_version: "edger_v2_evaluation_report_v2",
    profile: "smoke",
    candidate_model_id: model.model_id,
    candidate_artifact_checksum: "wrong",
    gates: {},
    promotion: { passed: false, failures: ["not evaluated"] },
  }));
  const result = spawnSync(process.execPath, [
    "scripts/edger-v2-promote.mjs",
    "--model",
    modelPath,
    "--report",
    reportPath,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only a full evaluation profile can be promoted/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("v2 promotion preserves the exact evaluated model bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-promote-copy-"));
  const modelPath = path.join(root, "candidate.json");
  const reportPath = path.join(root, "report.json");
  const model = createEdgerV2BootstrapModel();
  const modelBytes = Buffer.from(JSON.stringify(model));
  fs.writeFileSync(modelPath, modelBytes);
  const checksum = createHash("sha256").update(modelBytes).digest("hex");
  // The reported sections fall short of every tactical and Fireball minimum,
  // and promotion still proceeds: they are shown for review, not gated.
  fs.writeFileSync(reportPath, JSON.stringify(passingPromotionReport(model, checksum)));
  fs.mkdirSync(path.join(root, "src/ai/generated"), { recursive: true });
  const completeReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const promote = (report) => {
    fs.writeFileSync(reportPath, JSON.stringify(report));
    return spawnSync(process.execPath, [
      path.resolve("scripts/edger-v2-promote.mjs"), "--model", modelPath, "--report", reportPath,
    ], { cwd: root, encoding: "utf8" });
  };
  // A report from before November 20 (schema v1, tactical and Fireball gates)
  // cannot promote.
  const legacyReport = structuredClone(completeReport);
  legacyReport.schema_version = "edger_v2_evaluation_report_v1";
  const legacyResult = promote(legacyReport);
  assert.notEqual(legacyResult.status, 0);
  assert.match(legacyResult.stderr, /report schema must be edger_v2_evaluation_report_v2/);
  // Every reported section must be present.
  for (const name of ["tactical_scenarios", "heldout_fireball", "match_skills"]) {
    const missing = structuredClone(completeReport);
    delete missing.reported[name];
    const missingResult = promote(missing);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, new RegExp(`lacks reported sections: ${name}`));
  }
  const missingInputs = structuredClone(completeReport);
  delete missingInputs.gates.skill_report_inputs;
  const missingInputsResult = promote(missingInputs);
  assert.notEqual(missingInputsResult.status, 0);
  assert.match(missingInputsResult.stderr, /skill_report_inputs/);
  fs.writeFileSync(reportPath, JSON.stringify(completeReport));
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/edger-v2-promote.mjs"),
    "--model",
    modelPath,
    "--report",
    reportPath,
  ], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reported \(not a gate\): tactical aggregate 0\.300 \(heuristic 0\.852\); category minimums met: no/);
  assert.match(result.stdout, /reported \(not a gate\): held-out Fireball captures lethal 0\/27, cluster 0\/53; minimums met: no/);
  assert.match(result.stdout, /reported \(not a gate\): in-match Fireball capture: lethal 0\/3 decisions, 0\/1 games/);
  assert.deepEqual(
    fs.readFileSync(path.join(
      root,
      "artifacts/edger-training/promoted/edger_policy_current.json",
    )),
    modelBytes,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

function diagnosticModel(modelId) {
  const model = createEdgerV2BootstrapModel({ modelId });
  model.training.promotion_status = "diagnostic_only_not_promotable";
  return model;
}

test("v2 promotion refuses a diagnostic export even with a matching, otherwise passing report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-promote-diagnostic-"));
  try {
    fs.mkdirSync(path.join(root, "src/ai/generated"), { recursive: true });
    const promoteWith = (model, name) => {
      const modelPath = path.join(root, `${name}.json`);
      const reportPath = path.join(root, `${name}-report.json`);
      const modelBytes = Buffer.from(JSON.stringify(model));
      fs.writeFileSync(modelPath, modelBytes);
      const checksum = createHash("sha256").update(modelBytes).digest("hex");
      fs.writeFileSync(reportPath, JSON.stringify(passingPromotionReport(model, checksum)));
      return spawnSync(process.execPath, [
        path.resolve("scripts/edger-v2-promote.mjs"), "--model", modelPath, "--report", reportPath,
      ], { cwd: root, encoding: "utf8" });
    };
    const promotedModel = path.join(root, "artifacts/edger-training/promoted/edger_policy_current.json");

    const refused = promoteWith(diagnosticModel("diagnostic-child"), "diagnostic");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /v2 promotion refused: model diagnostic-child is labelled training\.promotion_status=diagnostic_only_not_promotable/);
    assert.equal(fs.existsSync(promotedModel), false);
    assert.equal(fs.readdirSync(path.join(root, "src/ai/generated")).length, 0);

    // The control differs only in the label, so the report really passes.
    const control = diagnosticModel("diagnostic-child");
    control.training.promotion_status = "shadow_candidate_unreviewed";
    const accepted = promoteWith(control, "control");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(fs.readFileSync(promotedModel, "utf8")).training.promotion_status, "shadow_candidate_unreviewed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a full v2 evaluation refuses a diagnostic export before any match", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-evaluate-diagnostic-"));
  try {
    const candidateModelPath = path.join(root, "candidate.json");
    fs.writeFileSync(candidateModelPath, JSON.stringify(diagnosticModel("diagnostic-child")));
    const refusal = /v2 full evaluation refused: model diagnostic-child is labelled training\.promotion_status=diagnostic_only_not_promotable/;
    // An unknown profile name falls back to the full profile, so it is refused too.
    for (const profileName of ["full", "unknown"]) {
      await assert.rejects(
        evaluateEdgerV2Candidate({ candidateModelPath, championModelPath: CHAMPION_MODEL, profileName, workers: 1 }),
        refusal,
      );
    }
    const out = path.join(root, "report.json");
    const result = spawnSync(process.execPath, [
      "scripts/edger-v2-evaluate.mjs", "--candidate", candidateModelPath, "--profile", "full", "--workers", "1", "--out", out,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, refusal);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tactical and Fireball shortfalls no longer stop the match suite; in-match skills are reported", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-reported-skills-"));
  try {
    const candidateModelPath = path.join(root, "candidate.json");
    const bankPath = path.join(root, "bank.json");
    // Labelled like a cadence export: smoke diagnostics of never-promotable
    // models stay allowed, since a smoke report cannot promote.
    const candidate = playingModel();
    candidate.training.promotion_status = "diagnostic_only_not_promotable";
    fs.writeFileSync(candidateModelPath, JSON.stringify(candidate));
    writeUnitBank(bankPath);
    const report = await evaluateEdgerV2Candidate({
      candidateModelPath,
      championModelPath: CHAMPION_MODEL,
      profileName: "smoke",
      workers: 2,
      opportunityBankPath: bankPath,
    });
    // The candidate misses the tactical minimums and captures neither bank
    // opportunity, yet every match gate is evaluated.
    assert.equal(report.reported.tactical_scenarios.minimums_met, false);
    assert.equal(report.reported.heldout_fireball.minimums_met, false);
    assert.equal(report.reported.heldout_fireball.categories.lethal.candidate_card_choices, 1);
    assert.equal(report.reported.heldout_fireball.categories.lethal.candidate_captures, 0);
    assert.equal(report.reported.heldout_fireball.categories.lethal.count, 1);
    assert.equal(typeof report.reported.heldout_fireball.categories.lethal.minimum_met, "boolean");
    assert.equal(report.gates.skill_report_inputs.passed, true);
    assert.equal(report.gates.skill_report_inputs.bank_sha256, JSON.parse(fs.readFileSync(bankPath, "utf8")).bank_sha256);
    assert.equal(report.match_suite_skipped, false);
    assert.ok(report.generated_matches > 0);
    for (const gate of ["champion", "weak_baselines", "anchors", "frozen_league", "safety", "replay"]) {
      assert.notEqual(report.gates[gate].skipped, true, gate);
    }
    assert.ok(report.promotion.failures.every((failure) => !/tactical|fireball/i.test(failure)), report.promotion.failures.join("; "));

    const skills = report.reported.match_skills;
    assert.equal(skills.schema_version, "edger_v2_match_skills_v1");
    assert.equal(skills.blocking, false);
    assert.deepEqual(Object.keys(skills.groups).sort(), ["champion", "heuristic", "safety", "weak:aggressive", "weak:defender", "weak:random"]);
    const nonSafety = Object.entries(skills.groups).filter(([group]) => group !== "safety");
    assert.equal(skills.pooled_excluding_safety.games, nonSafety.reduce((sum, [, group]) => sum + group.games, 0));
    assert.equal(skills.pooled_excluding_safety.games + skills.groups.safety.games, report.generated_matches);
    assert.deepEqual(Object.keys(skills.pooled_excluding_safety.deployments), DEFAULT_DECK);
    const deployed = Object.values(skills.pooled_excluding_safety.deployments).reduce((sum, value) => sum + value, 0);
    assert.ok(deployed > 0);
    assert.ok(skills.pooled_excluding_safety.deployments.fireball > 0);
    for (const entry of Object.values(skills.pooled_excluding_safety.fireball_opportunities)) {
      assert.ok(entry.captures <= entry.fireball_choices && entry.fireball_choices <= entry.decisions);
      assert.ok(entry.games_with_capture <= entry.games_with_opportunity);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill tracking leaves every evaluation game unchanged", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-skill-identity-"));
  try {
    const candidateModelPath = path.join(root, "candidate.json");
    fs.writeFileSync(candidateModelPath, JSON.stringify(playingModel()));
    const specs = buildEdgerV2EvaluationSpecs({
      seed: 20261120,
      profile: EDGER_V2_EVALUATION_PROFILES.smoke,
      champion: { kind: "model", policy_id: "champion", checkpoint_id: null, model_path: path.resolve(CHAMPION_MODEL) },
      heuristic: { kind: "bot", policy_id: "edger_heuristic", checkpoint_id: null },
      anchors: [],
      weakBaselines: ["random", "aggressive", "defender"].map((policyId) => ({ kind: "bot", policy_id: policyId, checkpoint_id: null })),
    }).filter((spec) => spec.group !== "safety");
    const plain = await executeEdgerV2EvaluationSpecs({ candidateModelPath, specs, workers: 2 });
    const tracked = await executeEdgerV2EvaluationSpecs({ candidateModelPath, specs, workers: 2, trackSkills: true });
    assert.equal(plain.length, specs.length);
    assert.ok(plain.every((result) => !("skill" in result)));
    assert.ok(tracked.every((result) => result.skill));
    assert.deepEqual(tracked.map(({ skill, ...rest }) => rest), plain);
    let opportunityDecisions = 0;
    for (const result of tracked) {
      const deployed = Object.values(result.skill.deployments).reduce((sum, value) => sum + value, 0);
      assert.ok(deployed > 0 && deployed <= result.action_count, `spec ${result.spec_id}`);
      opportunityDecisions += result.skill.fireball_opportunities.lethal.decisions +
        result.skill.fireball_opportunities.cluster.decisions;
    }
    assert.ok(opportunityDecisions > 0, "the games must meet Fireball opportunities for this to test anything");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
