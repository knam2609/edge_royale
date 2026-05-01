import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runBenchmark } from "../src/ai/benchmark.js";
import {
  ACTION_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION,
  MODEL_INPUT_SIZE,
} from "../src/ai/neuralFeatures.js";
import { NEURAL_MODEL_KIND, NEURAL_MODEL_VERSION, normalizeNeuralPolicyModel } from "../src/ai/neuralModel.js";
import { buildActionTrainingRows, summarizeTrainingRows } from "../src/ai/neuralTraining.js";
import { generateTrainingDataset, hashTrainingDataset } from "../src/ai/trainingData.js";

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
  const parsed = {
    seed: 505,
    episodes: 8,
    iterations: 1,
    epochs: 4,
    batchSize: 32,
    learningRate: 0.01,
    maxTicks: 900,
    tiers: ["top", "goat"],
    evalTiers: ["noob", "mid", "top"],
    evalRounds: 4,
    evalMaxTicks: 400,
    maxNegatives: 4,
    hidden1: 32,
    hidden2: 16,
    dataset: null,
    out: "artifacts/training/models/goat-model.json",
    summaryOut: "artifacts/training/models/goat-training-summary.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed" && argv[i + 1]) parsed.seed = Number.parseInt(argv[++i], 10);
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
    else if (arg === "--dataset" && argv[i + 1]) parsed.dataset = argv[++i];
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
  parsed.hidden1 = Number.isFinite(parsed.hidden1) && parsed.hidden1 > 0 ? parsed.hidden1 : 32;
  parsed.hidden2 = Number.isFinite(parsed.hidden2) && parsed.hidden2 > 0 ? parsed.hidden2 : 16;
  parsed.maxNegatives = Number.isFinite(parsed.maxNegatives) && parsed.maxNegatives >= 0 ? parsed.maxNegatives : 4;

  return parsed;
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
      algorithm: "psro_lite_supervised_v1",
      tiers: args.tiers,
      episodes: dataset.episode_count,
      iterations: args.iterations,
      epochs_per_iteration: args.epochs,
      batch_size: args.batchSize,
      learning_rate: args.learningRate,
      max_ticks: args.maxTicks,
      max_negatives_per_decision: args.maxNegatives,
      row_summary: rowSummary,
      iteration_summaries: iterationSummaries,
    },
    layers,
  };
}

async function loadOrGenerateDataset(args) {
  if (args.dataset) {
    const dataset = JSON.parse(await readFile(resolve(process.cwd(), args.dataset), "utf8"));
    return {
      ...dataset,
      dataset_hash: dataset.dataset_hash ?? hashTrainingDataset(dataset),
    };
  }

  return generateTrainingDataset({
    seed: args.seed,
    tiers: args.tiers,
    episodes: args.episodes,
    maxTicks: args.maxTicks,
  });
}

function evaluateModel(modelArtifact, args, iteration) {
  return args.evalTiers.map((tier) => {
    const benchmark = runBenchmark({
      botA: "goat",
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
const dataset = await loadOrGenerateDataset(args);
const rows = buildActionTrainingRows(dataset, { maxNegativesPerDecision: args.maxNegatives });
const rowSummary = summarizeTrainingRows(rows);
if (rows.length === 0) {
  throw new Error("training dataset produced no action rows");
}

const xs = tf.tensor2d(rows.map((row) => row.input), [rows.length, MODEL_INPUT_SIZE]);
const ys = tf.tensor2d(rows.map((row) => [row.label]), [rows.length, 1]);
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
    throw new Error("exported neural Goat model failed schema validation");
  }

  const evaluation = evaluateModel(finalArtifact, args, iteration);
  iterationSummaries.push({
    iteration,
    loss: history.history.loss?.at(-1) ?? null,
    accuracy: history.history.acc?.at(-1) ?? history.history.accuracy?.at(-1) ?? null,
    evaluation,
  });
  console.log(
    `iteration=${iteration} loss=${Number(iterationSummaries.at(-1).loss ?? 0).toFixed(4)} rows=${rows.length}`,
  );
}

finalArtifact = exportModelArtifact(model, args, dataset, rowSummary, iterationSummaries);
const outPath = resolve(process.cwd(), args.out);
const summaryPath = resolve(process.cwd(), args.summaryOut);
const summary = {
  model_path: outPath,
  dataset_hash: dataset.dataset_hash,
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
