## Current State

- September 4, 2026: canonical decision-cache schema correction is implemented, validated, and committed on `main`. Use this file's containing commit (`git rev-parse HEAD`) as the immutable campaign SHA after confirming `origin/main` matches. No cloud run was dispatched; live browser Edger remains v1.
- Prospective target: `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260904-v2-recovery`. Recovery-manifest SHA-256: `7fa8b2dc7918e864212a6be458d3ef6d27e56e1ba2e012bcd2fa07889026339a`. Recovered source SHA remains `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`.
- Failed predecessor remains immutable: SHA `ea732eff6907d6ee114ecae1e281c6e8f62315c5`, prefix `campaigns/20260903-v2-recovery`, [run 33766979386](https://github.com/knam2609/edge_royale/actions/runs/33766979386), attempt 1. It failed in league-production because first-batch Arrow inference made `behavior_log_probability` nullable `int64`, then the lossless guard rejected fractional rollout values. Reference and league-smoke passed; 1,000 partial production rollout objects remain; no production marker/candidate/report or later gate evidence exists.
- Failed runner `i-036a05fe9dead0f13` terminated, SSM command `45dbe902-3cab-46e3-9e20-59441501eecb` finished failed/1, encrypted volume `vol-02c14eb839bedb5ef` was deleted, no active campaign runner remained, and its monitor was deleted. Do not resume or write changed-code artifacts under that prefix.

## Source of Truth

- Product/workflow boundaries: `AGENTS.md`, `README.md`; training/cache/stage contract: `docs/EDGER_TRAINING.md`; execution order: `docs/IMPLEMENTATION_PLAN.md`, `docs/SPRINT_BACKLOG.md`.
- Canonical schema and lossless conversion: `scripts/edger-v2-training.py`; regression coverage: `tests/test_edger_training_streaming.py`.
- Exact recovered source versions, prospective target, and corrected schema pin: `artifacts/edger-training/recovery/edger_scaling_recovery_v1.json`.
- Recovery validator/target binding: `scripts/edger-scaling-recovery.mjs`, `tests/edger-scaling-recovery.test.js`.
- Failure evidence: `/tmp/edger-full-evaluation-failure.rYNOrU/`; deterministic fractional-log-probability reproduction: `/tmp/edger-league-diagnosis.vULsR4/`. Durable evidence remains in the immutable S3 campaign prefixes.

## What Works

- `DECISION_CACHE_SCHEMA` now fixes all persisted field order/types. `behavior_log_probability` and `policy_league_rating` are nullable `float64`; recovered integer zeros normalize losslessly while negative fractional league values remain exact. Schema version is `edger_decision_parquet_v2`; persisted PyArrow 17/21 schema SHA-256 is `3623ade0a47e7b66b64f46581788b2dda46cee2b78b6b02c3ceeae34c11e2f5a`.
- Lossless conversion guard remains active. Regression coverage accepts a late `-0.25` after 256 recovery-style integer-zero rows and rejects late fractional `delay_ticks` plus dropped unknown fields.
- Training dependencies now explicitly include `numpy>=1.26,<3`; local version is 2.4.3.
- Recovered scaling evidence remains bound to losses `5.66476906505989 / 4.208889744824017 / 3.689103049452064`, scores `0.54 / 0.795 / 0.86`, full checkpoint `edger_v2_bc_418be44c61fba9b1`, manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c`, and rows/splits `593,576 / 475,845 / 59,529 / 58,202`.
- The passed `20260903` full-cache evidence used old schema v1: 2,319 deterministic 256-row groups, Zstd, logical SHA-256 `4edd2d5ee0d5fd7f4ecb76c7fcb576cdb4e841642bbf03f4ad1df72cb4e87747`, Parquet SHA-256 `ee97854a7d2e42332e396d195ad0495fd4d56663e60154fcc2139aca69f9cebb`, and exactly one Parquet object. Its offline stage passed but rolled back to recovered BC (`accepted_epochs=0`, accepted KL 0); no learned improvement is claimed.

## Known Gaps

- Corrected full-cache has not run. New logical-content and Parquet checksums are unknown until the v2 cache is built and independently verified; old v1 cache checksums must not be reused as corrected evidence.
- Prospective prefix emptiness, zero active runners, GitHub/AWS credentials, and exact-version recovery dry run have not been rechecked for the final correction SHA.
- Cloud dispatch, later stages, and promotion remain unauthorized.

## Next Tasks

1. Confirm `origin/main` matches the containing commit, then retain that full immutable SHA for every stage under `20260904-v2-recovery`.
2. Using that SHA, run exact-version recovery dry run; immediately recheck target-prefix emptiness and zero active runners. Stop on any race or mismatch.
3. With explicit dispatch approval, run `full-cache` only. Verify immutable scaling/full-cache markers, corrected schema/content/Parquet checksums, rows/splits/groups/compression, sole Parquet placement, unique GitHub log, runner termination, volume deletion, and unchanged live v1.
4. Run `offline` and `full-evaluation` only as separately reviewed later operations. Promotion remains separately approval-gated.

## Validation

- `python3 -m py_compile scripts/edger-v2-training.py tests/test_edger_training_streaming.py` -> passed.
- `PYTHONDONTWRITEBYTECODE=1 /usr/bin/arch -arm64 /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m unittest tests/test_edger_training_streaming.py` -> 7/7 on PyArrow 17. `PYTHONDONTWRITEBYTECODE=1 /usr/bin/arch -arm64 /tmp/edger-schema-env.sjbDGx/venv/bin/python3 -m unittest tests/test_edger_training_streaming.py` -> 7/7 on PyArrow 21.
- `node --test tests/edger-scaling-recovery.test.js tests/edger-campaign-stages.test.js tests/edger-campaign-remote.test.js tests/edger-scaling-gate.test.js` -> 14/14.
- `npm test` -> 135/137; every non-parity test passed, including the benchmark gate. Two parity tests failed only because sandboxed x86_64 Node could not detect Rosetta and loaded arm64 PyArrow. `PYTHON=/tmp/edger-native-python node --test tests/edger-v2-parity.test.js` -> 2/2 under explicit native arm64 Python. Combined result: all 137 test assertions pass; no product failure observed.
- `jq empty artifacts/edger-training/recovery/edger_scaling_recovery_v1.json` -> passed. Manifest SHA-256 is `7fa8b2dc7918e864212a6be458d3ef6d27e56e1ba2e012bcd2fa07889026339a`; local NumPy import reports 2.4.3.
- Scoped stale-reference review found `20260903-v2-recovery` only in intentional failed-campaign history; active target/constants/examples use `20260904-v2-recovery`. `git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false diff --check -- <changed-files>` -> passed.

## Risks / Notes

- Old `20260810-v2-recovery` belongs permanently to SHA `65e0eaacbec8c32d838d2f262cdfbb8d2f53fca2` and recovery checksum `f3afafdc84303d918ef45be1095e04f7bc8ba75c03eac77184d72428badd760e`; never write changed-code artifacts there. Old `20260903-v2-recovery` similarly remains bound to `ea732eff6907d6ee114ecae1e281c6e8f62315c5`.
- Do not weaken the lossless guard. Canonical schema changes durable cache identity, so corrected full-cache and offline evidence must be rebuilt under the fresh prefix before evaluation.
- Manual promotion PR merge remains the only live-model transition. No client, simulation, replay, heuristic, generated live model, or promotion code changed in this correction.
