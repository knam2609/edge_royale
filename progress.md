## Current State

- As of July 20, 2026, readiness PR `#8` is squash-merged and the immutable campaign SHA is `b5ac17eb5d75fc5f45ad432ad3e9d2274b4643ae`.
- CloudFormation stack `edge-royale-edger-campaign` is `CREATE_COMPLETE` in `ap-southeast-2`; all five GitHub variables are configured.
- Live browser Edger remains the tracked v1 artifact. No v2 artifact was promoted or wired into gameplay.
- No authoritative pilot or production campaign data has been collected from the readiness branch yet.

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
- CloudFormation defines the retained encrypted/versioned private bucket, main-only GitHub OIDC role, SSM instance role/profile, and egress-only VPC.
- Remote launch/status/terminate provisions an SSM-only `c7g.4xlarge` with encrypted 200 GiB gp3, no key/inbound ports, instance-shutdown termination, and a 24-hour guard.
- Remote stages are immutable, resumable only at the same SHA, resource-gated below 28 GiB RSS and 160 GiB disk, and preserve failure evidence. Promotion remains an unmerged checksum-bound PR.

## Known Gaps

- The authoritative 64-game pilot, 10,000-game corpus, scaling suite, offline phase, league smoke/production rollout, full live-v1 reference, and full evaluator have not run.
- AWS CLI `s3 ls` returns exit 1 for an empty prefix. A `.keep` object currently makes the reviewed campaign SHA's initial empty-corpus listing safe; main also fixes the implementation to use `s3api list-objects-v2`.

## Next Tasks

1. Run the native-arm64 64-game S3 pilot at campaign SHA `b5ac17eb5d75fc5f45ad432ad3e9d2274b4643ae` and stop if its fresh 16-worker projection exceeds eight hours.
2. Dispatch ten 1,000-game shards at the same SHA, aggregate strictly, verify all episodes with 16 workers, and freeze the manifest.
3. Launch the remote production campaign at the same SHA; obey scaling, KL, league, throughput, and full-evaluation stop gates.
4. If every gate passes, review the generated promotion PR manually; never auto-merge.

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

## Risks / Notes

- Local free disk was about 12 GiB during readiness work; production caches belong on the 200 GiB remote runner.
- Campaign workflows accept an explicit reviewed `campaign_sha`, allowing later `progress.md` handoff commits without changing the SHA used for collection/training/evaluation.
- The dedicated bucket did not exist and the AWS account had no GitHub OIDC provider before this change.
- OIDC runs `29691150328` and `29691229848` exposed the empty-prefix/policy issues before data collection; neither wrote authoritative episodes. Stack policy was corrected and successful run `29691292412` is the proof gate.
- Any failed gate must retain evidence, terminate the runner, and leave live v1 untouched.
