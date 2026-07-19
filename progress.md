## Current State

- As of July 20, 2026, `codex/edger-first-campaign-readiness` contains the complete production-readiness change set and is ready for review/merge from base `22ef36f`.
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

- The CloudFormation stack and GitHub repository variables are not provisioned yet.
- The authoritative 64-game pilot, 10,000-game corpus, scaling suite, offline phase, league smoke/production rollout, full live-v1 reference, and full evaluator have not run.
- The readiness branch still needs to be committed, pushed, reviewed, and merged before authoritative collection.

## Next Tasks

1. Commit, push, review, and merge `codex/edger-first-campaign-readiness`; record the merged main SHA as the immutable campaign SHA.
2. Deploy `edge-royale-edger-campaign` in `ap-southeast-2` and set `AWS_REGION`, `EDGER_AWS_ROLE_ARN`, `EDGER_CORPUS_STORE`, `EDGER_CAMPAIGN_INPUT_URI`, and `EDGER_REFERENCE_HARDWARE`.
3. Run the native-arm64 64-game S3 pilot at the campaign SHA and stop if its fresh 16-worker projection exceeds eight hours.
4. Dispatch ten 1,000-game shards at the campaign SHA, aggregate strictly, verify all episodes with 16 workers, and freeze the manifest.
5. Launch the remote production campaign at the same SHA; obey scaling, KL, league, throughput, and full-evaluation stop gates.
6. If every gate passes, review the generated promotion PR manually; never auto-merge.

## Validation

- July 20, 2026: `PATH="/private/tmp/edge-royale-node20-native/node_modules/node-bin-darwin-arm64/bin:$PATH" npm test` -> 122 passed, 0 failed; `302782.119375 ms`.
- July 20, 2026: `npm run test:edger-streaming` -> 2 passed, including stable 256-row output, repeated identical BC exports/logits/argmax, forced KL rollback, and episode-grouped V-trace; `15.362 s`.
- July 20, 2026: native Node 20 `npm run smoke:browser` -> passed Edger-only runtime and identity-free replay export.
- July 20, 2026: native Node 20 `npm run edger:canary -- --seed 20260718 --canary-ticks 80` -> passed; final hash `d8a8e16d`; replay checksum `1377582fed82914b3fe95d157e2143e3cce7021a52cf1b17ff748cbad2558531`.
- July 20, 2026: focused corpus/aggregation/evaluation/parity suite -> 18 passed, 0 failed.
- July 20, 2026: `aws cloudformation validate-template --region ap-southeast-2 --template-body file://infra/edger-campaign.yaml` -> valid with `CAPABILITY_NAMED_IAM`.
- July 20, 2026: all workflow YAML parsed; every AWS workflow has `id-token: write` and `aws-actions/configure-aws-credentials@v4`; JavaScript syntax, Python compilation, and `git diff --check` passed.

## Risks / Notes

- Local free disk was about 12 GiB during readiness work; production caches belong on the 200 GiB remote runner.
- Campaign workflows accept an explicit reviewed `campaign_sha`, allowing later `progress.md` handoff commits without changing the SHA used for collection/training/evaluation.
- The dedicated bucket did not exist and the AWS account had no GitHub OIDC provider before this change.
- Any failed gate must retain evidence, terminate the runner, and leave live v1 untouched.
