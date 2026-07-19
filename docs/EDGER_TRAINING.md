# Edger Cumulative Training

## 1. Status and boundary

The old daily masked-PPO trainer has been removed. It restarted from bootstrap, retained no games, used a short one-tower arena, and could not learn useful state/action interactions.

Edger v2 is a shadow pipeline:

1. persistent full-match corpus
2. structured behavior cloning
3. one conservative offline advantage-weighted actor phase with a frozen behavior-value critic
4. fixed 1%/10%/100% data-scaling proof
5. exact-JavaScript snapshot-league IMPALA/V-trace campaigns
6. separate reviewed promotion after every v2 gate passes

The live browser model remains v1. The fixed deck, exact hidden opponent information, deterministic simulator, synchronous generated JavaScript runtime, and Edger-only product scope remain unchanged.

## 2. Authoritative data

### `edger_training_episode_v1`

An immutable episode contains:

- production seed
- exact 18×32 Royale arena descriptor
- all six initial tower entities
- initial hands and deck queues
- rules, simulator, replay, observation, action, and reward versions
- blue/red policy and checkpoint IDs
- complete accepted action stream and sparse decision stream
- 1–200 tick next-decision delays
- behavior log-probabilities when known
- match result, final state hash, replay events, and replay checksum
- source (`simulator` or `opted_in_player`)
- SHA-256 content ID

The validator rejects identity fields. Browser exports are manual, contain no identity, and never upload automatically. The developer importer replays the file before creating an authoritative episode. Human samples can train BC and offline improvement; their unknown behavior probabilities make them ineligible for V-trace.

Raw objects are gzip-compressed and content-addressed:

```text
<store>/objects/sha256/<first-two-hex>/<episode-id>.edger-episode.json.gz
```

`<store>` may be a local directory or `s3://bucket/prefix`. S3 access uses the standard AWS CLI credential chain. Writes are idempotent by episode hash. Invalid or incompatible payloads go to the quarantine prefix.

Simulator collection precomputes immutable paired specifications before worker
threads start. A pair uses the same seed from blue and red; opponents rotate
equally through `edger_heuristic`, `random`, `aggressive`, and `defender`.
`--pair-offset` gives shards stable global pair indices. Results are always
sorted by global match index.

Every completed specification writes `edger_collection_receipt_v1` under a
SHA-256 specification key. A receipt is skipped only after the stored episode
checksum and full replay have been verified. Interrupted runs keep completed
episodes, resume without duplicates, and allow the 64-game pilot to remain part
of the 10,000-game corpus. `edger_collection_report_v1` records clean full-SHA
provenance, the spec checksum, timings, episode IDs, replay status, coverage,
deduplication/resumption, and failures.

### `edger_decision_sequence_v1`

Decision derivation replays the exact JavaScript simulator and records:

- relative-side observation
- legal card, placement, and delay masks
- selected action and delay
- versioned potential-shaped reward
- behavior log-probability
- opponent stratum
- source and V-trace eligibility

Long waits are represented by deterministic `PASS` decisions at most every 200 ticks, not per-frame PASS labels.

### `edger_dataset_manifest_v1`

Manifests are immutable lists of object URIs and compressed checksums for one compatibility cohort. Whole games are split by `SHA-256 episode ID mod 100`:

- 0–79: train
- 80–89: validation
- 90–99: test

The split is stable across machines and worker counts. Disposable PyTorch caches use Parquet with Zstd compression. The default selected mix contains all simulator episodes and no more than 10% opted-in player episodes. Per-sample weights balance source, opponent stratum, and outcome.

## 3. Compact v2 policy

Schema: `edger_policy_model_v2`

Observation:

- `32×18×24` relative-side board
- 96 global features
- full oracle elixir, hands, queues, phase, timing, tower/pocket state, motion, targeting, cooldown, and pending-effect state
- blue observations rotate 180 degrees so the acting side has one canonical orientation

Actor:

- one same-padded 16-channel `3×3` convolution and two 16-channel `1×1` convolutions
- `96→64` global encoder
- 64-wide fused state
- masked `PASS`/fixed-card head
- conditioned row-major `18×32` placement head
- conditioned 1–200 tick delay head
- stable production order: PASS, fixed deck, row-major `(y,x)`, ascending delay

The exported actor has 36,402 parameters and must stay under 50,000 parameters and 1 MB. The opponent-stratum embedding and value head exist only in PyTorch checkpoints. V2 inference never calls the handcrafted prior.

PyTorch dense weights are transposed into input-major generated-JS arrays. Golden fixtures require maximum logit error at or below `1e-5` and identical masked argmax.

## 4. Learning

Behavior cloning trains the factorized joint action loss and behavior-value critic over the entire compatible corpus. If league ratings exist, it then makes one 10× lower-learning-rate pass over winner-side samples from top-quartile policies.

The critic:

- receives opponent stratum only in its training-only branch
- uses terminal `+1/0/−1`
- uses `edger_potential_reward_v1` crown/tower potential shaping
- discounts by `0.9997^Δtick`

Offline improvement freezes the BC reference and critic:

```text
A = G - Vβ
weight = clip(exp(A / 0.25), 0.1, 20)
```

The actor rolls back and stops if validation KL from BC exceeds `0.05` nats.

Every checkpoint is immutable and contains parent checkpoint ID, optimizer state, seeds, manifest hash, dataset checksum, Git commit, environment versions, and metrics. Later phases warm-start from an accepted v2 checkpoint.

## 5. Scaling and snapshot league

`npm run edger:dataset -- --scales-dir ...` produces immutable selected
manifests plus Parquet/Zstd caches for fixed 1%, 10%, and 100% subsets. Only
training episodes are reduced: 1% train is a subset of 10% train, which is a
subset of 100% train. Every scale contains the complete, byte-identical
validation and test episode ID lists.

`npm run edger:evaluate:scaling` emits
`edger_frozen_league_report_v1`. Every candidate plays 40 games each against
live v1, the frozen heuristic, random, aggressive, and defender. Every seed is
played from both sides; the reported score is the equally weighted mean of the
five matchups. Reports bind the candidate model and checkpoint checksums, frozen
suite checksum, illegal-action count, and replay checks.

`edger_data_scaling_report_v1` validates all three manifests, checkpoints,
models, and frozen reports before it passes only when:

- 100% held-out joint action loss improves over 10%
- 100% frozen-league score does not regress from 10%

League training refuses to start without both facts.

Production campaigns use 16–32 Node worker threads and pre-assign paired match specs, making rollout seeds and sides independent of worker count. The exact JavaScript simulator writes full verified episodes before the PyTorch learner runs.

League limits:

- frozen heuristic
- current champion
- up to seven promoted historical snapshots
- up to four non-dominated contenders

Opponent allocation:

- 40% current champion
- 20% heuristic
- 20% uniform historical
- 20% PFSP over history/contenders with `(1−score)²+0.05`

Every selected seed is played from both sides. Only simulator decisions with known behavior log-probabilities enter V-trace. Importance and trace coefficients are clipped at 1.

## 6. Scheduling

`.github/workflows/edger-corpus-health.yml` replaces daily training. It performs a deterministic canary, compatible-manifest rebuild, deduplication/health reporting, and trigger calculation.

`.github/workflows/edger-corpus-collect.yml` is the manual production collector.
It requires an externally supplied `s3://` `EDGER_CORPUS_STORE`, performs an S3
read/write preflight, and launches ten parallel 1,000-game shards at pair
offsets `0,500,…,4500`, with four workers per hosted runner. CI never falls back
to an ephemeral local corpus.

A cumulative campaign becomes due when:

- compatible games grow by at least 20%, or
- at least 100,000 compatible games are new,

subject to a 14-day cooldown. A 30-day backstop triggers when any new data exists. State can live beside an S3 corpus.

`.github/workflows/edger-campaign.yml` runs post-scaling campaigns and retains failed outputs. A successful candidate runs the full evaluator, prepares the checksum-bound promoted artifact, and opens a reviewable pull request. A failed or incomplete report never changes the live artifact.

## 7. Commands

```bash
npm run edger:corpus:collect
npm run edger:corpus:import -- --file <manual-replay.json>
npm run edger:corpus:validate
npm run edger:corpus:manifest -- --out <manifest.json>
npm run edger:corpus:health -- --manifest <manifest.json> --report <health.json>
npm run edger:dataset -- --manifest <manifest.json> --out <cache.parquet>
npm run edger:train:bc -- --dataset <cache.parquet> --out <bc.pt>
npm run edger:train:offline -- --dataset <cache.parquet> --checkpoint <bc.pt> --out <offline.pt>
npm run edger:evaluate:scaling -- --candidate <candidate.json> --checkpoint <bc.pt> --out <frozen-report.json>
npm run edger:scaling:report -- <three-checkpoint-and-league arguments>
npm run edger:train:league -- <campaign arguments>
npm run edger:benchmark:throughput -- --candidate <candidate.json> --workers 16 --enforce
npm run edger:export:v2 -- --checkpoint <candidate.pt> --out <candidate.json>
npm run edger:generate:v2 -- --model <candidate.json> --out <candidate.js>
npm run edger:evaluate:v2 -- <candidate/champion/anchor/reference/external-report arguments>
npm run edger:promote:v2 -- --model <candidate.json> --report <full-report.json>
```

## 8. Promotion gate

The corpus, BC, offline-improvement, scaling, league/V-trace, parity, large-sample evaluator, checksum-bound promotion, and campaign PR foundations are implemented. V2 remains shadow-only until a real full report passes:

- paired champion bootstrap bounds
- heuristic and anchor non-regression bounds
- weak-baseline floors
- frozen-league improvement/worst-anchor floors
- 10,000-match illegal-action and repeatability proof
- tactical, replay, determinism, full-suite, browser, and `p95 ≤ 5 ms` gates

Failed campaigns retain reports/checkpoints and never update the promoted artifact.
