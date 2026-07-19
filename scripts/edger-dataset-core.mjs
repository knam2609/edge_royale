import { sha256Hex, splitForEpisodeId } from "./edger-corpus-core.mjs";

export function deterministicTrainingScale(shards, fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("scale fraction must be greater than 0 and at most 1");
  }
  const training = shards
    .filter((shard) => splitForEpisodeId(shard.episode_id) === "train")
    .sort((left, right) => {
      const leftHash = sha256Hex(`${left.episode_id}|scale`);
      const rightHash = sha256Hex(`${right.episode_id}|scale`);
      return leftHash.localeCompare(rightHash);
    });
  const heldOut = shards.filter(
    (shard) => splitForEpisodeId(shard.episode_id) !== "train",
  );
  const selectedTraining = fraction >= 1
    ? training
    : training.slice(0, training.length === 0
      ? 0
      : Math.max(1, Math.ceil(training.length * fraction)));
  return [...selectedTraining, ...heldOut].sort(
    (left, right) => left.episode_id.localeCompare(right.episode_id),
  );
}
