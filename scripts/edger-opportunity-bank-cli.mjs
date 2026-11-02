#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readDatasetManifest, canonicalJson } from "./edger-corpus-core.mjs";
import { buildOpportunityBank } from "./edger-opportunity-bank.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--out") {
  throw new Error("usage: node scripts/edger-opportunity-bank-cli.mjs --manifest <local-manifest.json> --out <bank.json>");
}
const bank = buildOpportunityBank(readDatasetManifest(args[1]));
fs.mkdirSync(path.dirname(path.resolve(args[3])), { recursive: true });
fs.writeFileSync(args[3], canonicalJson(bank));
console.log(JSON.stringify({ bank_sha256: bank.bank_sha256, episodes: bank.episodes.length, entries: bank.entries.length }));
