import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  HEURISTIC_BOT_ID,
  enumerateLegalCardActions,
} from "../src/ai/botRuntime.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  getEdgerV2ActorParameterCount,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  evaluateScenarioLeague,
  evaluateTiming,
} from "./edger-evaluation-core.mjs";
import { spawnNativePython } from "./python-runtime.mjs";

export const EDGER_V2_EVALUATION_REPORT_SCHEMA = "edger_v2_evaluation_report_v1";
export const EDGER_V2_REFERENCE_REPORT_SCHEMA = "edger_v2_reference_report_v1";

export const EDGER_V2_EVALUATION_PROFILES = Object.freeze({
  full: Object.freeze({
    champion_games: 800,
    heuristic_games: 200,
    anchor_games: 200,
    weak_games: 100,
    safety_games: 10_000,
    bootstrap_resamples: 10_000,
    replay_checks: 100,
    acceptance_profile: true,
  }),
  smoke: Object.freeze({
    champion_games: 4,
    heuristic_games: 2,
    anchor_games: 2,
    weak_games: 2,
    safety_games: 4,
    bootstrap_resamples: 200,
    replay_checks: 2,
    acceptance_profile: false,
  }),
});

export function validateEdgerV2ReferenceReport(
  reference,
  { championModelId = null } = {},
) {
  if (
    !reference ||
    typeof reference !== "object" ||
    reference.schema_version !== EDGER_V2_REFERENCE_REPORT_SCHEMA
  ) {
    throw new Error(
      `reference report schema must be ${EDGER_V2_REFERENCE_REPORT_SCHEMA}`,
    );
  }
  if (!reference.model_id || typeof reference.matchups !== "object") {
    throw new Error("reference report requires model_id and matchups");
  }
  if (!Number.isFinite(reference.frozen_league_mean)) {
    throw new Error("reference report frozen_league_mean must be finite");
  }
  if (championModelId && reference.model_id !== championModelId) {
    throw new Error(
      `reference report model ${reference.model_id} does not match champion ${championModelId}`,
    );
  }
  return reference;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function descriptorForModel(modelPath) {
  const resolved = path.resolve(modelPath);
  const model = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    kind: "model",
    policy_id: model.model_id,
    checkpoint_id: model.training?.checkpoint_id ?? null,
    model_path: resolved,
  };
}

function descriptorForBot(policyId) {
  return {
    kind: "bot",
    policy_id: policyId,
    checkpoint_id: null,
  };
}

function makePairedSpecs({
  specs,
  group,
  block = null,
  games,
  opponent,
  rng,
  replayBudget,
}) {
  const pairs = games / 2;
  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    const seed = 1 + Math.floor(rng() * 2_000_000_000);
    const pairId = `${group}|${block ?? "all"}|${pairIndex}`;
    for (const candidateActor of ["blue", "red"]) {
      specs.push({
        spec_id: specs.length,
        group,
        block,
        pair_id: pairId,
        seed,
        candidate_actor: candidateActor,
        opponent,
        verify_replay: replayBudget.remaining-- > 0,
      });
    }
  }
}

export function buildEdgerV2EvaluationSpecs({
  seed,
  profile,
  champion,
  heuristic,
  anchors,
  weakBaselines,
}) {
  const rng = createRng(seed);
  const specs = [];
  const replayBudget = { remaining: profile.replay_checks };
  makePairedSpecs({
    specs,
    group: "champion",
    block: "A",
    games: profile.champion_games / 2,
    opponent: champion,
    rng,
    replayBudget,
  });
  makePairedSpecs({
    specs,
    group: "champion",
    block: "B",
    games: profile.champion_games / 2,
    opponent: champion,
    rng,
    replayBudget,
  });
  makePairedSpecs({
    specs,
    group: "heuristic",
    games: profile.heuristic_games,
    opponent: heuristic,
    rng,
    replayBudget,
  });
  for (const anchor of anchors) {
    makePairedSpecs({
      specs,
      group: `anchor:${anchor.policy_id}`,
      games: profile.anchor_games,
      opponent: anchor,
      rng,
      replayBudget,
    });
  }
  for (const weak of weakBaselines) {
    makePairedSpecs({
      specs,
      group: `weak:${weak.policy_id}`,
      games: profile.weak_games,
      opponent: weak,
      rng,
      replayBudget,
    });
  }

  const safetyOpponents = [heuristic, ...weakBaselines];
  for (let repeatIndex = 0; repeatIndex < profile.safety_games / 2; repeatIndex += 1) {
    const safetySeed = 1 + Math.floor(rng() * 2_000_000_000);
    const opponent = safetyOpponents[repeatIndex % safetyOpponents.length];
    const candidateActor = repeatIndex % 2 === 0 ? "blue" : "red";
    for (let repeatId = 0; repeatId < 2; repeatId += 1) {
      specs.push({
        spec_id: specs.length,
        group: "safety",
        block: null,
        pair_id: null,
        repeat_id: `safety|${repeatIndex}`,
        seed: safetySeed,
        candidate_actor: candidateActor,
        opponent,
        verify_replay: replayBudget.remaining-- > 0,
      });
    }
  }
  return specs;
}

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./edger-v2-evaluation-worker.mjs", import.meta.url),
      { workerData },
    );
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message.ok) {
        resolve(message.results);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`evaluation worker exited with code ${code}`));
      }
    });
  });
}

export async function executeEdgerV2EvaluationSpecs({
  candidateModelPath,
  specs,
  workers,
}) {
  const partitions = Array.from(
    { length: Math.min(workers, specs.length) },
    () => [],
  );
  specs.forEach((spec, index) => {
    partitions[index % partitions.length].push(spec);
  });
  const results = (
    await Promise.all(
      partitions.map((partition) =>
        runWorker({
          candidateModelPath: path.resolve(candidateModelPath),
          specs: partition,
        })),
    )
  ).flat();
  return results.sort((left, right) => left.spec_id - right.spec_id);
}

function lowerPercentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.floor((ordered.length - 1) * fraction));
  return ordered[index] ?? 0;
}

export function pairedBootstrapLowerBound(
  results,
  { seed = 1, resamples = 10_000 } = {},
) {
  const pairs = new Map();
  for (const result of results) {
    if (!result.pair_id) {
      continue;
    }
    const values = pairs.get(result.pair_id) ?? [];
    values.push(result.candidate_point);
    pairs.set(result.pair_id, values);
  }
  const pairScores = [...pairs.values()].map(
    (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
  );
  if (pairScores.length === 0) {
    return 0;
  }
  const rng = createRng(seed);
  const bootstrap = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < pairScores.length; index += 1) {
      total += pairScores[Math.floor(rng() * pairScores.length)];
    }
    bootstrap.push(total / pairScores.length);
  }
  return lowerPercentile(bootstrap, 0.025);
}

function summarizeMatchup(results, { bootstrapSeed, bootstrapResamples }) {
  const games = results.length;
  const score = games > 0
    ? results.reduce((sum, result) => sum + result.candidate_point, 0) / games
    : 0;
  const wins = results.filter((result) => result.candidate_point === 1).length;
  const draws = results.filter((result) => result.candidate_point === 0.5).length;
  return {
    games,
    paired_seeds: new Set(results.map((result) => result.pair_id).filter(Boolean)).size,
    wins,
    losses: games - wins - draws,
    draws,
    score,
    paired_bootstrap_95_lower_bound: pairedBootstrapLowerBound(results, {
      seed: bootstrapSeed,
      resamples: bootstrapResamples,
    }),
  };
}

function pass(details = {}) {
  return { passed: true, ...details };
}

function fail(reason, details = {}) {
  return { passed: false, reason, ...details };
}

export function validateExternalCampaignReport(
  report,
  { label, expectedGitCommit },
) {
  if (!report?.passed) {
    return fail(`${label} report failed`);
  }
  if (
    typeof expectedGitCommit !== "string" ||
    expectedGitCommit.length < 7 ||
    report.git_commit !== expectedGitCommit
  ) {
    return fail(`${label} report Git commit does not match the campaign`, {
      expected_git_commit: expectedGitCommit ?? null,
      report_git_commit: report?.git_commit ?? null,
    });
  }
  return pass({ git_commit: report.git_commit });
}

function externalGate(filePath, label, expectedGitCommit) {
  if (!filePath) {
    return fail(`${label} report was not supplied`);
  }
  const report = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const gate = validateExternalCampaignReport(report, {
    label,
    expectedGitCommit,
  });
  return { ...gate, report: path.resolve(filePath) };
}

export function checkCandidateParity(modelPath, model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-eval-parity-"));
  try {
    const engine = createProductionEngine({ seed: 20260718 });
    const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
    const observation = buildEdgerV2Observation({ engine, actor: "red" });
    const masks = buildEdgerV2LegalMasks({
      actor: "red",
      legalActions,
      selectedCardIndex: 0,
    });
    const js = computeEdgerV2Logits({
      model,
      observation,
      legalMasks: masks,
      forcedCardIndex: 0,
      forcedPlacementIndex: 0,
    });
    const fixturePath = path.join(root, "fixture.json");
    const outputPath = path.join(root, "pytorch.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      observation: {
        board: Array.from(observation.board),
        global: Array.from(observation.global),
      },
      legal_masks: {
        card: Array.from(masks.card),
        placement: Array.from(masks.placement),
        delay: Array.from(masks.delay),
      },
      forced_card_index: 0,
      forced_placement_index: 0,
    }));
    const result = spawnNativePython([
      "scripts/edger-v2-training.py",
      "parity",
      "--model",
      path.resolve(modelPath),
      "--fixture",
      fixturePath,
      "--out",
      outputPath,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      return fail("PyTorch parity process failed", { stderr: result.stderr });
    }
    const pytorch = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    let maximumDifference = 0;
    for (const head of ["card", "placement", "delay"]) {
      const jsValues = Array.from(js[head]);
      for (let index = 0; index < jsValues.length; index += 1) {
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(jsValues[index] - pytorch[head][index]),
        );
      }
    }
    const maskedArgmax = (values, mask) => {
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let index = 0; index < values.length; index += 1) {
        if (mask[index] && values[index] > bestValue) {
          bestIndex = index;
          bestValue = values[index];
        }
      }
      return bestIndex;
    };
    const jsArgmax = {
      card: maskedArgmax(js.card, masks.card),
      placement: maskedArgmax(js.placement, masks.placement),
      delay: maskedArgmax(js.delay, masks.delay),
    };
    const pytorchArgmax = {
      card: pytorch.card_argmax,
      placement: pytorch.placement_argmax,
      delay: pytorch.delay_argmax,
    };
    const argmaxAgreement =
      pytorchArgmax.card === jsArgmax.card &&
      pytorchArgmax.placement === jsArgmax.placement &&
      pytorchArgmax.delay === jsArgmax.delay;
    return maximumDifference <= 1e-5 && argmaxAgreement
      ? pass({
          maximum_logit_difference: maximumDifference,
          argmax_agreement: true,
          js_argmax: jsArgmax,
          pytorch_argmax: pytorchArgmax,
        })
      : fail("PyTorch/generated-JS parity exceeded tolerance", {
          maximum_logit_difference: maximumDifference,
          argmax_agreement: argmaxAgreement,
          js_argmax: jsArgmax,
          pytorch_argmax: pytorchArgmax,
        });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function safetyGate(results, requiredMatches) {
  const safety = results.filter((result) => result.group === "safety");
  const repeats = new Map();
  for (const result of safety) {
    const values = repeats.get(result.repeat_id) ?? [];
    values.push(result);
    repeats.set(result.repeat_id, values);
  }
  const repeatFailures = [];
  for (const [repeatId, values] of repeats) {
    if (
      values.length !== 2 ||
      values[0].action_stream_hash !== values[1].action_stream_hash ||
      values[0].final_state_hash !== values[1].final_state_hash
    ) {
      repeatFailures.push(repeatId);
    }
  }
  const illegalActions = safety.reduce((sum, result) => sum + result.illegal_actions, 0);
  const replayFailures = safety.filter(
    (result) => result.replay_checked && !result.replay_passed,
  );
  const passed =
    safety.length >= requiredMatches &&
    illegalActions === 0 &&
    repeatFailures.length === 0 &&
    replayFailures.length === 0;
  return passed
    ? pass({
        games: safety.length,
        repeated_streams: repeats.size,
        illegal_actions: illegalActions,
        replay_checks: safety.filter((result) => result.replay_checked).length,
      })
    : fail("10,000-match legality/repeatability/replay gate failed", {
        games: safety.length,
        required_games: requiredMatches,
        illegal_actions: illegalActions,
        repeat_failures: repeatFailures.slice(0, 20),
        replay_failures: replayFailures.map((result) => result.spec_id).slice(0, 20),
      });
}

export async function evaluateEdgerV2Candidate({
  candidateModelPath,
  championModelPath,
  anchorModelPaths = [],
  referenceReportPath = null,
  testReportPath = null,
  browserReportPath = null,
  profileName = "full",
  seed = 20260718,
  workers = 16,
  referenceHardware = "unspecified",
}) {
  const profile = EDGER_V2_EVALUATION_PROFILES[profileName] ??
    EDGER_V2_EVALUATION_PROFILES.full;
  const candidate = validateEdgerV2PolicyModel(
    JSON.parse(fs.readFileSync(candidateModelPath, "utf8")),
  );
  const campaignGitCommit = candidate.training?.git_commit ?? null;
  const candidateBytes = fs.statSync(candidateModelPath).size;
  const champion = descriptorForModel(championModelPath);
  const anchors = anchorModelPaths.map(descriptorForModel);
  const heuristic = descriptorForBot(HEURISTIC_BOT_ID);
  const weakBaselines = ["random", "aggressive", "defender"].map(descriptorForBot);
  const specs = buildEdgerV2EvaluationSpecs({
    seed,
    profile,
    champion,
    heuristic,
    anchors,
    weakBaselines,
  });
  const results = await executeEdgerV2EvaluationSpecs({
    candidateModelPath,
    specs,
    workers,
  });
  const byGroup = new Map();
  for (const result of results) {
    const list = byGroup.get(result.group) ?? [];
    list.push(result);
    byGroup.set(result.group, list);
  }
  const matchups = {};
  for (const [group, groupResults] of byGroup) {
    if (group === "safety") {
      continue;
    }
    matchups[group] = summarizeMatchup(groupResults, {
      bootstrapSeed: seed ^ group.length,
      bootstrapResamples: profile.bootstrap_resamples,
    });
  }
  const championBlocks = {};
  for (const block of ["A", "B"]) {
    championBlocks[block] = summarizeMatchup(
      results.filter((result) => result.group === "champion" && result.block === block),
      {
        bootstrapSeed: seed ^ block.charCodeAt(0),
        bootstrapResamples: profile.bootstrap_resamples,
      },
    );
  }
  const reference = referenceReportPath
    ? validateEdgerV2ReferenceReport(
        JSON.parse(fs.readFileSync(referenceReportPath, "utf8")),
        { championModelId: champion.policy_id },
      )
    : null;
  const referenceMatchups = reference?.matchups ?? {};
  const anchorGroups = anchors.map((anchor) => `anchor:${anchor.policy_id}`);
  const frozenGroups = ["heuristic", ...anchorGroups];
  const frozenScores = frozenGroups.map((group) => matchups[group]?.score ?? 0);
  const frozenMean = frozenScores.reduce((sum, value) => sum + value, 0) /
    Math.max(1, frozenScores.length);
  const worstAnchor = anchorGroups.length > 0
    ? Math.min(...anchorGroups.map((group) => matchups[group]?.score ?? 0))
    : null;
  const matchupRegressions = frozenGroups.map((group) => ({
    group,
    candidate_score: matchups[group]?.score ?? 0,
    champion_reference_score: referenceMatchups[group]?.score ?? null,
    regression: referenceMatchups[group]?.score === undefined
      ? null
      : referenceMatchups[group].score - (matchups[group]?.score ?? 0),
  }));
  const championGate =
    matchups.champion.score >= 0.535 &&
    matchups.champion.paired_bootstrap_95_lower_bound > 0.5 &&
    championBlocks.A.games > 0 &&
    championBlocks.B.games > 0
      ? pass({ combined: matchups.champion, blocks: championBlocks })
      : fail("champion paired score/bootstrap gate failed", {
          combined: matchups.champion,
          blocks: championBlocks,
        });
  const anchorBoundsPassed = frozenGroups.every(
    (group) => (matchups[group]?.paired_bootstrap_95_lower_bound ?? 0) >= 0.45,
  );
  const regressionsPassed = matchupRegressions.every(
    (item) => item.regression !== null && item.regression <= 0.03,
  );
  const anchorsGate = anchorBoundsPassed && regressionsPassed
    ? pass({ matchups: frozenGroups.map((group) => ({ group, ...matchups[group] })), matchup_regressions: matchupRegressions })
    : fail("heuristic/anchor lower-bound or regression gate failed", {
        matchups: frozenGroups.map((group) => ({ group, ...matchups[group] })),
        matchup_regressions: matchupRegressions,
      });
  const weakGate = weakBaselines.every(
    (weak) => (matchups[`weak:${weak.policy_id}`]?.score ?? 0) >= 0.65,
  )
    ? pass({ matchups: weakBaselines.map((weak) => ({ policy_id: weak.policy_id, ...matchups[`weak:${weak.policy_id}`] })) })
    : fail("weak-baseline score gate failed", {
        matchups: weakBaselines.map((weak) => ({ policy_id: weak.policy_id, ...matchups[`weak:${weak.policy_id}`] })),
      });
  const referenceMean = reference?.frozen_league_mean ?? null;
  const frozenGate =
    referenceMean !== null &&
    frozenMean - referenceMean >= 0.02 &&
    (worstAnchor === null || worstAnchor >= 0.45)
      ? pass({
          candidate_mean: frozenMean,
          champion_reference_mean: referenceMean,
          improvement: frozenMean - referenceMean,
          worst_anchor_score: worstAnchor,
        })
      : fail("frozen-league improvement/worst-anchor gate failed", {
          candidate_mean: frozenMean,
          champion_reference_mean: referenceMean,
          improvement: referenceMean === null ? null : frozenMean - referenceMean,
          worst_anchor_score: worstAnchor,
        });
  const scenarios = evaluateScenarioLeague(candidate);
  const timing = evaluateTiming(candidate, { samples: 100, budgetMs: 5 });
  const allReplayChecked = results.filter((result) => result.replay_checked);
  const replayPassed = allReplayChecked.length > 0 &&
    allReplayChecked.every((result) => result.replay_passed);
  const gates = {
    acceptance_profile: profile.acceptance_profile
      ? pass({ profile: profileName })
      : fail("smoke profile cannot produce a promotable report", { profile: profileName }),
    schema_and_size:
      getEdgerV2ActorParameterCount(candidate) <= 50_000 && candidateBytes <= 1_000_000
        ? pass({
            actor_parameters: getEdgerV2ActorParameterCount(candidate),
            artifact_bytes: candidateBytes,
          })
        : fail("v2 actor parameter/byte cap failed"),
    pytorch_js_parity: checkCandidateParity(candidateModelPath, candidate),
    champion: championGate,
    anchors: anchorsGate,
    weak_baselines: weakGate,
    frozen_league: frozenGate,
    safety: safetyGate(results, profile.safety_games),
    tactical_scenarios: scenarios.passed
      ? pass({
          candidate_aggregate: scenarios.candidate_aggregate,
          heuristic_aggregate: scenarios.heuristic_aggregate,
        })
      : fail("tactical scenario league failed", {
          candidate_aggregate: scenarios.candidate_aggregate,
          heuristic_aggregate: scenarios.heuristic_aggregate,
        }),
    replay: replayPassed
      ? pass({ checked_matches: allReplayChecked.length })
      : fail("generated-action replay verification failed", {
          checked_matches: allReplayChecked.length,
        }),
    generated_js_timing: timing.passed
      ? pass({ ...timing, reference_hardware: referenceHardware })
      : fail("generated-JS p95 exceeded 5 ms", {
          ...timing,
          reference_hardware: referenceHardware,
        }),
    full_test_suite: externalGate(
      testReportPath,
      "full test suite",
      campaignGitCommit,
    ),
    browser_smoke: externalGate(
      browserReportPath,
      "browser smoke",
      campaignGitCommit,
    ),
  };
  const failures = Object.entries(gates)
    .filter(([, gate]) => !gate.passed)
    .map(([name, gate]) => `${name}: ${gate.reason}`);
  return {
    schema_version: EDGER_V2_EVALUATION_REPORT_SCHEMA,
    evaluated_at: new Date().toISOString(),
    candidate_model_id: candidate.model_id,
    campaign_git_commit: campaignGitCommit,
    candidate_model: path.resolve(candidateModelPath),
    candidate_artifact_checksum: sha256File(candidateModelPath),
    champion_model_id: champion.policy_id,
    champion_model: champion.model_path,
    anchor_model_ids: anchors.map((anchor) => anchor.policy_id),
    profile: profileName,
    seed,
    workers,
    reference_hardware: referenceHardware,
    specs_checksum: sha256Json(specs),
    results_checksum: sha256Json(results),
    generated_matches: results.length,
    matchups,
    champion_blocks: championBlocks,
    frozen_league_mean: frozenMean,
    worst_anchor_score: worstAnchor,
    scenarios,
    timing,
    gates,
    promotion: {
      passed: failures.length === 0,
      failures,
    },
  };
}

export function createEdgerV2ReferenceReport(evaluationReport) {
  if (evaluationReport.schema_version !== EDGER_V2_EVALUATION_REPORT_SCHEMA) {
    throw new Error("reference source must be an edger_v2_evaluation_report_v1");
  }
  return {
    schema_version: EDGER_V2_REFERENCE_REPORT_SCHEMA,
    model_id: evaluationReport.candidate_model_id,
    evaluation_report_checksum: sha256Json(evaluationReport),
    matchups: evaluationReport.matchups,
    frozen_league_mean: evaluationReport.frozen_league_mean,
  };
}
