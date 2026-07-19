#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "./edger-corpus-core.mjs";
import { aggregateCollectionReports } from "./edger-collection-aggregate-core.mjs";

function parseArgs(argv) {
  const parsed = { reports: [], out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report" && argv[index + 1]) {
      parsed.reports.push(argv[++index]);
    } else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[++index];
    } else if (!arg.startsWith("--")) {
      parsed.reports.push(arg);
    }
  }
  if (parsed.reports.length === 0 || !parsed.out) {
    throw new Error("usage: edger:collection:aggregate --report FILE... --out FILE");
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const reports = args.reports.map((filePath) =>
    JSON.parse(fs.readFileSync(filePath, "utf8")));
  const aggregate = aggregateCollectionReports(reports);
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canonicalJson(aggregate));
  console.log(canonicalJson({
    command: "collection-aggregate",
    report: output,
    status: aggregate.status,
    matches: aggregate.matches,
    paired_seeds: aggregate.paired_seeds,
    errors: aggregate.errors,
  }).trimEnd());
  if (aggregate.status !== "passed") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
