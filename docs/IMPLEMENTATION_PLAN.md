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

1. Merge the production-readiness branch and use that one main-branch SHA for every campaign artifact.
2. Run the 64-game resumable S3 pilot and retain its collection/cost report.
3. Complete and strictly aggregate the ten-shard 10,000-match S3 collection only if the pilot projects at most eight hours on 16 workers.
4. Launch the SSM-only `c7g.4xlarge` and train/frozen-evaluate the fixed 1%/10%/100% BC experiment using the evidence-backed relative scaling gate.
5. Run one conservative offline-improvement phase and retain its accepted or rolled-back evidence.
6. Run the isolated 32-game league smoke and 1,000-game V-trace campaign over the frozen base plus production rollout.
7. Enforce the 11,300-game/180-minute exact-JavaScript throughput gate.
8. Generate the live-v1 reference, run commit-bound tests/browser/full evaluation, and review the generated promotion PR.

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
