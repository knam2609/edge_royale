import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LADDER_MODEL_MANIFEST_PATH,
  FAIR_LADDER_MODEL_TIERS,
  createEnabledLadderModelManifest,
  getConfiguredLadderModelPath,
  normalizeLadderModelManifest,
} from "../src/ai/ladderModelManifest.js";
import { getNeuralModelTargetTier, normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";

const DEFAULT_PROMOTED_DIR = "artifacts/training/promoted";
const DEFAULT_SUMMARY_OUT = "artifacts/training/promoted/latest-training-summary.json";

function parseArgs(argv) {
  const parsed = {
    candidateManifest: null,
    comparisonSummary: null,
    outDir: DEFAULT_PROMOTED_DIR,
    manifestOut: DEFAULT_LADDER_MODEL_MANIFEST_PATH,
    summaryOut: DEFAULT_SUMMARY_OUT,
    prBodyOut: null,
    runRoot: null,
    promotedAt: new Date().toISOString(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--candidate-manifest" && argv[i + 1]) parsed.candidateManifest = argv[++i];
    else if (arg === "--comparison-summary" && argv[i + 1]) parsed.comparisonSummary = argv[++i];
    else if (arg === "--out-dir" && argv[i + 1]) parsed.outDir = argv[++i];
    else if (arg === "--manifest-out" && argv[i + 1]) parsed.manifestOut = argv[++i];
    else if (arg === "--summary-out" && argv[i + 1]) parsed.summaryOut = argv[++i];
    else if (arg === "--pr-body-out" && argv[i + 1]) parsed.prBodyOut = argv[++i];
    else if (arg === "--run-root" && argv[i + 1]) parsed.runRoot = argv[++i];
    else if (arg === "--promoted-at" && argv[i + 1]) parsed.promotedAt = argv[++i];
  }

  if (!parsed.candidateManifest) {
    throw new Error("missing --candidate-manifest path");
  }

  return parsed;
}

async function readJson(path, cwd = process.cwd()) {
  return JSON.parse(await readFile(resolve(cwd, path), "utf8"));
}

function promotedModelPath(outDir, tierId) {
  return join(outDir, "models", `${tierId}-model.json`).replaceAll("\\", "/");
}

function promotedTrainingSummaryPath(outDir, tierId) {
  return join(outDir, "summaries", `${tierId}-training-summary.json`).replaceAll("\\", "/");
}

function sourceTrainingSummaryPath(modelPath, tierId) {
  const suffix = `${tierId}-model.json`;
  return modelPath.endsWith(suffix) ? modelPath.slice(0, -suffix.length) + `${tierId}-training-summary.json` : null;
}

async function copyJsonFile(sourcePath, destinationPath, cwd = process.cwd()) {
  const source = resolve(cwd, sourcePath);
  const destination = resolve(cwd, destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function buildPrBody({ promoted, comparison, promotedAt }) {
  const lines = [
    "# Daily ladder model update",
    "",
    `Promoted at: ${promotedAt}`,
    `Gate passed: ${comparison?.passed === true ? "true" : "unknown"}`,
    `Average delta: ${comparison?.gate?.metrics?.average_delta ?? "unknown"}`,
    `Worst adjacent delta: ${comparison?.gate?.metrics?.worst_adjacent_delta ?? "unknown"}`,
    "",
    "Promoted tiers:",
    ...promoted.tiers.map((tier) => `- ${tier.tier_id}: ${tier.model_path}`),
    "",
    "Validation:",
    "- npm test passed before training in workflow",
    "- candidate models passed daily validity + improvement gate",
    "- full run artifact is attached to workflow run",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export async function promoteLadderModels(args) {
  const cwd = args.cwd ?? process.cwd();
  const rawManifest = await readJson(args.candidateManifest, cwd);
  const manifest = normalizeLadderModelManifest(rawManifest);
  const comparison = args.comparisonSummary ? await readJson(args.comparisonSummary, cwd) : null;
  const modelsByTier = {};
  const tiers = [];
  const warnings = [...manifest.warnings];

  for (const tierId of FAIR_LADDER_MODEL_TIERS) {
    const modelPath = getConfiguredLadderModelPath(manifest, tierId);
    if (!modelPath) {
      continue;
    }

    const rawModel = await readJson(modelPath, cwd);
    const model = normalizeNeuralPolicyModel(rawModel);
    const targetTier = getNeuralModelTargetTier(model);
    if (!model || targetTier !== tierId) {
      warnings.push(`skipped ${tierId}: model target is ${targetTier ?? "invalid"}`);
      continue;
    }

    const destinationModelPath = promotedModelPath(args.outDir, tierId);
    const destinationSummaryPath = promotedTrainingSummaryPath(args.outDir, tierId);
    const summaryPath = sourceTrainingSummaryPath(modelPath, tierId);

    await copyJsonFile(modelPath, destinationModelPath, cwd);
    let copiedSummary = false;
    if (summaryPath) {
      try {
        await copyJsonFile(summaryPath, destinationSummaryPath, cwd);
        copiedSummary = true;
      } catch (error) {
        warnings.push(`could not copy ${tierId} training summary: ${error.message}`);
      }
    }

    modelsByTier[tierId] = destinationModelPath;
    tiers.push({
      tier_id: tierId,
      model_path: destinationModelPath,
      source_model_path: modelPath,
      training_summary_path: copiedSummary ? destinationSummaryPath : null,
      source_training_summary_path: copiedSummary ? summaryPath : null,
      dataset_hash: model.dataset_hash ?? null,
      training_config: model.training_config ?? null,
    });
  }

  if (tiers.length === 0) {
    throw new Error("no valid candidate models were promoted");
  }

  const promotedManifest = createEnabledLadderModelManifest(modelsByTier);
  const promoted = {
    version: 1,
    promoted_at: args.promotedAt,
    run_root: args.runRoot ?? null,
    candidate_manifest_path: args.candidateManifest,
    comparison_summary_path: args.comparisonSummary ?? null,
    gate_passed: comparison?.passed ?? null,
    gate_metrics: comparison?.gate?.metrics ?? null,
    tiers,
    warnings,
  };

  const manifestOutPath = resolve(cwd, args.manifestOut);
  const summaryOutPath = resolve(cwd, args.summaryOut);
  await mkdir(dirname(manifestOutPath), { recursive: true });
  await mkdir(dirname(summaryOutPath), { recursive: true });
  await writeFile(manifestOutPath, `${JSON.stringify(promotedManifest, null, 2)}\n`, "utf8");
  await writeFile(summaryOutPath, `${JSON.stringify(promoted, null, 2)}\n`, "utf8");

  if (args.prBodyOut) {
    const prBodyOutPath = resolve(cwd, args.prBodyOut);
    await mkdir(dirname(prBodyOutPath), { recursive: true });
    await writeFile(prBodyOutPath, buildPrBody({ promoted, comparison, promotedAt: args.promotedAt }), "utf8");
  }

  return promoted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promoted = await promoteLadderModels(args);
  console.log(`promoted_tiers=${promoted.tiers.map((tier) => tier.tier_id).join(",")}`);
  console.log(`ladder_model_manifest=${args.manifestOut}`);
  console.log(`promoted_summary=${args.summaryOut}`);
  if (args.prBodyOut) {
    console.log(`pr_body=${args.prBodyOut}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
