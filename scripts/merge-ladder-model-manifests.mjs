import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  LADDER_MODEL_MANIFEST_VERSION,
  normalizeLadderModelManifest,
} from "../src/ai/ladderModelManifest.js";

function parseArgs(argv) {
  const parsed = {
    out: null,
    manifests: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) parsed.out = argv[++i];
    else if (arg === "--manifest" && argv[i + 1]) parsed.manifests.push(argv[++i]);
  }

  if (!parsed.out) {
    throw new Error("missing --out path");
  }
  if (parsed.manifests.length === 0) {
    throw new Error("missing --manifest path");
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const tiers = {};

for (const manifestPath of args.manifests) {
  const raw = JSON.parse(await readFile(resolve(process.cwd(), manifestPath), "utf8"));
  const manifest = normalizeLadderModelManifest(raw);
  for (const [tierId, entry] of Object.entries(manifest.tiers)) {
    tiers[tierId] = entry;
  }
}

const outPath = resolve(process.cwd(), args.out);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  `${JSON.stringify({ version: LADDER_MODEL_MANIFEST_VERSION, tiers }, null, 2)}\n`,
  "utf8",
);

console.log(`merged_ladder_model_manifest=${args.out}`);
