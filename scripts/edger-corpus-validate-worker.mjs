import { gunzipSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";

import {
  readCompressedEpisodeBytes,
  sha256Hex,
  validateTrainingEpisode,
  verifyTrainingEpisodeReplay,
} from "./edger-corpus-core.mjs";

for (const entry of workerData.entries) {
  try {
    const compressed = readCompressedEpisodeBytes(entry.uri);
    const compressedChecksum = sha256Hex(compressed);
    if (entry.checksum && compressedChecksum !== entry.checksum) {
      throw new Error(
        `compressed checksum mismatch: ${compressedChecksum} != ${entry.checksum}`,
      );
    }
    const episode = validateTrainingEpisode(
      JSON.parse(gunzipSync(compressed).toString("utf8")),
    );
    if (entry.episode_id && episode.episode_id !== entry.episode_id) {
      throw new Error(
        `episode ID mismatch: ${episode.episode_id} != ${entry.episode_id}`,
      );
    }
    const replay = verifyTrainingEpisodeReplay(episode);
    parentPort.postMessage({
      type: "result",
      result: {
        index: entry.index,
        uri: entry.uri,
        episode_id: episode.episode_id,
        compressed_checksum: compressedChecksum,
        schema_verified: true,
        checksum_verified: entry.checksum ? true : null,
        episode_id_verified: entry.episode_id ? true : null,
        actions: replay.actions,
        events: replay.events,
        result_verified: true,
        final_state_hash: replay.final_state_hash,
        replay_checksum: replay.replay_checksum,
        replay_verified: true,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      type: "failure",
      failure: {
        index: entry.index,
        uri: entry.uri,
        episode_id: entry.episode_id ?? null,
        error: error instanceof Error ? error.stack : String(error),
      },
    });
  }
}

parentPort.postMessage({ type: "done" });
