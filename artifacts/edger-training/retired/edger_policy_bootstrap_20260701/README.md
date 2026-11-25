# Retired live v1: `edger_policy_bootstrap_20260701`

Live Edger from July 1, 2026 until the owner approved promoting the candidate
campaign's c3 (`edger_v2_candidate_20261123-L_c3`) on November 25, 2026
([decision](../../../../docs/EDGER_CANDIDATE_CAMPAIGN.md#owner-promotion-decision-november-25-2026)).
These files are the live v1 files byte for byte, copied from commit `d53fdf8`
before `edger:promote:v2` replaced them:

| File | Was | SHA-256 |
|---|---|---|
| `edger_policy.json` | `artifacts/edger-training/promoted/edger_policy_current.json` | `895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa` |
| `edger_policy_report.json` | `artifacts/edger-training/promoted/edger_policy_current_report.json` | `31f251aefe420b176c282d222cbdb1e041af05435bfc886618d6a2e7cc58f845` |
| `edgerPolicyCurrent.js` | `src/ai/generated/edgerPolicyCurrent.js` | `69333cd508d3aebab3a246c6a9b1638960fb20611c6198eb81e08b9aae682847` |

Nothing in `src/` imports them. Tests use them for these purposes:

- `tests/bot-runtime.test.js` uses `edger_policy.json` as its v1 model. The
  v1 ML path still serves any `edger_policy_model_v1` model.
- `tests/edger-v2-runtime-cost-browser.test.js` stages `edgerPolicyCurrent.js`
  as the module the October runtime-cost study pinned (`LIVE_V1_PIN`).

Earlier evaluations name the live v1 champion by this artifact's hash
(`895d5541…`). To play against it, pass `edger_policy.json` explicitly, for
example as `--champion`.
