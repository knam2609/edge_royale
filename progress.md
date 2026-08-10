## Current State

- As of August 10, 2026, live browser Edger remains tracked v1. No v2 artifact has been promoted or wired into gameplay.
- Immutable campaign `20260718-v2-first` remains bound to `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`. Its pilot and 10,000-game corpus passed; manifest hash `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c`, 593,576 decisions, 10,000/10,000 replay validation.
- Retry run `30193108201` outlived its six-hour GitHub monitor and finished scaling on July 27. `1%`, `10%`, and `100%` training/evaluation artifacts were retained under `failed-stages/scaling/2026-07-27T03-18-54-545Z/`.
- Scaling improved held-out joint-action loss `5.6647690651 -> 4.2088897448 -> 3.6891030495` and frozen-league score `0.54 -> 0.795 -> 0.86`. Replay checks passed, illegal actions were zero, nested training sets passed, and held-out sets were identical.
- The stage stopped only because `edger_data_scaling_report_v1` also required unnormalized three-head joint cross-entropy below `0.10`. That absolute threshold conflicts with the scaling backlog contract and is not meaningful across legal-action entropy.
- The repository contract is now `edger_data_scaling_report_v2`: require 100% held-out loss improvement over 10% plus frozen-league non-regression. Legacy v1 reports are refused. Re-evaluation of the exact retained artifacts passes v2.
- No campaign instance or tagged EBS volume remains. No promotion PR exists. This handoff includes the v2 gate, docs, and regression tests; no new campaign has run from it.

## Source of Truth

- Workflow and product boundaries: `AGENTS.md`
- Product overview and commands: `README.md`
- Gameplay: `docs/GAME_RULES.md` and `docs/CARD_SPECS.md`
- Live/shadow runtime: `docs/BOT_LEVELS.md`
- Corpus, learning, league, AWS runner, and gates: `docs/EDGER_TRAINING.md`
- Infrastructure: `infra/edger-campaign.yaml`
- Remote control and gated runner: `scripts/edger-campaign-remote.mjs` and `scripts/edger-production-campaign.mjs`
- Immutable campaign evidence: `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260718-v2-first/`

## What Works

- Deterministic game, replay, browser UI, live v1 Edger, shadow v2 actor, corpus, training, league, evaluator, and checksum-bound promotion foundations remain intact.
- Frozen corpus is balanced across paired seeds, Edger sides, and four opponents, with zero collection failures and exhaustive replay verification.
- Scaling artifacts bind manifests, checkpoints, models, frozen-suite checksum, illegal-action count, and replay checks. Exact retained production artifacts pass the corrected v2 gate.
- Remote runners remain SSM-only, encrypted, resource-gated, immutable-SHA-bound, and safe-shutdown controlled. Failed stages preserve evidence without changing live v1.

## Known Gaps

- No canonical v2 completed-stage marker exists; immutable v1 failure evidence must not be rewritten in place.
- Offline improvement, league smoke/production, throughput gate, live-v1 reference, full evaluator, and promotion review remain unrun.
- Scaling consumed about 19 hours 40 minutes. Relaunching the unchanged full campaign would rebuild scaling and leave little time under the 24-hour runner guard.
- GitHub monitor still ends after six hours, shorter than real campaign stages.

## Next Tasks

1. Add a checksum-bound recovery path or faster/resumable scaling cache path for a new immutable campaign SHA; do not relabel the old v1 failure marker or blindly repeat the 20-hour stage.
2. Resume at offline improvement only after v2 scaling evidence is canonical for the new SHA, then run isolated league smoke/production, throughput, live-v1 reference, and full evaluation gates.
3. Harden GitHub monitoring so long valid AWS stages do not report as cancelled.
4. Review any generated promotion PR manually; never auto-merge.

## Validation

- July 20, 2026: native-arm64 pilot passed 64/64 games and replay checks; projected 10,000 games on 16 workers in `1.720204 h`.
- July 20, 2026: corpus recovery passed strict aggregation and 10,000/10,000 replay validation; frozen manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c`.
- July 27, 2026: scaling v1 retained all three model/checkpoint/manifest/frozen-suite sets; stage status `failed`, peak RSS `1,861,464 KiB`, peak disk `12,793,052 KiB`, elapsed about `19 h 40 m`.
- August 10, 2026: exact retained artifacts regenerated `edger_data_scaling_report_v2` locally -> passed; losses `5.6647690651 / 4.2088897448 / 3.6891030495`, frozen scores `0.54 / 0.795 / 0.86`.
- August 10, 2026: `node --test tests/edger-scaling-gate.test.js` -> 3/3 passed.
- August 10, 2026: `npm run test:edger-streaming` -> 3/3 passed in `18.059 s`.
- August 10, 2026: `npx -y node@20.20.2 --test` -> 128/128 passed in `757471.629 ms`.
- August 10, 2026: Python compilation, Node syntax checks, and `git diff --check` passed before handoff update.

## Risks / Notes

- Campaign SHA `f25a488` and its v1 failure record are immutable. Corrected code must create new-SHA evidence or use an explicit checksum-bound recovery contract.
- Removing the absolute loss floor does not promote a model. Frozen gameplay, offline KL, league, throughput, large-sample safety, replay, parity, timing, test, browser, and manual-review gates remain blocking.
- Current production artifacts show strong scaling, but no later-stage candidate exists yet.
