import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  HEURISTIC_BOT_ID,
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
} from "../src/ai/botRuntime.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  getEdgerV2ActorParameterCount,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  evaluateScenarioLeague,
  evaluateScenarioFeasibility,
  evaluateTiming,
} from "./edger-evaluation-core.mjs";
import { spawnNativePython } from "./python-runtime.mjs";
import { evaluateOpportunityBankFile } from "./edger-opportunity-bank.mjs";

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

// Legal logits must satisfy |js - pytorch| <= max(1e-5, 4 * ulp32(magnitude))
// against PyTorch float32 (option C, approved October 25, 2026). Below
// magnitude 32 the bound is exactly 1e-5; above it, 4 ULP. Masked coordinates
// keep the absolute 1e-5. See docs/EDGER_PARITY_CONTRACT_REVIEW.md.
export const EDGER_V2_PARITY_TOLERANCE = 1e-5;
export const EDGER_V2_PARITY_ULP_MULTIPLE = 4;
const EDGER_V2_PARITY_TOLERANCE_RULE =
  "legal: |js - pytorch| <= max(1e-5, 4 * ulp32(max(|js|, |pytorch|))); masked: <= 1e-5";
// Mid-match states, not just the opening position: the September campaign's
// parity failure only appeared once activations had grown during a match.
export const EDGER_V2_PARITY_SEEDS = Object.freeze([20260718, 20260719, 20260720]);
const PARITY_STATES_PER_SEED = 6;
const PARITY_STATE_STRIDE_TICKS = 240;
export function float32Ulp(magnitude) {
  const value = Math.abs(magnitude);
  if (!Number.isFinite(value) || value === 0) {
    return 2 ** -149;
  }
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const exponent = (view.getUint32(0) >>> 23) & 0xff;
  return exponent === 0 ? 2 ** -149 : 2 ** (exponent - 127 - 23);
}

export function edgerV2ParityTolerance(jsValue, pytorchValue) {
  const magnitude = Math.max(Math.abs(jsValue), Math.abs(pytorchValue));
  return Math.max(
    EDGER_V2_PARITY_TOLERANCE,
    EDGER_V2_PARITY_ULP_MULTIPLE * float32Ulp(magnitude),
  );
}

function parityFixturesFor(model, engine, stateId) {
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const observation = buildEdgerV2Observation({ engine, actor: "red" });
  const cardMask = buildEdgerV2LegalMasks({ actor: "red", legalActions }).card;
  const fixtures = [];
  // Preserve the original PASS fixture, then exercise every legal card branch.
  // A PASS-only fixture masks all placement cells except zero and never tests
  // the other card embeddings or the delay head at a selected play location.
  for (let cardIndex = 0; cardIndex < cardMask.length; cardIndex += 1) {
    if (!cardMask[cardIndex]) {
      continue;
    }
    const masks = buildEdgerV2LegalMasks({
      actor: "red", legalActions, selectedCardIndex: cardIndex,
    });
    const id = cardIndex === 0 ? stateId : `${stateId}-card${cardIndex}`;
    const js = computeEdgerV2Logits({
      model,
      observation,
      legalMasks: masks,
      forcedCardIndex: cardIndex,
    });
    fixtures.push({
      id,
      stateId,
      masks,
      js,
      payload: {
        id,
        observation: {
          board: Array.from(observation.board),
          global: Array.from(observation.global),
        },
        legal_masks: {
          card: Array.from(masks.card),
          placement: Array.from(masks.placement),
          delay: Array.from(masks.delay),
        },
        forced_card_index: cardIndex,
        forced_placement_index: js.selected.placement_index,
      },
    });
  }
  return fixtures;
}

export function buildCandidateParityFixtures(model, { seeds = EDGER_V2_PARITY_SEEDS } = {}) {
  const fixtures = [];
  for (const [index, seed] of seeds.entries()) {
    const engine = createProductionEngine({ seed });
    const opening = index === 0;
    if (opening) {
      // The original opening fixture stays first so historical reports stay comparable.
      fixtures.push(...parityFixturesFor(model, engine, `opening-${seed}`));
    }
    const opponentRng = createRng(seed ^ 0x5f3759df);
    let candidateNextTick = 1;
    let opponentNextTick = 1;
    let captured = 0;
    let lastCaptureTick = opening ? 0 : -Infinity;
    while (engine.state.tick < 6040 && !engine.getMatchResult() && captured < PARITY_STATES_PER_SEED) {
      const tick = engine.state.tick + 1;
      const actions = [];
      if (tick >= candidateNextTick) {
        const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
        const decision = selectEdgerV2PolicyDecision({ model, engine, actor: "red", legalActions });
        if (legalActions.length > 0 && tick - lastCaptureTick >= PARITY_STATE_STRIDE_TICKS) {
          fixtures.push(...parityFixturesFor(model, engine, `seed${seed}-tick${tick}`));
          captured += 1;
          lastCaptureTick = tick;
        }
        candidateNextTick = tick + (decision.delayTicks ?? 1);
        const action = decision.action;
        if (action?.type === "PLAY_CARD" && legalActions.some((candidate) =>
          candidate.cardId === action.cardId && candidate.x === action.x && candidate.y === action.y)) {
          actions.push({ tick, type: "PLAY_CARD", actor: "red", cardId: action.cardId, x: action.x, y: action.y });
        }
      }
      if (tick >= opponentNextTick) {
        const legalActions = enumerateLegalCardActions({ engine, actor: "blue" });
        const selected = selectBotAction({
          botId: HEURISTIC_BOT_ID,
          engine,
          actor: "blue",
          legalActions,
          rng: opponentRng,
        });
        opponentNextTick = tick + rollDecisionDelayTicks({ botId: HEURISTIC_BOT_ID, rng: opponentRng });
        if (selected?.type === "PLAY_CARD") {
          actions.push({ tick, type: "PLAY_CARD", actor: "blue", cardId: selected.cardId, x: selected.x, y: selected.y });
        }
      }
      engine.step(actions);
      if (engine.shouldStartOvertime()) {
        engine.setOvertime(true);
      }
    }
  }
  return fixtures;
}

function maskedArgmaxOf(values, mask) {
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    if (mask[index] && values[index] > bestValue) {
      bestIndex = index;
      bestValue = values[index];
    }
  }
  return bestIndex;
}

function legalTop(values, mask) {
  let best = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    if (mask[index] && values[index] > best) {
      best = values[index];
    }
  }
  const ties = [];
  let runnerUp = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    if (values[index] === best) {
      ties.push(index);
    } else if (values[index] > runnerUp) {
      runnerUp = values[index];
    }
  }
  return { ties, gap: best - runnerUp };
}

// Compares a parity bank's JS logits with PyTorch's output for the same
// fixtures. Separated from checkCandidateParity so the contract can be checked
// against recorded logits without a PyTorch process.
export function compareCandidateParity(fixtures, pytorchFixtures) {
  const heads = {};
  for (const head of ["card", "placement", "delay"]) {
    heads[head] = {
      maximum_logit_difference: 0,
      maximum_legal_logit_magnitude: 0,
      maximum_ulp_error: 0,
    };
  }
  let maximumDifference = 0;
  let maximumMagnitude = 0;
  let argmaxAgreement = true;
  let tieSetAgreement = true;
  let toleranceExceedances = 0;
  let nonFinite = 0;
  const fixtureReports = [];
  const fragileMargins = [];
  let openingArgmax = null;
  let worstAbsoluteError = null;
  let worstToleranceError = null;

  for (let index = 0; index < fixtures.length; index += 1) {
    const { id, stateId, payload, masks, js } = fixtures[index];
    const pytorch = pytorchFixtures[index];
    if (pytorch.id !== id) {
      return fail("PyTorch parity returned fixtures out of order", {
        expected_fixture: id,
        received_fixture: pytorch.id ?? null,
      });
    }
    let fixtureDifference = 0;
    let fixtureMagnitude = 0;
    let fixtureUlpError = 0;
    let fixtureExceedances = 0;
    const fixtureTieSetAgreement = {};
    const fixtureFragileHeads = [];
    for (const head of ["card", "placement", "delay"]) {
      const jsValues = Array.from(js[head]);
      if (!Array.isArray(pytorch[head]) || pytorch[head].length !== jsValues.length) {
        return fail(`PyTorch ${head} logit shape mismatch`, { fixture: id });
      }
      let headLegalDifference = 0;
      for (let position = 0; position < jsValues.length; position += 1) {
        const jsValue = jsValues[position];
        const pytorchValue = pytorch[head][position];
        if (!Number.isFinite(jsValue) || !Number.isFinite(pytorchValue)) {
          nonFinite += 1;
          continue;
        }
        const difference = Math.abs(jsValue - pytorchValue);
        fixtureDifference = Math.max(fixtureDifference, difference);
        heads[head].maximum_logit_difference = Math.max(
          heads[head].maximum_logit_difference,
          difference,
        );
        const legal = Boolean(masks[head][position]);
        const tolerance = legal
          ? edgerV2ParityTolerance(jsValue, pytorchValue)
          : EDGER_V2_PARITY_TOLERANCE;
        if (difference > tolerance) {
          fixtureExceedances += 1;
        }
        if (worstToleranceError === null || difference / tolerance > worstToleranceError.tolerance_ratio) {
          worstToleranceError = {
            fixture: id, head, index: position, legal,
            js_value: jsValue, pytorch_value: pytorchValue,
            absolute_difference: difference, tolerance, tolerance_ratio: difference / tolerance,
          };
        }
        if (legal) {
          headLegalDifference = Math.max(headLegalDifference, difference);
          const magnitude = Math.max(Math.abs(jsValue), Math.abs(pytorchValue));
          const ulp = float32Ulp(magnitude);
          const ulpError = difference / ulp;
          fixtureUlpError = Math.max(fixtureUlpError, ulpError);
          heads[head].maximum_ulp_error = Math.max(heads[head].maximum_ulp_error, ulpError);
          if (worstAbsoluteError === null || difference > worstAbsoluteError.absolute_difference) {
            worstAbsoluteError = {
              fixture: id, head, index: position,
              js_value: jsValue, pytorch_value: pytorchValue,
              absolute_difference: difference, float32_ulp: ulp, ulp_error: ulpError,
            };
          }
          fixtureMagnitude = Math.max(fixtureMagnitude, magnitude);
          heads[head].maximum_legal_logit_magnitude = Math.max(
            heads[head].maximum_legal_logit_magnitude,
            magnitude,
          );
        }
      }
      const jsTop = legalTop(jsValues, masks[head]);
      const pytorchTop = legalTop(pytorch[head], masks[head]);
      fixtureTieSetAgreement[head] =
        jsTop.ties.length === pytorchTop.ties.length &&
        jsTop.ties.every((position, rank) => position === pytorchTop.ties[rank]);
      // A top choice whose PyTorch margin over the next distinct legal logit is
      // within twice the measured error could flip under a different
      // accumulation order. It does not fail the gate; it needs review.
      if (Number.isFinite(pytorchTop.gap) && pytorchTop.gap <= 2 * headLegalDifference) {
        fixtureFragileHeads.push(head);
        fragileMargins.push({
          fixture: id, head, pytorch_margin: pytorchTop.gap, maximum_legal_difference: headLegalDifference,
        });
      }
    }
    const jsArgmax = {
      card: maskedArgmaxOf(js.card, masks.card),
      placement: maskedArgmaxOf(js.placement, masks.placement),
      delay: maskedArgmaxOf(js.delay, masks.delay),
    };
    const pytorchArgmax = {
      card: pytorch.card_argmax,
      placement: pytorch.placement_argmax,
      delay: pytorch.delay_argmax,
    };
    const fixtureAgreement =
      jsArgmax.card === pytorchArgmax.card &&
      jsArgmax.placement === pytorchArgmax.placement &&
      jsArgmax.delay === pytorchArgmax.delay;
    const fixtureTieAgreement = Object.values(fixtureTieSetAgreement).every(Boolean);
    argmaxAgreement = argmaxAgreement && fixtureAgreement;
    tieSetAgreement = tieSetAgreement && fixtureTieAgreement;
    toleranceExceedances += fixtureExceedances;
    maximumDifference = Math.max(maximumDifference, fixtureDifference);
    maximumMagnitude = Math.max(maximumMagnitude, fixtureMagnitude);
    if (openingArgmax === null) {
      openingArgmax = { js: jsArgmax, pytorch: pytorchArgmax };
    }
    fixtureReports.push({
      id,
      state_id: stateId,
      forced_card_index: payload.forced_card_index,
      forced_placement_index: payload.forced_placement_index,
      maximum_logit_difference: fixtureDifference,
      maximum_legal_logit_magnitude: fixtureMagnitude,
      maximum_ulp_error: fixtureUlpError,
      tolerance_exceedances: fixtureExceedances,
      argmax_agreement: fixtureAgreement,
      tie_set_agreement: fixtureTieAgreement,
      fragile_margin_heads: fixtureFragileHeads,
    });
  }

  const ulp = float32Ulp(maximumMagnitude);
  // ULP spacing describes scale, not an error bound or a root cause. Two
  // implementations can agree exactly at large magnitudes, or accumulate
  // substantial error at small magnitudes. Only measured parity gates pass.
  const details = {
    maximum_logit_difference: maximumDifference,
    maximum_legal_logit_magnitude: maximumMagnitude,
    float32_ulp: ulp,
    maximum_ulp_error: Math.max(...Object.values(heads).map((head) => head.maximum_ulp_error)),
    worst_absolute_error: worstAbsoluteError,
    tolerance: EDGER_V2_PARITY_TOLERANCE,
    ulp_tolerance_multiple: EDGER_V2_PARITY_ULP_MULTIPLE,
    tolerance_rule: EDGER_V2_PARITY_TOLERANCE_RULE,
    tolerance_exceedances: toleranceExceedances,
    worst_tolerance_error: worstToleranceError,
    heads,
    fixture_count: fixtures.length,
    state_count: new Set(fixtures.map((fixture) => fixture.stateId)).size,
    card_indices_covered: [...new Set(fixtures.map((fixture) => fixture.payload.forced_card_index))].sort((a, b) => a - b),
    fixtures: fixtureReports,
    argmax_agreement: argmaxAgreement,
    tie_set_agreement: tieSetAgreement,
    fragile_margin_count: fragileMargins.length,
    fragile_margins: fragileMargins,
    review_required: fragileMargins.length > 0,
    js_argmax: openingArgmax.js,
    pytorch_argmax: openingArgmax.pytorch,
  };
  if (nonFinite > 0) {
    return fail("non-finite parity logits", { ...details, non_finite_logits: nonFinite });
  }
  if (!argmaxAgreement) {
    return fail("PyTorch/generated-JS argmax disagreement", details);
  }
  if (!tieSetAgreement) {
    return fail("PyTorch/generated-JS tie-set disagreement", details);
  }
  if (toleranceExceedances > 0) {
    return fail("PyTorch/generated-JS parity exceeded tolerance", details);
  }
  return pass(details);
}

export function checkCandidateParity(modelPath, model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-eval-parity-"));
  try {
    const fixtures = buildCandidateParityFixtures(model);
    const fixturePath = path.join(root, "fixtures.json");
    const outputPath = path.join(root, "pytorch.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      fixtures: fixtures.map((fixture) => fixture.payload),
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
    const pytorchFixtures = JSON.parse(fs.readFileSync(outputPath, "utf8")).fixtures;
    if (!Array.isArray(pytorchFixtures) || pytorchFixtures.length !== fixtures.length) {
      return fail("PyTorch parity returned the wrong fixture count");
    }
    return compareCandidateParity(fixtures, pytorchFixtures);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}


export function evaluateEdgerV2Preflight({ candidateModelPath, candidate, referenceHardware, opportunityBankPath = null }) {
  const scenarios = evaluateScenarioLeague(candidate);
  const feasibility = evaluateScenarioFeasibility();
  const timing = evaluateTiming(candidate, { samples: 100, budgetMs: 5 });
  const gates = {
    pytorch_js_parity: checkCandidateParity(candidateModelPath, candidate),
    tactical_scenarios: {
      passed: feasibility.passed && scenarios.passed,
      ...(!feasibility.passed
        ? { reason: "tactical fixture minimum is unreachable or production setup is invalid" }
        : !scenarios.passed ? { reason: "tactical scenario league failed" } : {}),
      candidate_aggregate: scenarios.candidate_aggregate,
      heuristic_aggregate: scenarios.heuristic_aggregate,
      feasibility,
      schema_version: scenarios.schema_version,
    },
    heldout_fireball: evaluateOpportunityBankFile(candidate, opportunityBankPath),
    generated_js_timing: timing.passed
      ? pass({ ...timing, reference_hardware: referenceHardware })
      : fail("generated-JS p95 exceeded 5 ms", { ...timing, reference_hardware: referenceHardware }),
  };
  return { passed: Object.values(gates).every((gate) => gate.passed), gates, scenarios, timing };
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
  opportunityBankPath = null,
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
  // Reject deterministic/cheap failures before paying for the match suite.
  const preflight = evaluateEdgerV2Preflight({ candidateModelPath, candidate, referenceHardware, opportunityBankPath });
  const results = preflight.passed ? await executeEdgerV2EvaluationSpecs({
    candidateModelPath,
    specs,
    workers,
  }) : [];
  const byGroup = new Map();
  for (const result of results) {
    const list = byGroup.get(result.group) ?? [];
    list.push(result);
    byGroup.set(result.group, list);
  }
  const matchups = {
    champion: summarizeMatchup([], { bootstrapSeed: seed, bootstrapResamples: profile.bootstrap_resamples }),
  };
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
  const { scenarios, timing } = preflight;
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
    pytorch_js_parity: preflight.gates.pytorch_js_parity,
    champion: championGate,
    anchors: anchorsGate,
    weak_baselines: weakGate,
    frozen_league: frozenGate,
    safety: safetyGate(results, profile.safety_games),
    tactical_scenarios: preflight.gates.tactical_scenarios,
    heldout_fireball: preflight.gates.heldout_fireball,
    replay: replayPassed
      ? pass({ checked_matches: allReplayChecked.length })
      : fail("generated-action replay verification failed", {
          checked_matches: allReplayChecked.length,
        }),
    generated_js_timing: preflight.gates.generated_js_timing,
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
  if (!preflight.passed) {
    for (const name of ["champion", "anchors", "weak_baselines", "frozen_league", "safety", "replay"]) {
      gates[name] = fail("not run: candidate preflight failed", { skipped: true });
    }
  }
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
    match_suite_skipped: !preflight.passed,
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
