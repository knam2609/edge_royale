import { parentPort, workerData } from "node:worker_threads";

import { collectAndStoreSpec } from "./edger-collection-core.mjs";

for (const spec of workerData.specs) {
  const startedAt = performance.now();
  try {
    const result = collectAndStoreSpec({
      spec,
      store: workerData.store,
      provenance: workerData.provenance,
    });
    parentPort.postMessage({
      type: "result",
      result: {
        ...result,
        elapsed_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      type: "failure",
      failure: {
        global_match_index: spec.global_match_index,
        pair_index: spec.pair_index,
        seed: spec.seed,
        edger_actor: spec.edger_actor,
        opponent: spec.opponent,
        spec_id: spec.spec_id,
        error: error instanceof Error ? error.stack : String(error),
      },
    });
  }
}

parentPort.postMessage({ type: "done" });
