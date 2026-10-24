# September 2026 immutable campaign closeout

This preserves the uncommitted campaign closeout supplied at the start of the September 11 diagnosis. The recovered failure-report location and truncated log checksum are corrected below. Current local work and next actions live in `progress.md` and [the diagnosis](EDGER_EVALUATION_DIAGNOSIS.md).

# Current State

- September 6, 2026: corrected Edger full-cache and offline stages remain passed under immutable campaign SHA `0270d828686a3ef984b89c6043a46a1c306dc0e6` and `s3://edge-royale-edger-REDACTED-ACCOUNT-ID-ap-southeast-2/campaigns/20260904-v2-recovery`. The resumed full-evaluation operation passed live-v1 reference, league smoke, league production, and QA, then failed the final evaluator.
- GitHub Actions [run 33845474566](https://github.com/knam2609/edge_royale/actions/runs/33845474566), attempt 1, completed successfully and detached after five hours; runner `REDACTED-INSTANCE-ID` later completed SSM command `0337cc05-8fec-4236-8dff-dcef7d0c8819` with success/0 and terminated. Encrypted root volume `REDACTED-VOLUME-ID` was deleted.
- GitHub Actions [run 33949590031](https://github.com/knam2609/edge_royale/actions/runs/33949590031), attempt 1, completed successfully and detached after five hours; runner `REDACTED-INSTANCE-ID` later completed SSM command `9335824b-b377-41bd-a536-3036fe69962f` with success/0 and terminated. Encrypted root volume `REDACTED-VOLUME-ID` was deleted.
- GitHub Actions [run 33972346707](https://github.com/knam2609/edge_royale/actions/runs/33972346707), attempt 1, completed successfully and detached at the control-plane timeout. Runner `REDACTED-INSTANCE-ID` continued SSM command `c45a319d-e9fa-4780-8592-851e8fd4539d`, which failed with response code 1 in full evaluation, then terminated. Encrypted root volume `REDACTED-VOLUME-ID` was deleted.
- Unique immutable passed markers are `scaling.json` version `wnU2QB_EUXYODUMpHSKq6_xmKRCewdsO`, `full-cache.json` version `2MUySA6ffj4UF2UUnM9EIu.snUmOkxG0`, `offline.json` version `0Vtj.G9VGUYmHds2eAMYklg8hbkUjRKJ`, `live-v1-reference.json` version `YR2VwGBwEQQOvYAICONqFbOVlSboyyBh`, `league-smoke.json` version `G7QOedfIG2iIL83d8YovJUisnjrxGaHx`, `league-production.json` version `poKsA7op9qeIi5eSAhAmUK6awgf2VOQs`, and `qa.json` version `ehe2In2UCaSoVfp8nlDNXBnzHMhmxaGk`. All bind the campaign SHA and recovery-manifest SHA-256 `7fa8b2dc7918e864212a6be458d3ef6d27e56e1ba2e012bcd2fa07889026339a`.
- Unique attempt marker `status/attempts/full-evaluation-2026-09-06T02-33-00-530Z.json` version `F46Fyi4A9kW34SJxZXjNUR0i5Bs5msbq` records `status=failed`. No completed full-evaluation marker or ready-for-promotion objects exist. Promotion did not run; live v1 remains unchanged.

# Source of Truth

- Product/workflow boundaries: `AGENTS.md`, `README.md`; training/cache/stage contract: `docs/EDGER_TRAINING.md`; execution order: `docs/IMPLEMENTATION_PLAN.md`, `docs/SPRINT_BACKLOG.md`.
- Canonical schema and lossless conversion: `scripts/edger-v2-training.py`; regression coverage: `tests/test_edger_training_streaming.py`.
- Exact recovered source versions, target, and schema pin: `artifacts/edger-training/recovery/edger_scaling_recovery_v1.json`.
- Recovery and marker validation: `scripts/edger-scaling-recovery.mjs`, `scripts/edger-campaign-stages.mjs`, and their tests. Durable run evidence is in the immutable S3 campaign prefix; full-evaluation failure closeout downloads are in `/tmp/edger-full-evaluation-closeout.Lma2Iw/`.

# What Works

- Recovered source SHA `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33` passed protected-path and exact-version recovery checks. Scaling evidence retains losses `5.66476906505989 / 4.208889744824017 / 3.689103049452064`, scores `0.54 / 0.795 / 0.86`, and full checkpoint `edger_v2_bc_418be44c61fba9b1`.
- Corrected cache uses schema `edger_decision_parquet_v2`, schema SHA-256 `3623ade0a47e7b66b64f46581788b2dda46cee2b78b6b02c3ceeae34c11e2f5a`, manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c`, and 593,576 rows split `475,845 / 59,529 / 58,202`.
- Cache is Zstd-compressed with 2,319 deterministic 256-row groups. Logical-content SHA-256 is `0c7559ad019fc1250e2715c8480f7d96c6bf2ca0c3df80851f6e9bd624904977`; Parquet SHA-256 is `cf6183b6e893fc6cbbc8a5676777022a8f9e9a614d8d016160bb1adbf77498b7`.
- Exactly one Parquet object exists under `stages/full-cache/`, with one immutable version and matching metadata/checksum. Unique log `logs/github-33845474566-1.log` exists. No active matching runner remains.
- Full-cache peak RSS was 1,864,732 KiB and peak disk use 13,802,596 KiB, below configured limits.
- Offline produced shadow checkpoint/model `edger_v2_offline_advantage_weighted_ea8fa87f8b3ac012`, bound to recovered parent `edger_v2_bc_418be44c61fba9b1`, campaign SHA, manifest, and corrected cache checksum. Validation KL is `0`, within the `0.05` gate.
- The attempted epoch was rejected at KL `0.1802700719291246`; rollback applied with `accepted_epochs=0`. The passed offline artifact therefore preserves the recovered BC behavior and makes no learned-improvement claim.
- Immutable offline artifacts are `shadow-parent.json` version `9mK7FURZskZPZELAgBrZm8rz0uQUiF8K`, SHA-256 `73b33da42532e879a9ca1e059ecd8c84ccb6baa7f8f9ebef500de240a2819d4d`, and `shadow-parent.pt` version `0hCV6RsfYoLvqdmxYnLDp4AskTc_CliX`, SHA-256 `f166e527b4d3e7e18ebb3846a42d483661578b7a83662cc21445d4896f9368af`. Unique log `logs/github-33949590031-1.log` exists.
- Live-v1 reference, league smoke, league production, and QA completed with passed markers. League production produced candidate JSON SHA-256 `b057436961e5f8315946c8e8f1772675e8326e3c84daa0599fbcf70748c3c052`, candidate checkpoint SHA-256 `79a095afb0cea620c59e2aee96603954065666429185d6fd4caa7306c74b6e04`, league-report SHA-256 `26674625cd800ff73d21138430d7ac3a04cfe9092049f82bf6f317f1f8c17e93`, and manifest SHA-256 `3f0a5a7f10f06576989b7f8394c5b2e73da927d748de93a5cc12d365ef0f1762`.
- QA completed `npm test` and browser smoke before full evaluation began. The throughput precheck passed at `6.740519366512897` matches/second with a projected `27.94047803927083` minutes for 11,300 matches.

# Known Gaps

- Full evaluation ran but failed five promotion gates: PyTorch/generated-JS parity, champion paired score/bootstrap, weak-baseline score, tactical scenarios, and generated-JS p95 timing. No candidate is ready for promotion.
- The failed stage published no `stages/full-evaluation/` or `ready-for-promotion/` objects. September 11 correction: detailed reports survive under `failed-stages/full-evaluation/2026-09-06T02-33-00-530Z/`; exact report version/checksum and diagnosis are recorded in [EDGER_EVALUATION_DIAGNOSIS.md](EDGER_EVALUATION_DIAGNOSIS.md).
- Offline accepted no update after the attempted epoch exceeded the KL limit; later league/evaluation work must not describe this rollback artifact as learned improvement.
- Promotion remains a separately reviewed, approval-gated operation and must not occur before all immutable evaluation gates pass.

# Next Tasks

Superseded by the current priority queue in `progress.md` and the approval-dependent plan in [EDGER_EVALUATION_DIAGNOSIS.md](EDGER_EVALUATION_DIAGNOSIS.md). The September campaign must remain unchanged.

# Validation

- Pre-dispatch checks passed: exact local/origin/campaign SHA, GitHub/AWS credentials and workflow variables, empty target prefix, zero active runners, source ancestry/protected paths, and exact-version recovery dry run.
- `gh run watch 33845474566 --exit-status` -> GitHub control-plane run succeeded and detached; final `gh run view` reports completed/success at exact SHA and attempt 1.
- Checked-in marker validation via `assertCompletedStageMarker` passed for exact downloaded marker versions. S3 version inventory found one version per completed marker, no delete markers, exactly one full-cache Parquet, and one `github-33845474566-1.log`.
- Independent local `edger:cache:validate` over the exact 103,335,923-byte Parquet version passed and reproduced manifest, schema, rows/splits, Zstd, 2,319 groups, logical-content checksum, and Parquet checksum.
- Downloaded Parquet SHA-256 and S3 object metadata both equal `cf6183b6e893fc6cbbc8a5676777022a8f9e9a614d8d016160bb1adbf77498b7`; marker/build/validation reports agree.
- EC2 reports the runner terminated with no attached volumes; `DescribeVolumes` returns `InvalidVolume.NotFound`; SSM reports success/0; active-runner query returns empty.
- `git diff 0270d828686a3ef984b89c6043a46a1c306dc0e6 -- artifacts/edger-training/promoted/edger_policy_current.json src/ai/generated/edgerPolicyCurrent.js` -> clean. Live model SHA-256 remains `895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa`.
- Correction validation remains: all 137 test assertions pass when combining `npm test` (135/137; two environment-only Rosetta detection failures) with native-arm parity `PYTHON=/tmp/edger-native-python node --test tests/edger-v2-parity.test.js` (2/2).
- `gh run view 33949590031` -> completed/success at exact SHA and attempt 1. Exact-version `offline.json` marker checks, model lineage/KL checks, artifact hashes, single-version/no-delete-marker inventory, and unique-log checks all passed.
- Offline cleanup passed: EC2 runner terminated, SSM command success/0, encrypted root volume deleted (`InvalidVolume.NotFound`), and zero active matching runners. Local closeout evidence is in `/tmp/edger-offline-closeout.goZmap/`.
- `gh run view 33972346707 --repo knam2609/edge_royale --json status,conclusion,headSha,attempt,url,updatedAt` -> completed/success at exact SHA and attempt 1; this was a detached control-plane result, not workload success.
- Checked-in `assertCompletedStageMarker` validation passed for all seven exact completed-marker versions. S3 version inventory found one version per marker and no delete markers; `full-evaluation.json` is absent.
- Exact attempt-marker SHA-256 is `e567a926d58ad2015da8693b190e5bd60cb8b4960a44105db5a3fa50296f38e9`. Unique `logs/github-33972346707-1.log` version `j1_oPDJP2J3o6HuM0udTw0_rPB92sZeZ` has SHA-256 `882105bb5b89e5bcfc1ed58912049ce7f53cc1339f62d56af4e780c924b6fe2a` and records the five failed gates plus `npm exited 2`.
- Terminal cleanup passed: SSM reports failed/1, EC2 runner is terminated with no attached volumes, `DescribeVolumes` returns `InvalidVolume.NotFound`, and the exact active-runner query returns zero. `stages/full-evaluation/` and `ready-for-promotion/` are empty.
- `git diff 0270d828686a3ef984b89c6043a46a1c306dc0e6 -- artifacts/edger-training/promoted/edger_policy_current.json src/ai/generated/edgerPolicyCurrent.js` -> clean after failure. Live model SHA-256 remains `895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa`.

# Risks / Notes

- Preserve SHA `0270d828686a3ef984b89c6043a46a1c306dc0e6` for every later stage in this campaign. A transient failure may resume the same prefix; a defect requiring changed code requires a new immutable SHA and campaign prefix.
- GitHub success after detachment does not prove remote workload success; the matching completed marker and terminal SSM result are authoritative. This run has no full-evaluation completion marker and SSM failed/1.
- Do not promote league-production candidate `b0574369...`; it failed five required evaluator gates.
- Failed predecessor `20260903-v2-recovery` remains immutable at SHA `ea732eff6907d6ee114ecae1e281c6e8f62315c5`; old `20260810-v2-recovery` remains bound to SHA `65e0eaacbec8c32d838d2f262cdfbb8d2f53fca2`. Never write changed-code artifacts to either prefix.
- Do not weaken the lossless cache guard. Manual promotion remains the only live-model transition.
