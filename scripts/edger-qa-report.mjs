#!/usr/bin/env node
// External QA reports (edger_external_qa_report_v1) for the v2 full
// evaluation, whose full_test_suite and browser_smoke gates require a passed
// report at the candidate's training commit. The production driver writes them
// in its qa stage; this command writes the same reports locally (candidate
// campaign, docs/EDGER_CANDIDATE_CAMPAIGN.md). It runs the command itself and
// writes the report only if the command exits 0 and the checkout is clean, at
// the same commit, before and after.
//
//   node scripts/edger-qa-report.mjs --kind npm-test|browser-smoke --out FILE [-- extra npm arguments]

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EDGER_EXTERNAL_QA_REPORT_SCHEMA = "edger_external_qa_report_v1";

export const EDGER_EXTERNAL_QA_KINDS = Object.freeze({
  "npm-test": Object.freeze(["test"]),
  "browser-smoke": Object.freeze(["run", "smoke:browser"]),
});

export function edgerExternalQaCommand(kind, extraArgs = []) {
  const npmArgs = EDGER_EXTERNAL_QA_KINDS[kind];
  if (!npmArgs) {
    throw new Error(`--kind must be one of ${Object.keys(EDGER_EXTERNAL_QA_KINDS).join(", ")}`);
  }
  const args = extraArgs.length > 0 ? [...npmArgs, "--", ...extraArgs] : [...npmArgs];
  return { file: "npm", args, command: ["npm", ...args].join(" ") };
}

// Key order and content match the production driver's qa stage.
export function buildEdgerExternalQaReport({ kind, command, gitCommit }) {
  if (!EDGER_EXTERNAL_QA_KINDS[kind]) {
    throw new Error(`unknown QA report kind ${kind}`);
  }
  if (typeof gitCommit !== "string" || !/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new Error("a QA report needs the full Git commit it ran at");
  }
  return {
    schema_version: EDGER_EXTERNAL_QA_REPORT_SCHEMA,
    kind,
    command,
    git_commit: gitCommit,
    passed: true,
  };
}

export function serializeEdgerExternalQaReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function cleanCommit(cwd) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return { commit, clean: status === "", status };
}

// Returns the report written, or throws without writing one.
export function writeEdgerExternalQaReport({ kind, out, extraArgs = [], cwd = process.cwd(), run = null }) {
  const output = path.resolve(out);
  if (fs.existsSync(output)) {
    throw new Error(`QA report already exists: ${output}`);
  }
  const { file, args, command } = edgerExternalQaCommand(kind, extraArgs);
  const before = cleanCommit(cwd);
  if (!before.clean) {
    throw new Error(`QA reports need a clean checkout; found:\n${before.status}`);
  }
  const result = (run ?? ((commandFile, commandArgs) =>
    spawnSync(commandFile, commandArgs, { cwd, stdio: "inherit", env: process.env })))(file, args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? result.signal}; no report written`);
  }
  const after = cleanCommit(cwd);
  if (after.commit !== before.commit || !after.clean) {
    throw new Error(`the checkout changed while ${command} ran; no report written`);
  }
  const report = buildEdgerExternalQaReport({ kind, command, gitCommit: before.commit });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serializeEdgerExternalQaReport(report), { flag: "wx" });
  return report;
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const extraArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = { kind: null, out: null, extraArgs };
  for (let index = 0; index < own.length; index += 1) {
    if (own[index] === "--kind" && own[index + 1]) {
      parsed.kind = own[++index];
    } else if (own[index] === "--out" && own[index + 1]) {
      parsed.out = own[++index];
    } else {
      throw new Error(`unknown argument ${own[index]}`);
    }
  }
  if (!parsed.kind || !parsed.out) {
    throw new Error("--kind and --out are required");
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = writeEdgerExternalQaReport({ kind: args.kind, out: args.out, extraArgs: args.extraArgs });
    console.log(JSON.stringify({ out: path.resolve(args.out), ...report }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
