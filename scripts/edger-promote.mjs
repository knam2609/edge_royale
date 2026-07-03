import process from "node:process";

import {
  DEFAULT_GENERATED_JS_PATH,
  DEFAULT_PROMOTED_MODEL_PATH,
  loadModelJson,
  writeGeneratedJs,
  writeJsonFile,
} from "./edger-model-utils.mjs";

function parseArgs(argv) {
  const parsed = {
    model: DEFAULT_PROMOTED_MODEL_PATH,
    out: DEFAULT_PROMOTED_MODEL_PATH,
    jsOut: DEFAULT_GENERATED_JS_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      parsed.model = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      parsed.out = argv[++i];
    } else if (arg === "--js-out" && argv[i + 1]) {
      parsed.jsOut = argv[++i];
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const model = loadModelJson(args.model);
writeJsonFile(args.out, model);
writeGeneratedJs(args.jsOut, model);

console.log(`promoted ${args.model}`);
console.log(`wrote ${args.out}`);
console.log(`wrote ${args.jsOut}`);
