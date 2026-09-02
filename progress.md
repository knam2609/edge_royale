## Current State

- September 3, 2026: cache schema-pin and lossless-content fixes are implemented locally, not committed. HEAD remains `65e0eaacbec8c32d838d2f262cdfbb8d2f53fca2`; live browser Edger remains v1.
- Prepared retry target: `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260903-v2-recovery`. Updated recovery-manifest SHA-256: `1a7c279b1a849cbd5d208c2aceda06f78699e8a49e27a515f4a6ff8cd4c64416`. A new reviewed campaign SHA is still required.
- Previous run `31401500677` at HEAD's SHA failed full-cache after 5h12m51s under `20260810-v2-recovery`; immutable scaling marker passed. No full-cache marker or durable Parquet exists there. Offline and promotion were not dispatched.
- No new campaign was launched. September 3 read-only checks found zero versions/delete markers under the prepared retry prefix and zero pending/running campaign runners; repeat these checks immediately before dispatch.

## Source of Truth

- Product/workflow boundaries: `AGENTS.md`, `README.md`
- Cache, recovery, and stage contract: `docs/EDGER_TRAINING.md`
- Exact source versions/checksums and corrected target/schema: `artifacts/edger-training/recovery/edger_scaling_recovery_v1.json`
- Runner/control plane: `scripts/edger-production-campaign.mjs`, `scripts/edger-campaign-remote.mjs`, `.github/workflows/edger-campaign.yml`
- Preserved failure evidence: `s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260810-v2-recovery/`

## What Works

- The first 256 production-derived rows and retained smoke caches reproduce schema `db321aeefdb97390989837f6427657a422978f2449b5711c5a60973a2e11c811` on PyArrow 17 and 21. The former `92c06e...` expected pin was incorrect, not an AWS-only schema change.
- Cache hashing now compares original rows with Arrow-normalized rows before hashing the storage representation. Lossless `0`/`0.0` changes pass; truncation, dropped fields, wrong schema, and tampered content fail. Repeated fixture builds produce identical Parquet checksums.
- Full-cache runs `npm run test:edger-streaming` before its expensive corpus scan, with Python bytecode writes disabled to preserve the clean checkout. Corpus-health dispatch reads the retry URI from the manifest; changed code refuses the consumed August prefix.
- Original source SHA `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`, source object versions/checksums, protected derivation paths, rows/splits, and scaling evidence remain unchanged. Recovered losses are `5.6647690651 / 4.2088897448 / 3.6891030495`, scores `0.54 / 0.795 / 0.86`, full checkpoint `edger_v2_bc_418be44c61fba9b1`.
- August scaling marker version `krBkE0nMLwWZlSvnTwZKOpDKi8knQ41D` remains passed/immutable. Its runner terminated, volume `vol-0727a11c45d438908` was deleted, and unique log `logs/github-31401500677-1.log` was retained.

## Known Gaps

- Corrected code has not been reviewed/committed or run on a new AWS runner. No accepted full-cache checksum exists; offline, full evaluation, and promotion remain unrun. No promotion PR exists.
- August failed cache built 593,576 rows, splits `475,845 / 59,529 / 58,202`, 103,317,375 bytes, Zstd and 256-row groups. Its raw JSON content hash `882c79f13a1d497f2d8450f73b975ad1f657d6d2025834cae9788d4d0e57647e` is unvalidated diagnostic evidence, not the corrected content checksum.
- The failed-stage archive `failed-stages/full-cache/2026-08-10T20-15-32-249Z/` retains build/timing reports, not the discarded Parquet file. Full 593,576-row validation and actual AWS preflight still require the next run.

## Next Tasks

1. Review and commit/merge the cache fix; record the new full immutable campaign SHA and corrected recovery checksum. Keep all later stages on that SHA/prefix.
2. Re-run exact-version recovery dry run for the final SHA; immediately verify the new prefix has no objects/versions/delete markers and no active runner/workflow before dispatch.
3. Dispatch `full-cache` against `20260903-v2-recovery`; verify both immutable markers, full counts/splits/schema, 2,319 deterministic row groups, content/Parquet checksums, exactly one durable Parquet, unique log, runner termination, and volume deletion.
4. Only after full-cache passes, dispatch `offline` using the same SHA/prefix; verify recovered parent and validation KL at most `0.05`.
5. Dispatch `full-evaluation`; verify reference, league smoke/production, QA, throughput, evaluator, and cleanup.
6. Dispatch `promote`; manually review the generated PR and never auto-merge.

## Validation

- September 3: new regressions first reproduced the bad schema pin, numeric-text content mismatch, and silent late truncation/field dropping on unchanged code; all pass after the fix.
- September 3: `npm run test:edger-streaming` -> 6/6 passed on Python 3.11 / PyArrow 17.0.0 in 32.180 s; no test bytecode left in checkout.
- September 3: `PYTHON=/tmp/edger-schema-env.sjbDGx/venv/bin/python3 npm run test:edger-streaming` -> 6/6 passed on isolated PyArrow 21.0.0 in 32.189 s.
- September 3: `node --test tests/edger-scaling-recovery.test.js tests/edger-campaign-stages.test.js tests/edger-campaign-remote.test.js tests/edger-scaling-gate.test.js` -> 14/14 passed, including runner preflight order and old-prefix rejection.
- September 3: `npx -y node@20.20.2 /usr/local/bin/npm test` -> 136/136 passed in 581679.861 ms, including the internal baseline benchmark. The subsequent runner-preflight assertion is covered by the focused suite above.
- September 3: a read-only 257-row production replay sample (fixed probe weight `0.5`, not full production balancing) passed schema/content validation on Arrow 21 with splits `171 / 35 / 51` and two row groups. Probe reports: `/tmp/edger-schema-probe.v9N7kr/`; no S3 writes.
- September 3: workflow YAML/dispatch shell syntax, Node/Python syntax, source-artifact equality, protected-path diff, and `git diff --check` passed. No browser smoke or standalone benchmark run: client, live policy, simulator, and heuristics were unchanged.
- August 11 operation: `gh run watch 31401500677 --exit-status` failed at cache schema gate; `aws ec2 describe-volumes --volume-ids vol-0727a11c45d438908` returned `InvalidVolume.NotFound`; promotion job was skipped.

## Risks / Notes

- `20260810-v2-recovery` belongs permanently to SHA `65e0eaacbec8c32d838d2f262cdfbb8d2f53fca2` and old recovery checksum `f3afafdc84303d918ef45be1095e04f7bc8ba75c03eac77184d72428badd760e`; never write changed-code artifacts there.
- The new manifest changes only the target URI and expected schema pin. The source campaign and all source artifacts remain immutable.
- Never start offline without a passed matching full-cache marker. Any later defect requiring another commit also requires another fresh campaign prefix. Manual promotion PR merge remains the only live-model transition.
