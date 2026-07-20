## Current State

- As of July 20, 2026, readiness PR `#8`, parity correction PR `#9`, and OIDC-duration PR `#10` are merged. The immutable campaign SHA is `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`.
- The authoritative native-arm64 64-game pilot passed every gate and its eight evidence files are retained under `campaigns/20260718-v2-first/pilot/`.
- The invalidated `b5ac17e` pilot remains preserved separately under `campaigns/20260718-v2-first/pilot/failed-b5ac17e/`.
- All ten production shards at `f25a488` passed strict aggregation. Workflow run `29692403151` then stopped during manifest construction when its default one-hour OIDC session expired; no frozen manifest was published.
- The failed run's aggregate, failure report, and ten shard reports are retained under `campaigns/20260718-v2-first/corpus/failed-run-29692403151/`.
- Recovery run `29695924800` passed under 12-hour OIDC credentials. Frozen manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c` and its passed validation/aggregate reports are retained under `campaigns/20260718-v2-first/corpus/`.
- Remote campaign run `29708015701` strict-stopped before instance creation because the GitHub role applied launch-time instance/volume tag conditions to EC2's separately evaluated network-interface resource. Promotion was skipped and live v1 was unchanged.
- The launch failure report is retained under `campaigns/20260718-v2-first/remote/failed-run-29708015701/`. Resource-aware launch-policy PR `#11` is merged and deployed.
- Retry run `29708221490` proved the corrected OIDC launch path, then strict-stopped during runner bootstrap because Playwright's unsupported-OS fallback invoked unavailable `apt-get` on Amazon Linux 2023. The instance and root volume were deleted; no campaign stage ran.
- Four bootstrap-failure evidence objects are retained under `campaigns/20260718-v2-first/remote/failed-run-29708221490/`.
- A short-lived AL2023 arm64 smoke runner proved the direct Chromium RPM mapping and passed the real browser smoke. Production bootstrap/control-plane PR `#12` is merged.
- Run `29708727986` proved the corrected browser bootstrap, then strict-stopped at the clean-worktree pre-stage gate because bootstrap created the Python virtual environment inside the immutable checkout. The runner and root volume self-terminated; no corpus or campaign stage loaded.
- Four clean-worktree failure evidence objects are retained under `campaigns/20260718-v2-first/remote/failed-run-29708727986/`.
- The post-`#13` retry has not been created: two dispatch attempts returned HTTP 503 during GitHub's active Actions/API partial outage. No EC2 runner was created.
- CloudFormation stack `edge-royale-edger-campaign` is `UPDATE_COMPLETE` in `ap-southeast-2`; all five GitHub variables are configured.
- Live browser Edger remains the tracked v1 artifact. No v2 artifact was promoted or wired into gameplay.
- Scaling and later campaign stages have not run. No production or smoke EC2 runner remains active.

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
- CloudFormation defines the retained encrypted/versioned private bucket, main-only GitHub OIDC role, SSM instance role/profile, and egress-only VPC. The OIDC role can launch only the intended Amazon-owned-image, stack-network, tagged `c7g.4xlarge`, IMDSv2, encrypted-gp3 resource set.
- The real OIDC launch produced the intended `c7g.4xlarge`, Amazon Linux 2023 arm64, 200 GiB encrypted gp3, IMDSv2-required, keyless, ingress-free, SSM-online runner.
- On Amazon Linux 2023, direct `dnf` Chromium runtime packages plus `npx playwright install chromium` pass the full Edger browser smoke without Playwright's unsupported-distribution dependency installer.
- Remote launch/status/terminate provisions an SSM-only `c7g.4xlarge` with encrypted 200 GiB gp3, no key/inbound ports, instance-shutdown termination, and a 24-hour guard.
- Remote stages are immutable, resumable only at the same SHA, resource-gated below 28 GiB RSS and 160 GiB disk, and preserve failure evidence. Promotion remains an unmerged checksum-bound PR.
- AWS workflows request sessions long enough for their declared exhaustive jobs, and corpus runs preserve run-specific partial evidence while publishing canonical frozen evidence only on success.

## Known Gaps

- GitHub Actions is in a public partial outage; wait for recovery before dispatching the six-hour remote workflow.
- The scaling suite, offline phase, league smoke/production rollout, full live-v1 reference, and full evaluator have not run.
- AWS CLI `s3 ls` returns exit 1 for an empty prefix. The implementation uses `s3api list-objects-v2`; `.keep` remains harmless in the active object prefix.

## Next Tasks

1. After GitHub Actions recovers, retry the remote production campaign at campaign SHA `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`; obey scaling, KL, league, throughput, and full-evaluation stop gates.
2. If every gate passes, review the generated promotion PR manually; never auto-merge.

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
- July 20, 2026: parity-gate correction validation -> native Node `v20.20.2`, `npm test`: 123 passed, 0 failed; `git diff --check` passed.
- July 20, 2026: `npm run edger:corpus:collect -- --store s3://edge-royale-edger-904869824856-ap-southeast-2/corpus --matches 64 --seed 20260718 --pair-offset 0 --workers 8 --opponents edger_heuristic,random,aggressive,defender --report /private/tmp/edge-royale-pilot-f25a488/collection-report.json` at `f25a488` -> 64/64 fresh games, 32 paired seeds, 32 games per side, 16 per opponent, 58 wins/6 losses/0 draws, 64/64 receipt replays, zero failures/duplicates; `79.267 s`; 16-worker projection `1.720204 h`; spec checksum `4f0a3ff9e2f5ceca208461af6b9a3c6b62cfd7ce2f4b031dbd22a993ab33804a`.
- July 20, 2026: authoritative manifest `ee1160cacfb4298b3d98e557518b0f17669f003515a150e610253a954fead2d7` -> 64 episodes, 3,682 decisions, splits 52 train/5 validation/7 test; `npm run edger:corpus:validate -- --manifest /private/tmp/edge-royale-pilot-f25a488/manifest.json --workers 16 --report /private/tmp/edge-royale-pilot-f25a488/validation-report.json` passed 64/64 checks in `20.307 s`.
- July 20, 2026: two-pass pilot cache -> 3,682 rows in deterministic 256-row groups, 708,593 bytes, decision splits 2,977 train/307 validation/398 test.
- July 20, 2026: one-epoch smoke BC -> validation joint-action loss `6.7823414259`; model `edger_v2_bc_7d9e3364fd134015`; parity passed with maximum logit error `4.76837158203125e-7` and JS/PyTorch argmax `{card:1, placement:0, delay:23}`.
- July 20, 2026: production collection run `29692403151` -> ten passed shard reports at `f25a488`, 10,000 games, 5,000 paired seeds, global indices `0…9999`, 5,000 games per side, 2,500 per opponent, 10,000 unique episode IDs, 10,000 shard replay checks, zero failures, 64 resumed pilot receipts, and 9,936 fresh games.
- July 20, 2026: run `29692403151` stopped in `Freeze manifest and verify all 10,000 stored episodes`; OIDC configured at `15:50:59Z`, S3 `HeadObject` returned HTTP 400 at `16:51:03Z`. Local recheck of episode `393a5b…` passed with 5,779 bytes, AES256, and version `OY9CT5JXxc08zKYw5YxD69F_9J5HCVd0`; no manifest or validation report was published.
- July 20, 2026: OIDC-duration correction -> all three workflow YAML files parsed, all five AWS credential steps request 43,200 seconds, CloudFormation validation passed with `CAPABILITY_NAMED_IAM`, and `git diff --check` passed.
- July 20, 2026: stack update -> `UPDATE_COMPLETE`; IAM role `edge-royale-edger-github-main` reports `MaxSessionDuration=43200`; all ten recovery jobs in run `29695924800` successfully assumed the requested 43,200-second OIDC sessions.
- July 20, 2026: recovery run `29695924800` -> all ten resumed shard reports and strict aggregation passed at `f25a488`; frozen manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c` has 10,000 episodes, 593,576 decisions, and splits 8,016 train/1,015 validation/969 test.
- July 20, 2026: `npm run edger:corpus:validate -- --manifest artifacts/edger-training/corpus/manifest.json --workers 16 --report artifacts/edger-training/corpus/validation-report.json` in run `29695924800` -> 10,000/10,000 schemas, compressed checksums, episode IDs, and replays passed in `3,673.254 s`; manifest build took `15,625.308 s`; zero failures.
- July 20, 2026: frozen evidence SHA-256 -> manifest file `bf85a0c3eca5eaeb008bfd818b3b0e726a820f671bc49a15f0b6c89e568c048d`, validation report `6fdcd7aac3ada57b6e05d4d2384f09bccff89e97c5fb0401179cb3ce6ab1ad14`, aggregate report `3cf91876347192ba3bed1008f75199314316712246e1710a206ec74b63f8a13f`.
- July 20, 2026: remote campaign run `29708015701` passed OIDC/configuration checks then failed `ec2:RunInstances` on `network-interface/*`; decoded authorization had `allowed=false`, `explicitDeny=false`, and zero matching statements. Exact campaign/run filters found zero non-terminal or run-tagged instances; the promotion job was skipped.
- July 20, 2026: failure report SHA-256 `21a0de4979a492056c26362fd4861b492e496eebf4d3c2d3a4ade9d120c1d5e5` uploaded with AES256 encryption and version `UJQYr..Kgj6WrgeQhD9gYfwKsW8pDCdv`.
- July 20, 2026: resource-aware launch-policy correction -> CloudFormation validation passed with `CAPABILITY_NAMED_IAM`; YAML syntax and `git diff --check` passed. `cfn-lint` was unavailable.
- July 20, 2026: PR `#11` merged at `c3270e3`; stack update completed at `2026-07-19T23:36:15Z`. IAM simulation allowed the exact Amazon-owned AMI, stack subnet/security group, subnet-bound network interface, tagged `c7g.4xlarge` IMDSv2 instance, and tagged encrypted gp3 volume; wrong instance type, wrong subnet, non-Amazon AMI, and unencrypted volume each returned `implicitDeny`.
- July 20, 2026: run `29708221490` launched `i-0b26a7a0600c575a2`; SSM was online, security-group ingress was `[]`, no key pair was attached, IMDSv2 was required, the root volume was encrypted 200 GiB gp3 with delete-on-termination, and the instance-shutdown behavior was `terminate`.
- July 20, 2026: bootstrap command `7bbd0188-097e-42a5-a9bd-2721184bf2a6` failed before campaign-log creation with `sh: line 1: apt-get: command not found` from Playwright's Ubuntu fallback. Run `29708221490` failed, promotion was skipped, the instance reached `terminated`, the root volume no longer exists, and exact campaign filters returned zero non-terminal instances.
- July 20, 2026: final bootstrap failure-report SHA-256 `31bb442bb4cbb97c43d2b2c64c0970335e128b02e12c3236ca03528e916adf99`; S3 version `XDL7pAUQqagX1kGa6ONKzSaACen1WbQd`. Raw SSM invocation, EC2 instance, and EBS volume records are retained beside it.
- July 20, 2026: short-lived AL2023 arm64 bootstrap-smoke instance `i-03099022b62065bcb` installed the direct `dnf` dependency mapping and Playwright Chromium, then focused SSM command `5c720feb-7900-4a9e-9b25-c986ea9beb42` passed Node `v20.20.2`, Playwright `1.58.2`, Chromium launch, page assertions, and identity-free replay export. Evidence is retained under `campaigns/20260718-v2-first/preflight/browser-bootstrap-20260720/`; the instance terminated.
- July 20, 2026: `node --test tests/edger-campaign-remote.test.js` -> 1 passed, 0 failed; JavaScript syntax, workflow YAML syntax, and `git diff --check` passed.
- July 20, 2026: native Node 20 `npm test` after the bootstrap/control-plane correction -> 124 passed, 0 failed; `290641.099 ms`.
- July 20, 2026: PR `#12` merged at `a924567`; exact campaign and bootstrap-smoke filters found zero non-terminal EC2 instances before retry.
- July 20, 2026: run `29708727986` passed main-launcher ancestry validation, OIDC launch, AL2023 RPM installation, Python dependency installation, and Playwright download, then failed before manifest loading with `production campaign requires a clean Git worktree`; `.venv/` is not ignored at `f25a488`.
- July 20, 2026: run `29708727986` instance `i-08979b1c575d5dbe3` reached `terminated`, volume `vol-0b309f1535244e238` was deleted, exact campaign filters returned zero non-terminal instances, and promotion was skipped.
- July 20, 2026: clean-worktree failure-report SHA-256 `16ab65efeaa3f2eadafc8cb08aa576b6bc5b117ecc0c48f25f613fe01206982c`; the exact remote log source version `TAXhtzPS1z5tLFWbQkVgrQeoXY1HPqOW` is copied beside the raw SSM and EC2 records.
- July 20, 2026: external-venv AL2023 smoke command `9942046d-4edd-4d30-b7ae-d59af395a4e3` passed on `i-0c2b5ab317655ef3b` after `npm ci`, `/opt/edge_royale_venv` creation, pip upgrade, and Playwright download; the exact clean-worktree command returned empty and Python reported the external prefix. Evidence is retained under `campaigns/20260718-v2-first/preflight/external-venv-20260720/`; the instance terminated.
- July 20, 2026: focused external-venv bootstrap regression -> 1 passed, 0 failed; JavaScript syntax and `git diff --check` passed.
- July 20, 2026: PR `#13` merged at `a2e2797`; exact production and smoke filters found zero non-terminal EC2 instances before retry.
- July 20, 2026: two post-`#13` workflow dispatch requests returned HTTP 503 and created no run; GitHub Status reported Actions and API Requests in `partial_outage`, incident status `investigating`. Exact AWS filters remained empty.

## Risks / Notes

- Local free disk was about 12 GiB during readiness work; production caches belong on the 200 GiB remote runner.
- Campaign workflows accept an explicit reviewed `campaign_sha`, allowing later `progress.md` handoff commits without changing the SHA used for collection/training/evaluation.
- The dedicated bucket did not exist and the AWS account had no GitHub OIDC provider before this change.
- OIDC runs `29691150328` and `29691229848` exposed the empty-prefix/policy issues before data collection; neither wrote authoritative episodes. Stack policy was corrected and successful run `29691292412` is the proof gate.
- The first pilot's parity-tool defect invalidated `b5ac17e`; its 138 archived objects remain immutable and do not enter the `f25a488` lineage.
- The collected 10,000-game `f25a488` lineage is retained and resumable. Run `29692403151` was a control-plane credential-duration failure, not an accepted corpus freeze.
- Run `29708015701` was a control-plane IAM failure before EC2 created any instance or campaign stage. Its evidence is immutable; it does not alter the accepted corpus or campaign SHA.
- Run `29708221490` was a control-plane bootstrap portability failure after infrastructure creation but before the campaign process. Its evidence is immutable; it does not alter the accepted corpus or campaign SHA.
- Run `29708727986` was a pre-stage cleanliness failure before corpus loading or scaling. Its evidence is immutable; it does not alter the accepted corpus or campaign SHA.
- The workflow dispatch commit supplies only launcher/bootstrap control code and must contain `f25a488` in its ancestry; the runner clone and every stage remain bound to `f25a488`.
- Do not bypass the GitHub workflow during its service incident; the monitor and manual promotion-PR handoff are part of the production control path.
- Any failed gate must retain evidence, terminate the runner, and leave live v1 untouched.
