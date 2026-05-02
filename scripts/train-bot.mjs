import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadDatasetFile, resolveDatasetInputPaths } from "./train-bot-lib.mjs";
import { runBenchmark } from "../src/ai/benchmark.js";
import {
  ACTION_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION,
  MODEL_INPUT_SIZE,
} from "../src/ai/neuralFeatures.js";
import { NEURAL_MODEL_KIND, NEURAL_MODEL_VERSION, normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";
import { countActionTrainingRows, fillActionTrainingBuffers } from "../src/ai/neuralTraining.js";
import { generateTrainingDataset, hashTrainingDatasetCorpus } from "../src/ai/trainingData.js";

const TIER_MODEL_SHAPES = Object.freeze({
  noob: Object.freeze({ hidden1: 8, hidden2: 4 }),
  mid: Object.freeze({ hidden1: 16, hidden2: 8 }),
  top: Object.freeze({ hidden1: 32, hidden2: 16 }),
  pro: Object.freeze({ hidden1: 48, hidden2: 24 }),
  goat: Object.freeze({ hidden1: 64, hidden2: 32 }),
});

function normalizeTierId(tierId) {
  return typeof tierId === "string" && tierId.length > 0 ? tierId.trim() : "";
}

function getDefaultModelShape(targetTier) {
  return TIER_MODEL_SHAPES[normalizeTierId(targetTier)] ?? TIER_MODEL_SHAPES.goat;
}

function getDefaultEvalTiers(targetTier) {
  if (targetTier === "noob") {
    return ["noob", "mid"];
  }
  if (targetTier === "mid") {
    return ["noob", "mid", "top"];
  }
  if (targetTier === "top") {
    return ["mid", "top", "pro"];
  }
  if (targetTier === "pro") {
    return ["top", "pro", "goat"];
  }
  return ["noob", "mid", "top"];
}

async function loadTensorflow() {
  try {
    return await import("@tensorflow/tfjs");
  } catch (error) {
    throw new Error(
      "TensorFlow.js is required for training. Run `npm install` after package.json has @tensorflow/tfjs.",
      { cause: error },
    );
  }
}

function parseArgs(argv) {
  const defaultShape = getDefaultModelShape("goat");
  const parsed = {
    targetTier: "goat",
    seed: 505,
    episodes: 8,
    iterations: 1,
    epochs: 4,
    batchSize: 32,
    learningRate: 0.01,
    maxTicks: 900,
    tiers: null,
    evalTiers: null,
    evalRounds: 4,
    evalMaxTicks: 400,
    maxNegatives: 4,
    hidden1: defaultShape.hidden1,
    hidden2: defaultShape.hidden2,
    dataset: [],
    datasetDir: [],
    out: null,
    summaryOut: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target-tier" && argv[i + 1]) parsed.targetTier = normalizeTierId(argv[++i]) || "goat";
    else if (arg === "--seed" && argv[i + 1]) parsed.seed = Number.parseInt(argv[++i], 10);
    else if (arg === "--episodes" && argv[i + 1]) parsed.episodes = Number.parseInt(argv[++i], 10);
    else if (arg === "--iterations" && argv[i + 1]) parsed.iterations = Number.parseInt(argv[++i], 10);
    else if (arg === "--epochs" && argv[i + 1]) parsed.epochs = Number.parseInt(argv[++i], 10);
    else if (arg === "--batch-size" && argv[i + 1]) parsed.batchSize = Number.parseInt(argv[++i], 10);
    else if (arg === "--learning-rate" && argv[i + 1]) parsed.learningRate = Number.parseFloat(argv[++i]);
    else if (arg === "--max-ticks" && argv[i + 1]) parsed.maxTicks = Number.parseInt(argv[++i], 10);
    else if (arg === "--eval-rounds" && argv[i + 1]) parsed.evalRounds = Number.parseInt(argv[++i], 10);
    else if (arg === "--eval-max-ticks" && argv[i + 1]) parsed.evalMaxTicks = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-negatives" && argv[i + 1]) parsed.maxNegatives = Number.parseInt(argv[++i], 10);
    else if (arg === "--hidden1" && argv[i + 1]) parsed.hidden1 = Number.parseInt(argv[++i], 10);
    else if (arg === "--hidden2" && argv[i + 1]) parsed.hidden2 = Number.parseInt(argv[++i], 10);
    else if (arg === "--dataset" && argv[i + 1]) parsed.dataset.push(argv[++i]);
    else if (arg === "--dataset-dir" && argv[i + 1]) parsed.datasetDir.push(argv[++i]);
    else if (arg === "--out" && argv[i + 1]) parsed.out = argv[++i];
    else if (arg === "--summary-out" && argv[i + 1]) parsed.summaryOut = argv[++i];
    else if (arg === "--tiers" && argv[i + 1]) {
      parsed.tiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
    } else if (arg === "--eval-tiers" && argv[i + 1]) {
      parsed.evalTiers = argv[++i]
        .split(",")
        .map((tier) => tier.trim())
        .filter((tier) => tier.length > 0);
    }
  }

  parsed.seed = Number.isFinite(parsed.seed) ? parsed.seed : 505;
  parsed.episodes = Number.isFinite(parsed.episodes) && parsed.episodes > 0 ? parsed.episodes : 8;
  parsed.iterations = Number.isFinite(parsed.iterations) && parsed.iterations > 0 ? parsed.iterations : 1;
  parsed.epochs = Number.isFinite(parsed.epochs) && parsed.epochs > 0 ? parsed.epochs : 4;
  parsed.batchSize = Number.isFinite(parsed.batchSize) && parsed.batchSize > 0 ? parsed.batchSize : 32;
  parsed.learningRate = Number.isFinite(parsed.learningRate) && parsed.learningRate > 0 ? parsed.learningRate : 0.01;
  parsed.maxTicks = Number.isFinite(parsed.maxTicks) && parsed.maxTicks > 0 ? parsed.maxTicks : 900;
  parsed.evalRounds = Number.isFinite(parsed.evalRounds) && parsed.evalRounds > 0 ? parsed.evalRounds : 4;
  parsed.evalMaxTicks = Number.isFinite(parsed.evalMaxTicks) && parsed.evalMaxTicks > 0 ? parsed.evalMaxTicks : 400;
  parsed.maxNegatives = Number.isFinite(parsed.maxNegatives) && parsed.maxNegatives >= 0 ? parsed.maxNegatives : 4;
  const shape = getDefaultModelShape(parsed.targetTier);
  parsed.hidden1 = Number.isFinite(parsed.hidden1) && parsed.hidden1 > 0 ? parsed.hidden1 : shape.hidden1;
  parsed.hidden2 = Number.isFinite(parsed.hidden2) && parsed.hidden2 > 0 ? parsed.hidden2 : shape.hidden2;
  parsed.tiers = Array.isArray(parsed.tiers) && parsed.tiers.length > 0 ? parsed.tiers : [parsed.targetTier];
  parsed.evalTiers =
    Array.isArray(parsed.evalTiers) && parsed.evalTiers.length > 0 ? parsed.evalTiers : getDefaultEvalTiers(parsed.targetTier);
  parsed.out = parsed.out || `artifacts/training/models/${parsed.targetTier}-model.json`;
  parsed.summaryOut = parsed.summaryOut || `artifacts/training/models/${parsed.targetTier}-training-summary.json`;

  return parsed;
}

function createEmptyRowSummary() {
  return {
    rows: 0,
    positives: 0,
    negatives: 0,
  };
}

function addRowSummary(total, current) {
  return {
    rows: total.rows + current.rows,
    positives: total.positives + current.positives,
    negatives: total.negatives + current.negatives,
  };
}

function collectDatasetTiers(datasetSources) {
  const seen = new Set();
  for (const source of datasetSources) {
    for (const tier of Array.isArray(source?.tiers) ? source.tiers : []) {
      if (typeof tier === "string" && tier.length > 0) {
        seen.add(tier);
      }
    }
  }
  return [...seen];
}

function makeModel(tf, args) {
  const model = tf.sequential();
  model.add(
    tf.layers.dense({
      inputShape: [MODEL_INPUT_SIZE],
      units: args.hidden1,
      activation: "relu",
      kernelInitializer: tf.initializers.glorotUniform({ seed: args.seed }),
      biasInitializer: "zeros",
    }),
  );
  model.add(
    tf.layers.dense({
      units: args.hidden2,
      activation: "relu",
      kernelInitializer: tf.initializers.glorotUniform({ seed: args.seed + 1 }),
      biasInitializer: "zeros",
    }),
  );
  model.add(
    tf.layers.dense({
      units: 1,
      activation: "sigmoid",
      kernelInitializer: tf.initializers.glorotUniform({ seed: args.seed + 2 }),
      biasInitializer: "zeros",
    }),
  );
  model.compile({
    optimizer: tf.train.adam(args.learningRate),
    loss: "binaryCrossentropy",
    metrics: ["accuracy"],
  });
  return model;
}

function exportModelArtifact(model, args, dataset, rowSummary, iterationSummaries) {
  const layers = model.layers.map((layer) => {
    const [kernel, bias] = layer.getWeights();
    return {
      type: "dense",
      activation: layer.getConfig().activation ?? "linear",
      weights: kernel.arraySync(),
      bias: bias.arraySync(),
    };
  });

  return {
    version: NEURAL_MODEL_VERSION,
    kind: NEURAL_MODEL_KIND,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    action_schema_version: ACTION_SCHEMA_VERSION,
    input_size: MODEL_INPUT_SIZE,
    seed: args.seed,
    dataset_hash: dataset.dataset_hash,
    training_config: {
      algorithm: "ladder_supervised_policy_v1",
      target_tier: args.targetTier,
      tiers: Array.isArray(dataset.tiers) && dataset.tiers.length > 0 ? dataset.tiers : args.tiers,
      episodes: dataset.episode_count,
      iterations: args.iterations,
      epochs_per_iteration: args.epochs,
      batch_size: args.batchSize,
      learning_rate: args.learningRate,
      max_ticks: args.maxTicks,
      max_negatives_per_decision: args.maxNegatives,
      ...(Array.isArray(dataset.dataset_sources) ? { dataset_sources: dataset.dataset_sources } : {}),
      row_summary: rowSummary,
      iteration_summaries: iterationSummaries,
    },
    layers,
  };
}

function finalizeInputBuffers(tf, dataset, rowSummary, inputs, labels, rowCount) {
  if (rowCount !== rowSummary.rows) {
    throw new Error(`training row count mismatch: expected ${rowSummary.rows}, got ${rowCount}`);
  }
  return {
    dataset,
    rowSummary,
    xs: tf.tensor2d(inputs, [rowSummary.rows, MODEL_INPUT_SIZE]),
    ys: tf.tensor2d(labels, [rowSummary.rows, 1]),
  };
}

async function loadOrGenerateTrainingInput(tf, args) {
  const datasetPaths = await resolveDatasetInputPaths({
    cwd: process.cwd(),
    datasetPaths: args.dataset,
    datasetDirs: args.datasetDir,
  });

  if (datasetPaths.length === 0) {
    const dataset = generateTrainingDataset({
      seed: args.seed,
      tiers: args.tiers,
      episodes: args.episodes,
      maxTicks: args.maxTicks,
    });
    const rowSummary = countActionTrainingRows(dataset, {
      maxNegativesPerDecision: args.maxNegatives,
    });
    if (rowSummary.rows === 0) {
      throw new Error("training dataset produced no action rows");
    }

    const inputs = new Float32Array(rowSummary.rows * MODEL_INPUT_SIZE);
    const labels = new Float32Array(rowSummary.rows);
    const rowCount = fillActionTrainingBuffers(dataset, {
      maxNegativesPerDecision: args.maxNegatives,
      inputSize: MODEL_INPUT_SIZE,
      inputs,
      labels,
    });

    return finalizeInputBuffers(
      tf,
      {
        dataset_hash: dataset.dataset_hash,
        episode_count: dataset.episode_count,
        sample_count: dataset.sample_count,
        tiers: dataset.tiers,
      },
      rowSummary,
      inputs,
      labels,
      rowCount,
    );
  }

  const datasetSources = [];
  let rowSummary = createEmptyRowSummary();

  for (const datasetPath of datasetPaths) {
    const source = await loadDatasetFile(datasetPath);
    const sourceRowSummary = countActionTrainingRows(source.dataset, {
      maxNegativesPerDecision: args.maxNegatives,
    });
    if (sourceRowSummary.rows === 0) {
      continue;
    }

    datasetSources.push({
      path: source.path,
      dataset_hash: source.dataset_hash,
      episode_count: source.episode_count,
      sample_count: source.sample_count,
      tiers: source.tiers,
      row_summary: sourceRowSummary,
    });
    rowSummary = addRowSummary(rowSummary, sourceRowSummary);
  }

  const inputs = new Float32Array(rowSummary.rows * MODEL_INPUT_SIZE);
  const labels = new Float32Array(rowSummary.rows);
  let rowCount = 0;

  if (datasetSources.length === 0 || rowSummary.rows === 0) {
    throw new Error(`training dataset produced no action rows for target tier: ${args.targetTier}`);
  }

  for (const source of datasetSources) {
    const loaded = await loadDatasetFile(source.path);
    rowCount = fillActionTrainingBuffers(loaded.dataset, {
      maxNegativesPerDecision: args.maxNegatives,
      inputSize: MODEL_INPUT_SIZE,
      inputs,
      labels,
      rowOffset: rowCount,
    });
  }

  return finalizeInputBuffers(
    tf,
    {
      dataset_hash:
        datasetSources.length === 1
          ? datasetSources[0].dataset_hash
          : hashTrainingDatasetCorpus(datasetSources.map((source) => source.dataset_hash)),
      episode_count: datasetSources.reduce((sum, source) => sum + source.episode_count, 0),
      sample_count: datasetSources.reduce((sum, source) => sum + source.sample_count, 0),
      tiers: collectDatasetTiers(datasetSources),
      dataset_sources: datasetSources.map((source) => ({
        path: source.path,
        dataset_hash: source.dataset_hash,
        episode_count: source.episode_count,
        sample_count: source.sample_count,
        row_summary: source.row_summary,
      })),
    },
    rowSummary,
    inputs,
    labels,
    rowCount,
  );
}

function evaluateModel(modelArtifact, args, iteration) {
  return args.evalTiers.map((tier) => {
    const benchmark = runBenchmark({
      botA: args.targetTier,
      botB: tier,
      trainedModelA: modelArtifact,
      seed: args.seed + iteration * 1009 + tier.length * 31,
      rounds: args.evalRounds,
      maxTicks: args.evalMaxTicks,
    });
    return {
      tier,
      rounds: benchmark.rounds,
      wins: benchmark.winsA,
      losses: benchmark.winsB,
      draws: benchmark.draws,
      win_rate: benchmark.winRateA,
    };
  });
}

const args = parseArgs(process.argv.slice(2));
const tf = await loadTensorflow();
const { dataset, rowSummary, xs, ys } = await loadOrGenerateTrainingInput(tf, args);
const model = makeModel(tf, args);
const iterationSummaries = [];
let finalArtifact = null;

for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
  const history = await model.fit(xs, ys, {
    epochs: args.epochs,
    batchSize: args.batchSize,
    shuffle: false,
    verbose: 0,
  });

  finalArtifact = exportModelArtifact(model, args, dataset, rowSummary, iterationSummaries);
  const normalized = normalizeNeuralPolicyModel(finalArtifact);
  if (!normalized) {
    throw new Error(`exported neural ${args.targetTier} model failed schema validation`);
  }

  const evaluation = evaluateModel(finalArtifact, args, iteration);
  iterationSummaries.push({
    iteration,
    loss: history.history.loss?.at(-1) ?? null,
    accuracy: history.history.acc?.at(-1) ?? history.history.accuracy?.at(-1) ?? null,
    evaluation,
  });
  console.log(
    `target_tier=${args.targetTier} iteration=${iteration} loss=${Number(iterationSummaries.at(-1).loss ?? 0).toFixed(4)} rows=${rowSummary.rows}`,
  );
}

finalArtifact = exportModelArtifact(model, args, dataset, rowSummary, iterationSummaries);
const outPath = resolve(process.cwd(), args.out);
const summaryPath = resolve(process.cwd(), args.summaryOut);
const summary = {
  model_path: outPath,
  target_tier: args.targetTier,
  dataset_hash: dataset.dataset_hash,
  ...(Array.isArray(dataset.dataset_sources) ? { dataset_sources: dataset.dataset_sources } : {}),
  row_summary: rowSummary,
  iteration_summaries: iterationSummaries,
};

await mkdir(dirname(outPath), { recursive: true });
await mkdir(dirname(summaryPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(finalArtifact, null, 2)}\n`, "utf8");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

xs.dispose();
ys.dispose();
model.dispose();

console.log(`wrote ${outPath}`);
console.log(`wrote ${summaryPath}`);
