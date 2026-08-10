## Current State

- As of August 10, 2026, live browser Edger remains tracked v1. No v2 artifact has been promoted or wired into gameplay.
- Checksum-bound recovery implementation is complete in the working tree but is not yet merged. Final reviewed campaign SHA therefore does not exist yet.
- Checked-in `edger_scaling_recovery_v1` pins exact retained artifacts from `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`. Recovery-manifest SHA-256 is `f3afafdc84303d918ef45be1095e04f7bc8ba75c03eac77184d72428badd760e`.
- New target is `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260810-v2-recovery`. No implementation command wrote to this prefix during validation.
- Source campaign `20260718-v2-first`, failed attempt, and retained failure artifacts remain unchanged.

## Source of Truth

- Workflow and product boundaries: `AGENTS.md`
- Product overview and commands: `README.md`
- Training/recovery/stage contract: `docs/EDGER_TRAINING.md`
- Recovery artifact versions/checksums/expected evidence: `artifacts/edger-training/recovery/edger_scaling_recovery_v1.json`
- Remote control and runner: `scripts/edger-campaign-remote.mjs` and `scripts/edger-production-campaign.mjs`
- Workflow control plane: `.github/workflows/edger-campaign.yml`
- Source evidence: `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260718-v2-first/`

## What Works

- Recovery downloads exact S3 object versions, checks SHA-256, source ancestry, unchanged protected derivation paths, sole legacy `<0.10` failure reason, all artifact bindings, nested training sets, identical held-out sets, zero illegal actions, and replay success.
- Recovery regenerates passing `edger_data_scaling_report_v2`; each scale records source checkpoint Git commit. Exact losses remain `5.6647690651 / 4.2088897448 / 3.6891030495`; frozen scores remain `0.54 / 0.795 / 0.86`.
- Scaling marker and all durable objects bind target Git SHA plus recovery-manifest checksum. Existing mismatched objects, extra stage objects, or markers fail closed. Target corpus manifest is seeded only from recovered 100% manifest.
- Staged runner supports `full-cache`, `offline`, and `full-evaluation`. Matching markers resume; target stage stops cleanly. Only `full-cache` persists Parquet.
- Full-cache builder creates only recovered 100% cache and validates manifest `ca8435e58fd500f6045727db283de32ac906b3584b187abb84a5aa569867939c`, 593,576 rows, `475,845 / 59,529 / 58,202` split rows, schema, Zstd, 256-row groups, and replay-derived logical content.
- Offline requires parent `edger_v2_bc_418be44c61fba9b1`, current campaign SHA, and validation KL at most `0.05`.
- Workflow `run` no-ops on matching marker, monitors matching runner without duplication, launches only when safe, detaches successfully after five hours if still active, fails terminated-without-marker, and uses unique run logs. `promote` requires full-evaluation marker, zero active runners, checksum revalidation, and opens manual-review PR only.

## Known Gaps

- No reviewed recovery implementation SHA has been merged or recorded.
- Target prefix emptiness has not been operationally confirmed in this session.
- No target scaling/full-cache marker or rebuilt Parquet checksum exists yet.
- Offline, live-v1 reference, league smoke/production, QA, throughput, full evaluator, and promotion dispatches remain unrun.
- No promotion PR exists.

## Next Tasks

1. Review and merge recovery implementation; record full reviewed main SHA.
2. Confirm `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260810-v2-recovery/` is empty.
3. Dispatch workflow with `operation=run`, recorded SHA/URI, `target_stage=full-cache`; verify scaling/full-cache markers, cache checksum/count/schema evidence, unique log, instance termination, and volume deletion.
4. Dispatch `target_stage=offline`; verify recovered parent lineage, current SHA, KL gate, log, and cleanup.
5. Dispatch `target_stage=full-evaluation`; verify resumed reference, league smoke/production, QA, throughput, evaluator, log, and cleanup.
6. Dispatch `operation=promote` with `target_stage=full-evaluation`; manually review generated PR and never auto-merge.

## Validation

- August 10, 2026: `node --test tests/edger-scaling-recovery.test.js tests/edger-campaign-stages.test.js tests/edger-campaign-remote.test.js tests/edger-scaling-gate.test.js` -> 12/12 passed.
- August 10, 2026: `npm run test:edger-streaming` -> 3/3 passed in `18.217 s`.
- August 10, 2026: `npm test` -> 135/135 passed in `413117.931 ms`.
- August 10, 2026: `npx -y node@20.20.2 /usr/local/bin/npm run smoke:browser` -> passed Edger-only runtime and identity-free replay export. System Node 25 attempt hit watchdog; repository-pinned Node 20 passed after `npm ci` refreshed Playwright packages.
- August 10, 2026: `node scripts/edger-scaling-recovery.mjs --manifest artifacts/edger-training/recovery/edger_scaling_recovery_v1.json --out-dir /tmp/edger-recovery-final.D6RbQM --target-git-sha d00835156bcaac631f040535dd87de61adbbe30b --campaign-uri s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260810-v2-recovery` -> read-only exact-version recovery passed; regenerated v2 report passed and source checkpoint commits matched `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`.
- August 10, 2026: workflow YAML parse, Node syntax, Python source compilation, protected-path diff check, and `git diff --check` passed.

## Risks / Notes

- Final campaign SHA must descend from source SHA and keep protected corpus/dataset/simulator derivation paths unchanged; recovery correctly refuses otherwise.
- Target prefix is immutable for one reviewed SHA/recovery checksum. Do not reuse it for later code changes.
- Rebuilt Parquet intentionally receives a new checksum; equivalence is established through exact manifest, deterministic derivation, rows/splits, schema, compression, row groups, and logical-content hash.
- Any later gate failure stops campaign and leaves live v1 untouched. Manual promotion PR merge remains only live-model transition.
