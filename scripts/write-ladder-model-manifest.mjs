import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_LADDER_MODEL_MANIFEST_PATH,
  FAIR_LADDER_MODEL_TIERS,
  createEnabledLadderModelManifest,
} from "../src/ai/ladderModelManifest.js";

function parseArgs(argv) {
  const parsed = {
    out: DEFAULT_LADDER_MODEL_MANIFEST_PATH,
    modelsByTier: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      parsed.out = argv[++i];
      continue;
    }
    if (arg === "--tier" && argv[i + 2]) {
      const tierId = argv[++i].trim();
      const modelPath = argv[++i].trim();
      if (FAIR_LADDER_MODEL_TIERS.includes(tierId)) {
        parsed.modelsByTier[tierId] = modelPath;
      }
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const manifest = createEnabledLadderModelManifest(args.modelsByTier);
const outPath = resolve(process.cwd(), args.out);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`ladder_model_manifest=${args.out}`);
