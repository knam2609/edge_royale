# edge_royale

`edge_royale` is a lightweight, single-player Clash Royale-inspired browser game.

The shipped game is human vs **Edger** only:

- one six-tower Royale arena with pocket placement
- one fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball
- deterministic simulation
- one deterministic offline-trained policy bot, Edger
- simple local match stats against Edger
- replay hooks for deterministic debugging and opted-in training export

There are no player-facing bot levels, unlock gates, model selectors, self-play mirror mode, or browser training controls.

## Runtime model

Since the owner approved it on November 25, 2026 (merged into `edger-v2-accumulated` November 26; unpushed, so `main` keeps v1), the live browser opponent imports the promoted `edger_policy_model_v2` artifact `edger_v2_candidate_20261123-L_c3` synchronously from `src/ai/generated/edgerPolicyCurrent.js`. It plays the full grid with its own learned decision delay. It passed every safety, quality, replay, timing, test, and browser gate of the full evaluation before the owner approved it ([result](docs/EDGER_CANDIDATE_CAMPAIGN.md#owner-promotion-decision-november-25-2026)). The retired v1 bootstrap (`edger_policy_model_v1`) is kept byte for byte in `artifacts/edger-training/retired/edger_policy_bootstrap_20260701/`. Any later v2 model must again pass a full evaluation and a separate owner approval. The fixed 1%/10%/100% data-scaling proof gates the production league-training path, not promotion (owner, November 23, 2026; [candidate campaign review](docs/EDGER_CANDIDATE_CAMPAIGN.md)).

V2 uses:

- a relative-side `32×18×24` board (24 entity/effect channels) and 104 full-oracle global features (96 plus 8 spell-opportunity inputs), observation schema `edger_oracle_observation_v4`
- masked autoregressive card, row-major placement, and 1–200 tick delay heads
- deterministic argmax and stable ties in production
- no handcrafted heuristic prior
- 36,914 exported actor parameters, below the 50,000 parameter and 1 MB limits

The frozen handcrafted oracle remains `edger_heuristic` (alias `heuristic`) for corpus teaching, league opposition, and evaluation only.

## Run the game

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`.

The repository pins native Node 20 through `.node-version`. Browser validation
also requires `npx playwright install chromium`. On the current local host, run
the full suite with `PYTHON=/usr/local/bin/python3 npm test` to use the installed
PyTorch/pyarrow interpreter.

Controls:

- Click a card slot, or press `1-4`, to select a hand card.
- Click or drag onto the arena to play.
- `Space` pauses, `R` resets, and `F` toggles fullscreen.
- After a match, **Export replay** downloads an identity-free file. Nothing is uploaded automatically.

Browser automation hooks:

- `window.render_game_to_text()`
- `window.advanceTime(ms)`

## Cumulative Edger training

Raw runs and caches remain ignored. Immutable promoted and retired (`artifacts/edger-training/retired/`) artifacts remain tracked.

```bash
# Collect paired full production matches. Production uses an externally configured S3 URI.
npm run edger:corpus:collect -- \
  --store "$EDGER_CORPUS_STORE" \
  --matches 64 \
  --workers 8 \
  --pair-offset 0 \
  --seed 20260718 \
  --opponents edger_heuristic,random,aggressive,defender \
  --report /path/to/collection-report.json

# Validate and import a manually opted-in replay.
npm run edger:corpus:import -- --file /path/to/edge-royale-replay.json

npm run edger:corpus:manifest -- --out /private/tmp/edger_manifest.json
npm run edger:corpus:validate -- \
  --manifest /private/tmp/edger_manifest.json \
  --workers 16 \
  --report /private/tmp/edger_validation.json

# Build disposable Parquet/Zstd caches, including fixed scaling subsets.
npm run edger:dataset -- \
  --manifest /private/tmp/edger_manifest.json \
  --scales-dir /private/tmp/edger_scales

# Structured behavior cloning, conservative offline improvement, and export.
npm run edger:train:bc -- \
  --dataset /private/tmp/edger_scales/edger_decisions_100pct.parquet \
  --out /private/tmp/edger_bc.pt
npm run edger:train:offline -- \
  --dataset /private/tmp/edger_scales/edger_decisions_100pct.parquet \
  --checkpoint /private/tmp/edger_bc.pt \
  --out /private/tmp/edger_offline.pt
npm run edger:export:v2 -- \
  --checkpoint /private/tmp/edger_offline.pt \
  --out /private/tmp/edger_policy_v2_candidate.json
npm run edger:generate:v2 -- \
  --model /private/tmp/edger_policy_v2_candidate.json \
  --out /private/tmp/edgerPolicyV2Candidate.js
```

Collection requires a clean Git worktree, records the full commit SHA, writes
one verified compatibility/seed/side/opponent receipt per match, and resumes
safely from those receipts. Match specifications and report results are stable
across worker counts. `.github/workflows/edger-corpus-collect.yml` runs the
production 10,000-match collection as ten resumable 1,000-game S3 shards.
Its aggregator rejects gaps, overlaps, duplicate episodes, mixed commits or
specifications, wrong side/opponent counts, failures, and incomplete replay
verification before freezing the manifest.

Cache construction is bounded-memory: it counts balancing strata in a first
pass, streams decision rows in a second pass, and writes deterministic 256-row
Parquet groups. BC and offline improvement iterate deterministically shuffled
row groups and batches. V-trace visits episodes in source manifest order and
refreshes targets immediately before each episode's optimizer update. Gradient
microbatches bound activation memory without changing parameters mid-episode.

Scaling caches reduce only training episodes. Validation and test episode lists
are identical in the 1%, 10%, and 100% manifests. Export each BC checkpoint,
then run the same 200-game frozen suite:

```bash
npm run edger:evaluate:scaling -- \
  --candidate /path/to/edger-policy-1pct.json \
  --checkpoint /path/to/edger-bc-1pct.pt \
  --workers 16 \
  --out /path/to/frozen-league-1pct.json
```

Repeat for 10% and 100%, then build the bound scaling report with all three
manifests, checkpoints, candidate models, and frozen-league reports. It rejects
non-nested training sets, changed held-out sets, or any manifest, checkpoint,
model, or suite checksum mismatch.

Snapshot-league IMPALA/V-trace is guarded by a passing fixed 1%/10%/100% scaling report:

```bash
npm run edger:train:league -- \
  --scaling-report /path/to/scaling_report.json \
  --shadow-parent-model /path/to/accepted_offline_shadow.json \
  --shadow-parent-checkpoint /path/to/accepted_offline_shadow.pt \
  --live-champion-model artifacts/edger-training/promoted/edger_policy_current.json \
  --live-champion-reference /path/to/live-v1-reference.json \
  --historical-anchors /path/to/anchor-1.json,/path/to/anchor-2.json \
  --base-manifest /path/to/frozen-10000-game-manifest.json \
  --rollout-store s3://bucket/campaigns/current/league-production/rollout \
  --dataset-out /private/tmp/league.parquet \
  --out-checkpoint /private/tmp/league_candidate.pt
```

The base manifest plus only that command's rollout forms the learner dataset.
Use a different rollout prefix for the 32-game smoke so smoke episodes cannot
enter production lineage.

See `docs/EDGER_TRAINING.md` for schemas, object layout, learning rules, league allocation, and campaign triggers.

## First production campaign infrastructure

`infra/edger-campaign.yaml` provisions the retained encrypted/versioned private
bucket, a `main`-only GitHub OIDC role, an SSM instance profile, and an
egress-only campaign VPC in `ap-southeast-2`. It uses no AWS access keys,
inbound ports, or SSH key.

The retained `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33` scaling artifacts are
recovered only through checked-in
`artifacts/edger-training/recovery/edger_scaling_recovery_v1.json`. It pins
every source S3 URI, object version, SHA-256, binding, metric, suite checksum,
and failure reason. The canonical-schema correction targets the fresh
`campaigns/20260904-v2-recovery`; failed `20260903-v2-recovery`, the source
campaign, and consumed `20260810-v2-recovery` stay immutable. The corrected
schema pin and lossless content-hash check require a new reviewed SHA before
dispatch.

```bash
npm run edger:campaign:remote -- launch \
  --campaign-uri s3://edge-royale-edger-REDACTED-ACCOUNT-ID-ap-southeast-2/campaigns/20260904-v2-recovery \
  --git-sha <full-reviewed-sha> \
  --target-stage full-cache \
  --scaling-recovery-manifest artifacts/edger-training/recovery/edger_scaling_recovery_v1.json \
  --run-label manual-1
```

Launch creates an on-demand `c7g.4xlarge` Amazon Linux 2023 arm64 instance with
encrypted 200 GiB gp3 storage, instance-initiated termination, and a 24-hour
safety shutdown. Dispatch targets are `full-cache`, `offline`, then
`full-evaluation`. `full-cache` rebuilds and durably stores only the recovered
100% Parquet; later runners checksum-download that exact cache. Stage records
and objects bind one Git SHA plus recovery-manifest checksum. Failed stages
preserve evidence and never change live Edger. Separate `promote` operation
requires matching full-evaluation marker and zero active runners, then opens an
unmerged manual-review PR after revalidating candidate/report checksums.

## Validation

```bash
npm test
npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
npm run smoke:browser
npm run edger:canary -- --seed 20260718 --canary-ticks 80
npm run edger:benchmark:throughput -- \
  --candidate /path/to/candidate.json \
  --matches 32 \
  --workers 16 \
  --target-matches 11300 \
  --max-minutes 180 \
  --enforce
npm run edger:reference:v2 -- \
  --champion artifacts/edger-training/promoted/edger_policy_current.json \
  --anchors /path/to/anchor-1.json,/path/to/anchor-2.json \
  --workers 16 \
  --out /path/to/live-v1-reference.json
```

V2 has a separate full evaluator and checksum-bound promotion command:

```bash
npm run edger:evaluate:v2 -- \
  --candidate /path/to/candidate.json \
  --champion /path/to/champion.json \
  --anchors /path/to/anchor-1.json,/path/to/anchor-2.json \
  --reference /path/to/champion-reference.json \
  --test-report /path/to/test-report.json \
  --browser-report /path/to/browser-report.json \
  --profile full \
  --out /path/to/evaluation-report.json
npm run edger:promote:v2 -- \
  --model /path/to/candidate.json \
  --report /path/to/evaluation-report.json
```

The promotion command refuses smoke profiles, artifact checksum mismatches, missing external reports, or any failed gate. Both commands refuse a model whose `training.promotion_status` is `diagnostic_only_not_promotable` (the `train-arm` diagnostic exports): the evaluator before any match under the full profile, and promotion whatever the report says. Smoke-profile evaluation of such a model stays allowed. Campaign automation opens a pull request after it succeeds.

The evaluator runs parity, timing, and the reported-measure inputs (a feasible
tactical suite and a valid opportunity bank) first. A failed preflight writes a
rejected report with the match gates explicitly skipped, avoiding the expensive
match suite. The tactical scenarios, held-out Fireball captures, and in-match
card usage and Fireball capture are reported for review, not gates (owner,
November 20, 2026; [`docs/EDGER_GATE_REVIEW.md`](docs/EDGER_GATE_REVIEW.md)). See
[`docs/EDGER_EVALUATION_DIAGNOSIS.md`](docs/EDGER_EVALUATION_DIAGNOSIS.md) for the
September 2026 failure evidence, local corrections, and remaining cloud blockers.

## Docs

- Game rules: `docs/GAME_RULES.md`
- Card balance: `docs/CARD_SPECS.md`
- Edger runtime and baselines: `docs/BOT_LEVELS.md`
- Cumulative training: `docs/EDGER_TRAINING.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Sprint backlog: `docs/SPRINT_BACKLOG.md`
