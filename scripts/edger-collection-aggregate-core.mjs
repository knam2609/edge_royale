import {
  DEFAULT_COLLECTION_OPPONENTS,
  buildCollectionSpecs,
  collectionSpecChecksum,
} from "./edger-collection-core.mjs";

export const EDGER_COLLECTION_AGGREGATE_SCHEMA_VERSION =
  "edger_collection_aggregate_report_v1";

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function exactIndices(results, expectedMatches) {
  const actual = results.map((result) => result.global_match_index);
  return actual.length === expectedMatches &&
    actual.every((value, index) => value === index);
}

export function aggregateCollectionReports(
  reports,
  {
    expectedMatches = 10_000,
    expectedShards = 10,
    seed = 20260718,
    opponents = DEFAULT_COLLECTION_OPPONENTS,
  } = {},
) {
  const errors = [];
  if (reports.length !== expectedShards) {
    errors.push(`expected ${expectedShards} shard reports, received ${reports.length}`);
  }
  const matchesPerShard = expectedMatches / expectedShards;
  const pairsPerShard = matchesPerShard / 2;
  const expectedOffsets = Array.from(
    { length: expectedShards },
    (_, index) => index * pairsPerShard,
  );
  const orderedReports = [...reports].sort(
    (left, right) => left.command?.pair_offset - right.command?.pair_offset,
  );
  const commits = new Set();
  const stores = new Set();
  const results = [];

  for (const [index, report] of orderedReports.entries()) {
    const label = `shard ${index}`;
    if (report?.schema_version !== "edger_collection_report_v1") {
      errors.push(`${label} has an incompatible schema`);
      continue;
    }
    if (report.status !== "passed") {
      errors.push(`${label} did not pass`);
    }
    if ((report.failures ?? []).length !== 0) {
      errors.push(`${label} contains collection failures`);
    }
    if (report.command?.seed !== seed) {
      errors.push(`${label} uses seed ${report.command?.seed}, expected ${seed}`);
    }
    if (report.command?.matches !== matchesPerShard) {
      errors.push(`${label} has ${report.command?.matches} matches, expected ${matchesPerShard}`);
    }
    if (report.command?.pair_offset !== expectedOffsets[index]) {
      errors.push(
        `${label} has pair offset ${report.command?.pair_offset}, expected ${expectedOffsets[index]}`,
      );
    }
    if (JSON.stringify(report.command?.opponents) !== JSON.stringify(opponents)) {
      errors.push(`${label} uses a mixed opponent specification`);
    }
    const expectedSpecs = buildCollectionSpecs({
      matches: matchesPerShard,
      seed,
      pairOffset: expectedOffsets[index],
      opponents,
    });
    if (report.spec_checksum !== collectionSpecChecksum(expectedSpecs)) {
      errors.push(`${label} specification checksum mismatch`);
    }
    const reportResults = report.results ?? [];
    for (let resultIndex = 0; resultIndex < reportResults.length; resultIndex += 1) {
      const actual = reportResults[resultIndex];
      const expected = expectedSpecs[resultIndex];
      if (!expected || [
        "global_match_index",
        "pair_index",
        "seed",
        "edger_actor",
        "opponent",
        "spec_id",
      ].some((key) => actual?.[key] !== expected[key])) {
        errors.push(`${label} result ${resultIndex} does not match its frozen specification`);
        break;
      }
    }
    if (!report.git_provenance?.clean || !report.git_provenance?.commit) {
      errors.push(`${label} lacks clean Git provenance`);
    } else {
      commits.add(report.git_provenance.commit);
    }
    stores.add(report.command?.store);
    if (!report.replay_verification?.all_passed) {
      errors.push(`${label} did not completely verify replays`);
    }
    if (reportResults.length !== matchesPerShard) {
      errors.push(`${label} result count is incomplete`);
    }
    results.push(...reportResults);
  }

  results.sort((left, right) => left.global_match_index - right.global_match_index);
  if (commits.size !== 1) {
    errors.push("collection reports are bound to mixed Git commits");
  }
  if (stores.size !== 1) {
    errors.push("collection reports use mixed corpus stores");
  }
  if (!exactIndices(results, expectedMatches)) {
    errors.push(`global match indices must be exactly 0…${expectedMatches - 1}`);
  }

  const episodeIds = results.map((result) => result.episode_id);
  const uniqueEpisodes = new Set(episodeIds);
  if (uniqueEpisodes.size !== expectedMatches) {
    errors.push("episode IDs must be unique across all shards");
  }
  if (results.some((result) => result.replay_verified !== true)) {
    errors.push("every aggregated episode must have a verified replay");
  }

  const sides = countBy(results.map((result) => result.edger_actor));
  if (
    sides.blue !== expectedMatches / 2 ||
    sides.red !== expectedMatches / 2
  ) {
    errors.push("Edger side counts must be exactly balanced");
  }
  const opponentCounts = countBy(results.map((result) => result.opponent));
  const expectedPerOpponent = expectedMatches / opponents.length;
  for (const opponent of opponents) {
    if (opponentCounts[opponent] !== expectedPerOpponent) {
      errors.push(
        `${opponent} count is ${opponentCounts[opponent] ?? 0}, expected ${expectedPerOpponent}`,
      );
    }
  }
  if (Object.keys(opponentCounts).some((opponent) => !opponents.includes(opponent))) {
    errors.push("aggregated results contain an unexpected opponent");
  }

  const pairs = new Map();
  for (const result of results) {
    const list = pairs.get(result.pair_index) ?? [];
    list.push(result);
    pairs.set(result.pair_index, list);
  }
  if (pairs.size !== expectedMatches / 2) {
    errors.push(`expected ${expectedMatches / 2} paired seeds`);
  }
  for (let pairIndex = 0; pairIndex < expectedMatches / 2; pairIndex += 1) {
    const pair = pairs.get(pairIndex) ?? [];
    if (
      pair.length !== 2 ||
      pair[0]?.seed !== pair[1]?.seed ||
      new Set(pair.map((result) => result.edger_actor)).size !== 2
    ) {
      errors.push(`pair ${pairIndex} is incomplete or inconsistent`);
      break;
    }
  }

  return {
    schema_version: EDGER_COLLECTION_AGGREGATE_SCHEMA_VERSION,
    status: errors.length === 0 ? "passed" : "failed",
    git_commit: commits.size === 1 ? [...commits][0] : null,
    corpus_store: stores.size === 1 ? [...stores][0] : null,
    seed,
    shard_reports: reports.length,
    expected_shard_offsets: expectedOffsets,
    matches: results.length,
    global_index_range: results.length > 0
      ? [results[0].global_match_index, results.at(-1).global_match_index]
      : null,
    paired_seeds: pairs.size,
    edger_sides: sides,
    opponents: opponentCounts,
    unique_episode_ids: uniqueEpisodes.size,
    replay_verification: {
      checked: results.filter((result) => result.replay_verified === true).length,
      all_passed:
        results.length === expectedMatches &&
        results.every((result) => result.replay_verified === true),
    },
    episode_ids: episodeIds,
    errors,
  };
}
