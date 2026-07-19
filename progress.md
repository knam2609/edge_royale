## Current State

- As of July 20, 2026, readiness PR `#8` is merged; its first pilot at `b5ac17eb5d75fc5f45ad432ad3e9d2274b4643ae` stopped when the standalone parity gate exposed a forced-index comparison bug.
- The failed-pilot corpus and evidence are preserved under `campaigns/20260718-v2-first/pilot/failed-b5ac17e/`. A reviewed parity-gate correction must establish the replacement campaign SHA before collection restarts.
- CloudFormation stack `edge-royale-edger-campaign` is `CREATE_COMPLETE` in `ap-southeast-2`; all five GitHub variables are configured.
- Live browser Edger remains the tracked v1 artifact. No v2 artifact was promoted or wired into gameplay.
- No production shards or later campaign stages have run. The 64-game stopped pilot is evidence only and will not enter replacement-SHA lineage.

## Source of Truth

- Workflow and product boundaries: `AGENTS.md`
- Product overview and commands: `README.md`
- Gameplay: `docs/GAME_RULES.md` and `docs/CARD_SPECS.md`
- Live/shadow runtime: `docs/BOT_LEVELS.md`
- Corpus, streaming learning, league, AWS runner, and scheduling: `docs/EDGER_TRAINING.md`
- Infrastructure: `infra/edger-campaign.yaml`
- Remote control and gated runner: `scripts/edger-campaign-remote.mjs` and `scripts/edger-production-campaign.mjs`

## What Works

- Dataset generation uses two deterministic passes and streams directly into 256-row Parquet groups; BC/offline evaluation and training use deterministic row-group/batch iteration.
- V-trace target Parquet is produced one episode at a time; league inputs combine a frozen base manifest with only the current rollout.
- Sixteen-worker corpus validation verifies compressed checksums, schemas, episode IDs, action/events, results, final hashes, and replays.
- Ten-report aggregation enforces indices `0…9999`, 5,000 paired seeds, balanced Edger sides, 2,500 games per opponent, unique episodes, one SHA/spec cohort, zero failures, and complete replay verification.
- External test/browser reports are campaign-SHA-bound.
- Candidate parity now compares the actual masked argmax from both runtimes; forced fixture indices are used only to select conditioned placement/delay logits.
- CloudFormation defines the retained encrypted/versioned private bucket, main-only GitHub OIDC role, SSM instance role/profile, and egress-only VPC.
- Remote launch/status/terminate provisions an SSM-only `c7g.4xlarge` with encrypted 200 GiB gp3, no key/inbound ports, instance-shutdown termination, and a 24-hour guard.
- Remote stages are immutable, resumable only at the same SHA, resource-gated below 28 GiB RSS and 160 GiB disk, and preserve failure evidence. Promotion remains an unmerged checksum-bound PR.

## Known Gaps

- The replacement-SHA authoritative pilot, 10,000-game corpus, scaling suite, offline phase, league smoke/production rollout, full live-v1 reference, and full evaluator have not run.
- AWS CLI `s3 ls` returns exit 1 for an empty prefix. A `.keep` object currently makes the reviewed campaign SHA's initial empty-corpus listing safe; main also fixes the implementation to use `s3api list-objects-v2`.

## Next Tasks

1. Validate, review, and merge `codex/edger-parity-gate-fix`; record the resulting main commit as the replacement immutable campaign SHA.
2. Clear only the active old-SHA receipts/objects after verifying their retained archive, restore `.keep`, and rerun the native-arm64 64-game pilot at the replacement SHA.
3. Dispatch ten 1,000-game shards at that SHA, aggregate strictly, verify all episodes with 16 workers, and freeze the manifest.
4. Launch the remote production campaign at the same SHA; obey scaling, KL, league, throughput, and full-evaluation stop gates.
5. If every gate passes, review the generated promotion PR manually; never auto-merge.

## Validation

- July 20, 2026: `PATH="/private/tmp/edge-royale-node20-native/node_modules/node-bin-darwin-arm64/bin:$PATH" npm test` -> 122 passed, 0 failed; `302782.119375 ms`.
- July 20, 2026: `npm run test:edger-streaming` -> 2 passed, including stable 256-row output, repeated identical BC exports/logits/argmax, forced KL rollback, and episode-grouped V-trace; `15.362 s`.
- July 20, 2026: native Node 20 `npm run smoke:browser` -> passed Edger-only runtime and identity-free replay export.
- July 20, 2026: native Node 20 `npm run edger:canary -- --seed 20260718 --canary-ticks 80` -> passed; final hash `d8a8e16d`; replay checksum `1377582fed82914b3fe95d157e2143e3cce7021a52cf1b17ff748cbad2558531`.
- July 20, 2026: focused corpus/aggregation/evaluation/parity suite -> 18 passed, 0 failed.
- July 20, 2026: `aws cloudformation validate-template --region ap-southeast-2 --template-body file://infra/edger-campaign.yaml` -> valid with `CAPABILITY_NAMED_IAM`.
- July 20, 2026: all workflow YAML parsed; every AWS workflow has `id-token: write` and `aws-actions/configure-aws-credentials@v4`; JavaScript syntax, Python compilation, and `git diff --check` passed.
- July 20, 2026: CloudFormation deployment -> `CREATE_COMPLETE`; bucket encryption AES256, versioning enabled, all public access blocked, temporary expiry 30 days, non-current expiry 90 days; runner security-group ingress `[]`; GitHub OIDC subject exactly `repo:knam2609/edge_royale:ref:refs/heads/main`.
- July 20, 2026: GitHub Actions run `29691292412` at campaign SHA -> OIDC assumption, durable-store requirement, deterministic canary, empty manifest, corpus health, and artifact upload all passed.
- July 20, 2026: SSM control-plane smoke instance `i-0e2eb6e5e584492e5` -> Amazon Linux 2023 arm64, 16 vCPU, >30 GiB memory, 200 GiB gp3, no key, S3 read/write passed, SSM command `277f7398-e9be-4e42-aa94-8f1b4092fbaf` passed, instance-initiated shutdown ended in `terminated`.
- July 20, 2026: stopped pilot at `b5ac17e` -> 64/64 fresh games, 32 paired seeds, 32 games per side, 16 per opponent, 58 Edger wins/6 losses/0 draws, 64/64 receipt replays, zero failures/duplicates; `70.499 s`; 16-worker projection `1.529926 h`; spec checksum `4f0a3ff9e2f5ceca208461af6b9a3c6b62cfd7ce2f4b031dbd22a993ab33804a`.
- July 20, 2026: stopped-pilot manifest `ee1160cacfb4298b3d98e557518b0f17669f003515a150e610253a954fead2d7` -> 64 episodes, 3,682 decisions, splits 52 train/5 validation/7 test; eight-worker validation passed 64/64 checks in `14.989 s`.
- July 20, 2026: stopped-pilot cache -> 3,682 rows in deterministic 256-row groups, 708,593 bytes; smoke BC validation joint loss `6.7823414259`; model `edger_v2_bc_228629edeec04d59`.
- July 20, 2026: old standalone parity incorrectly failed despite maximum logit error `4.76837158203125e-7` because it compared PyTorch's computed card argmax `1` to JavaScript's forced fixture card `0`. Corrected diagnostic passes with JS/PyTorch argmax `{card:1, placement:0, delay:23}`; focused regression suite 8/8 passed.
- July 20, 2026: parity-gate correction validation -> native Node `v20.20.2`, `npm test`: 123 passed, 0 failed; `git diff --check` passed.

## Risks / Notes

- Local free disk was about 12 GiB during readiness work; production caches belong on the 200 GiB remote runner.
- Campaign workflows accept an explicit reviewed `campaign_sha`, allowing later `progress.md` handoff commits without changing the SHA used for collection/training/evaluation.
- The dedicated bucket did not exist and the AWS account had no GitHub OIDC provider before this change.
- OIDC runs `29691150328` and `29691229848` exposed the empty-prefix/policy issues before data collection; neither wrote authoritative episodes. Stack policy was corrected and successful run `29691292412` is the proof gate.
- The first pilot's projection passed, but the parity-tool defect invalidates `b5ac17e` as the continuing campaign SHA. Its artifacts remain immutable; production collection did not start.
- Any failed gate must retain evidence, terminate the runner, and leave live v1 untouched.
