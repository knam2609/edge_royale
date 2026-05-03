# Progress

## Current State

- As of May 3, 2026, the full daily ladder training workflow has been manually validated end-to-end on GitHub Actions, including automatic PR creation.
- `main` is pushed at `532eacb` with workflow hardening for repeated runs: it fetches `training/daily-ladder-models` before `--force-with-lease`, supports optional `LADDER_MODEL_PR_TOKEN`, and treats blocked PR creation as a warning after the model branch is pushed.
- Repository workflow permissions now allow GitHub Actions to create pull requests, so no `LADDER_MODEL_PR_TOKEN` secret is currently needed.
- Run `25276131849` completed successfully on GitHub Actions in `47m30s` at head `532eacb`.
- The full preset trained `noob`, `mid`, `top`, `pro`, and `goat`, uploaded the full run artifact, promoted the passing candidate artifacts, pushed branch `training/daily-ladder-models`, and opened PR #4.
- Downloaded artifact validation showed all five candidate model tiers, `passed=true`, `bootstrap=true`, `average_delta=0`, and `worst_adjacent_delta=0`.
- Open model PR: `https://github.com/knam2609/edge_royale/pull/4`.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and next AI slices: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Ladder training workflow and schemas: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- `.github/workflows/daily-ladder-training.yml` runs from `workflow_dispatch`, installs deps, runs tests, trains the balanced large preset, compares candidates, uploads artifacts, promotes passing candidates, pushes `training/daily-ladder-models`, and opens/updates the model PR.
- `scripts/train-bot-ladder.sh` exports shard data, trains one model per requested fair tier, benchmarks each saved artifact, and writes a candidate manifest for the workflow.
- `scripts/compare-ladder-models.mjs` enforces full requested-tier coverage, deterministic benchmark output, average delta, and adjacent-regression gates.
- `scripts/promote-ladder-models.mjs` copies passing models and summaries to stable promoted paths, writes `artifacts/training/ladder-models.json`, and prepares the PR body.
- The browser and benchmark paths still load valid same-tier saved models from `artifacts/training/ladder-models.json` and fall back to heuristics for missing or invalid entries.

## Known Gaps

- The successful hosted run produced a safe bootstrap pass with `average_delta=0`, not a stronger promotion signal.
- The balanced large preset took about `48` minutes on GitHub-hosted Ubuntu; future tuning should balance runtime, artifact size, and benchmark signal.
- GitHub Actions emitted a Node.js 20 action deprecation warning for `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4`.
- God RL and playable God model work are still not implemented.
- The self bot still uses the old local bucket model and has not been migrated to legal-action imitation + RL.

## Next 3 Tasks

1. Review PR #4 (`https://github.com/knam2609/edge_royale/pull/4`) and decide whether to merge the promoted bootstrap models into `main`.
2. Tune the daily preset/gate from the `47m30s` runtime and zero-delta bootstrap result.
3. Implement the self bot next slice from `docs/IMPLEMENTATION_PLAN.md`: full player decision logging, legal-action imitation model, and batched RL fine-tune.

## Validation

- May 3, 2026: `npm test` -> 111 tests passed.
- May 3, 2026: `node --check scripts/compare-ladder-models.mjs` -> syntax OK.
- May 3, 2026: `node --check scripts/promote-ladder-models.mjs` -> syntax OK.
- May 3, 2026: `bash -n scripts/train-bot-ladder.sh` -> shell syntax OK.
- May 3, 2026: `gh workflow run daily-ladder-training.yml --ref main` -> run `25276131849` succeeded at `https://github.com/knam2609/edge_royale/actions/runs/25276131849`.
- May 3, 2026: `gh run download 25276131849 --name ladder-training-25276131849 --dir /private/tmp/edge_royale-ladder-25276131849` -> full artifact downloaded.
- May 3, 2026: downloaded run `25276131849` `candidate-ladder-models.json` and `comparison-summary.json` check -> `candidateTiers=noob,mid,top,pro,goat`, `passed=true`, `bootstrap=true`, `averageDelta=0`, `worstAdjacentDelta=0`.
- May 3, 2026: `git ls-remote --heads origin training/daily-ladder-models` -> branch exists at `e4ce4ee1544f0fd5f3ab5d736f9fa4be7e5c0b52`.
- May 3, 2026: `gh pr list --head training/daily-ladder-models --base main --state open --json number,title,url,headRefOid` -> PR #4 open at `https://github.com/knam2609/edge_royale/pull/4`, head `e4ce4ee1544f0fd5f3ab5d736f9fa4be7e5c0b52`.

## Risks / Notes

- Raw training artifacts stay ignored under `artifacts/training/runs/`; only `artifacts/training/ladder-models.json` and `artifacts/training/promoted/**` are intended to be tracked on the promoted branch.
- `training/daily-ladder-models` currently contains promoted runtime artifacts and has open PR #4.
- The workflow still has a blocked-PR warning fallback, but repository settings now allow normal Action-created PRs.
- The current fair-tier training path imitates existing heuristic tier behavior. It does not yet implement God-teacher distillation, GPU-backed training, or RL for ladder/self tiers.
