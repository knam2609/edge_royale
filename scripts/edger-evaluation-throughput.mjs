#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEdgerV2BootstrapModel } from "../src/ai/v2/policy.js";
import { canonicalJson } from "./edger-corpus-core.mjs";
import { executeEdgerV2EvaluationSpecs } from "./edger-v2-evaluation-core.mjs";

function parseArgs(argv) {
  const parsed = {
    candidate: null,
    out: null,
    matches: 32,
    workers: 16,
    seed: 20260718,
    targetMatches: 11_300,
    maxMinutes: 180,
    enforce: false,
    referenceHardware: "unspecified",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate" && argv[index + 1]) {
      parsed.candidate = argv[++index];
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--matches" && argv[index + 1]) {
      parsed.matches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--target-matches" && argv[index + 1]) {
      parsed.targetMatches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-minutes" && argv[index + 1]) {
      parsed.maxMinutes = Number.parseFloat(argv[++index]);
    } else if (arg === "--reference-hardware" && argv[index + 1]) {
      parsed.referenceHardware = argv[++index];
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    }
  }
  if (!Number.isInteger(parsed.matches) || parsed.matches < 2 || parsed.matches % 2 !== 0) {
    throw new Error("--matches must be a positive even integer");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be 1-32");
  }
  return parsed;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildSpecs(args) {
  const specs = [];
  for (let pairIndex = 0; pairIndex < args.matches / 2; pairIndex += 1) {
    for (const candidateActor of ["blue", "red"]) {
      specs.push({
        spec_id: specs.length,
        group: "throughput",
        block: null,
        pair_id: `throughput|${pairIndex}`,
        seed: args.seed + pairIndex,
        candidate_actor: candidateActor,
        opponent: {
          kind: "bot",
          policy_id: "edger_heuristic",
          checkpoint_id: null,
        },
        verify_replay: false,
      });
    }
  }
  return specs;
}

const args = parseArgs(process.argv.slice(2));
const temporaryRoot = args.candidate
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "edger-throughput-"));
const candidatePath = args.candidate
  ? path.resolve(args.candidate)
  : path.join(temporaryRoot, "bootstrap-v2.json");

try {
  if (!args.candidate) {
    fs.writeFileSync(candidatePath, canonicalJson(createEdgerV2BootstrapModel()));
  }
  const specs = buildSpecs(args);
  const startedAt = performance.now();
  const results = await executeEdgerV2EvaluationSpecs({
    candidateModelPath: candidatePath,
    specs,
    workers: args.workers,
  });
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const aggregateMatchesPerSecond = results.length / elapsedSeconds;
  const projectedMinutes = args.targetMatches / aggregateMatchesPerSecond / 60;
  const report = {
    schema_version: "edger_exact_js_throughput_report_v1",
    reference_hardware: args.referenceHardware,
    node_version: process.version,
    architecture: process.arch,
    workers: args.workers,
    measured_matches: results.length,
    elapsed_seconds: elapsedSeconds,
    aggregate_matches_per_second: aggregateMatchesPerSecond,
    target_matches: args.targetMatches,
    projected_minutes: projectedMinutes,
    maximum_minutes: args.maxMinutes,
    passed: projectedMinutes <= args.maxMinutes,
    specs_checksum: sha256Json(specs),
    results_checksum: sha256Json(results),
  };
  if (args.out) {
    const output = path.resolve(args.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, canonicalJson(report));
  }
  console.log(canonicalJson(report).trimEnd());
  if (args.enforce && !report.passed) {
    process.exitCode = 2;
  }
} finally {
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
