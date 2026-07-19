#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  EDGER_V2_EVALUATION_PROFILES,
  evaluateEdgerV2Candidate,
} from "./edger-v2-evaluation-core.mjs";

function parseArgs(argv) {
  const parsed = {
    candidate: null,
    champion: "artifacts/edger-training/promoted/edger_policy_current.json",
    anchors: [],
    reference: null,
    testReport: null,
    browserReport: null,
    out: null,
    profile: "full",
    seed: 20260718,
    workers: 16,
    referenceHardware: "unspecified",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate" && argv[index + 1]) {
      parsed.candidate = argv[++index];
    } else if (arg === "--champion" && argv[index + 1]) {
      parsed.champion = argv[++index];
    } else if (arg === "--anchors" && argv[index + 1]) {
      parsed.anchors = argv[++index].split(",").filter(Boolean);
    } else if (arg === "--reference" && argv[index + 1]) {
      parsed.reference = argv[++index];
    } else if (arg === "--test-report" && argv[index + 1]) {
      parsed.testReport = argv[++index];
    } else if (arg === "--browser-report" && argv[index + 1]) {
      parsed.browserReport = argv[++index];
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (arg === "--profile" && argv[index + 1]) {
      parsed.profile = argv[++index];
    } else if (arg === "--seed" && argv[index + 1]) {
      parsed.seed = Number.parseInt(argv[++index], 10);
    } else if (arg === "--workers" && argv[index + 1]) {
      parsed.workers = Number.parseInt(argv[++index], 10);
    } else if (arg === "--reference-hardware" && argv[index + 1]) {
      parsed.referenceHardware = argv[++index];
    }
  }
  if (!parsed.candidate || !parsed.out) {
    throw new Error("--candidate and --out are required");
  }
  if (!EDGER_V2_EVALUATION_PROFILES[parsed.profile]) {
    throw new Error("--profile must be full or smoke");
  }
  if (!Number.isInteger(parsed.workers) || parsed.workers < 1 || parsed.workers > 32) {
    throw new Error("--workers must be 1-32");
  }
  if (parsed.anchors.length > 4) {
    throw new Error("at most four promoted anchors may be evaluated");
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateEdgerV2Candidate({
    candidateModelPath: args.candidate,
    championModelPath: args.champion,
    anchorModelPaths: args.anchors,
    referenceReportPath: args.reference,
    testReportPath: args.testReport,
    browserReportPath: args.browserReport,
    profileName: args.profile,
    seed: args.seed,
    workers: args.workers,
    referenceHardware: args.referenceHardware,
  });
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${output}`);
  console.log(`generated_matches=${report.generated_matches}`);
  console.log(`promotion_passed=${report.promotion.passed ? "yes" : "no"}`);
  for (const failure of report.promotion.failures) {
    console.log(`promotion_gate_failed: ${failure}`);
  }
  if (!report.promotion.passed) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
