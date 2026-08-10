# Edge Royale Implementation Plan

## Product scope

Build a lightweight single-player game where the human fights one deterministic offline-trained bot named Edger.

MVP remains:

- human vs Edger only
- one six-tower arena
- one fixed eight-card deck
- deterministic headless simulation and replay serialization
- local win/loss/draw stats
- synchronous generated-JavaScript inference

Online PvP, player-facing bot levels, unlocks, mirror/self-play gameplay, model selectors, browser training, and expanded decks remain out of scope.

## Technical strategy

- `src/sim`: deterministic engine and shared production-match factory
- `src/client`: renderer/input layer and manual identity-free replay export
- `src/ai`: live v1 policy, shadow v2 policy, frozen heuristic, and hidden baselines
- `src/ai/v2`: spatial observation, autoregressive masks, compact JS inference
- `src/replay`: replay compatibility
- `scripts/edger-corpus*`: immutable corpus, parallel replay validation, manifests, caches, and health
- `scripts/edger-v2-training.py`: PyTorch BC, critic, offline improvement, V-trace, scaling report, and actor export
- `scripts/edger-league*`: exact-JavaScript snapshot actors and deterministic worker scheduling
- `artifacts/edger-training/promoted`: reviewed live artifacts only

The simulator remains the source of truth. Training episodes and workers use the same production factory as browser play.

## Current roadmap

1. Merge checksum-bound recovery implementation and record full reviewed main-branch SHA.
2. Confirm `campaigns/20260810-v2-recovery` is empty; dispatch `full-cache`; verify scaling/full-cache markers, cache checksum, instance/volume deletion.
3. Dispatch `offline`; require current campaign SHA, recovered parent `edger_v2_bc_418be44c61fba9b1`, validation KL at most `0.05`, cleanup.
4. Dispatch `full-evaluation`; resume through live-v1 reference, isolated league smoke/production, QA, throughput, evaluator.
5. Dispatch `promote` only after full evaluation and zero active runners; manually review generated PR.

## Quality gates

Current repository checks:

- `npm test`
- `npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`
- `npm run smoke:browser`
- `npm run edger:canary -- --seed 20260718 --canary-ticks 80`

V2-specific implemented checks:

- immutable episode replay hash/event reproduction
- compatibility rejection and quarantine
- deduplication and stable whole-game splits
- paired worker-count-independent collection specs and verified resumable receipts
- full held-out sets shared by every scaling manifest
- checksum-bound frozen scaling suite and scaling report
- side-canonical observation/action masks
- 50,000 parameter and 1 MB actor caps
- PyTorch/JS golden-logit and argmax parity
- player V-trace exclusion
- scaling gate before league launch
- immutable checkpoint lineage
- clean full-Git-SHA provenance for collection and training
- bounded-memory two-pass dataset generation and 256-row Parquet groups
- deterministic row-group/batch training and episode-grouped V-trace targets
- strict ten-shard aggregation and parallel full-corpus verification
- Git-SHA-bound external QA reports and immutable remote stage status

The complete v2 promotion thresholds are implemented by the dedicated evaluator and remain blocking until a real full campaign passes them.

## Risks

- Full production matches are much more expensive than the removed short trainer.
  - Keep actor/learner separation, preassigned seeds, 16–32 workers, and cumulative data.
- An offline update can exploit corpus bias.
  - Freeze BC/critic, cap advantage weights, enforce validation KL, and retain rejected checkpoints.
- Human data can dominate or leak identity.
  - Reject identity fields, require manual export/import, cap player episodes at 10%, and exclude unknown behavior probabilities from V-trace.
- A shadow model could accidentally become live.
  - Keep separate generated modules and refuse v2 promotion until the dedicated evaluator passes every gate.
