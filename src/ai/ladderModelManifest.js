import { getNeuralModelTargetTier, normalizeNeuralPolicyModel } from "./neuralModel.js";

export const LADDER_MODEL_MANIFEST_VERSION = 1;
export const DEFAULT_LADDER_MODEL_MANIFEST_PATH = "artifacts/training/ladder-models.json";
export const FAIR_LADDER_MODEL_TIERS = Object.freeze(["noob", "mid", "top", "pro", "goat"]);

const VALID_MODES = Object.freeze(new Set(["heuristic", "model"]));

function createEmptyManifest(warnings = []) {
  return {
    version: LADDER_MODEL_MANIFEST_VERSION,
    tiers: {},
    warnings,
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeManifestPath(value) {
  if (typeof value !== "string") {
    return null;
  }

  const path = value.trim().replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    /^https?:\/\//i.test(path) ||
    path.split("/").includes("..")
  ) {
    return null;
  }

  return path;
}

export function normalizeLadderModelManifest(rawManifest) {
  const warnings = [];
  if (!isObject(rawManifest)) {
    warnings.push("ladder model manifest is missing or invalid; using heuristic ladder bots");
    return createEmptyManifest(warnings);
  }

  if (Number(rawManifest.version) !== LADDER_MODEL_MANIFEST_VERSION) {
    warnings.push(`unsupported ladder model manifest version: ${rawManifest.version}`);
    return createEmptyManifest(warnings);
  }

  const rawTiers = isObject(rawManifest.tiers) ? rawManifest.tiers : {};
  const fairTierSet = new Set(FAIR_LADDER_MODEL_TIERS);
  const tiers = {};

  for (const tierId of Object.keys(rawTiers)) {
    if (!fairTierSet.has(tierId)) {
      warnings.push(`ignoring ladder model config for unsupported tier: ${tierId}`);
    }
  }

  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const entry = rawTiers[tierId];
    if (!isObject(entry)) {
      continue;
    }

    const mode = typeof entry.mode === "string" ? entry.mode.trim() : "";
    if (!VALID_MODES.has(mode)) {
      warnings.push(`tier ${tierId} has invalid ladder model mode; using heuristic`);
      tiers[tierId] = { mode: "heuristic", model_path: null };
      continue;
    }

    if (mode === "heuristic") {
      tiers[tierId] = { mode: "heuristic", model_path: null };
      continue;
    }

    const modelPath = normalizeManifestPath(entry.model_path);
    if (!modelPath) {
      warnings.push(`tier ${tierId} has invalid model_path; using heuristic`);
      tiers[tierId] = { mode: "heuristic", model_path: null };
      continue;
    }

    tiers[tierId] = { mode: "model", model_path: modelPath };
  }

  return {
    version: LADDER_MODEL_MANIFEST_VERSION,
    tiers,
    warnings,
  };
}

export function getConfiguredLadderModelPath(manifest, tierId) {
  const normalized = normalizeLadderModelManifest(manifest);
  const entry = normalized.tiers?.[tierId];
  return entry?.mode === "model" ? entry.model_path : null;
}

export function normalizeLoadedLadderModelsByTier({ manifest, rawModelsByTier = {} } = {}) {
  const normalizedManifest = normalizeLadderModelManifest(manifest);
  const warnings = [...normalizedManifest.warnings];
  const modelsByTier = {};

  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const modelPath = getConfiguredLadderModelPath(normalizedManifest, tierId);
    if (!modelPath) {
      continue;
    }

    const model = normalizeNeuralPolicyModel(rawModelsByTier[tierId]);
    if (!model) {
      warnings.push(`tier ${tierId} model at ${modelPath} is invalid; using heuristic`);
      continue;
    }

    const targetTier = getNeuralModelTargetTier(model);
    if (targetTier !== tierId) {
      warnings.push(`tier ${tierId} model target is ${targetTier ?? "missing"}; using heuristic`);
      continue;
    }

    modelsByTier[tierId] = model;
  }

  return {
    manifest: normalizedManifest,
    modelsByTier,
    warnings,
  };
}

export function createEnabledLadderModelManifest(modelsByTier = {}) {
  const tiers = {};
  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const modelPath = normalizeManifestPath(modelsByTier[tierId]);
    if (modelPath) {
      tiers[tierId] = {
        mode: "model",
        model_path: modelPath,
      };
    }
  }

  return {
    version: LADDER_MODEL_MANIFEST_VERSION,
    tiers,
  };
}
