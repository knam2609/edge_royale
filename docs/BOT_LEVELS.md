# Edger Bot Spec

## Product bot

The shipped game has one automatically selected opponent: **Edger**.

Edger:

- is deterministic for the same model, seed, and input stream
- may use exact opponent elixir, hand, and deck queue
- returns only legal `PLAY_CARD` actions or `PASS`
- has no deliberate blunders, mercy rule, or progression scaling
- imports a synchronous generated JavaScript model

There is no bot selector, player-facing level, unlock, training UI, or model control.

## Live Edger: v2 candidate c3

Since the owner approved it (November 25, 2026; merged into `edger-v2-accumulated` November 26, unpushed, so `main` keeps v1), the live artifact is:

- `artifacts/edger-training/promoted/edger_policy_current.json` (`edger_v2_candidate_20261123-L_c3`, SHA-256 `26a56150…`)
- `src/ai/generated/edgerPolicyCurrent.js`
- schema `edger_policy_model_v2`, action space `edger_autoregressive_full_grid_v1`

The browser's `selectBotDecision` re-enumerates the full grid for it and waits the delay the model picks (1–200 ticks), instead of v1's fixed one-tick cadence. It passed the full evaluation ([result](EDGER_CANDIDATE_CAMPAIGN.md#owner-promotion-decision-november-25-2026)). Known weaknesses, reported rather than gated: it does not cast Fireball and rarely plays Giant or Arrows.

## Retired v1

The v1 bootstrap `edger_policy_bootstrap_20260701` (schema `edger_policy_model_v1`, the masked action-scoring MLP with the frozen handcrafted prior) was live until then. Its artifact, report and generated module are kept byte for byte in `artifacts/edger-training/retired/edger_policy_bootstrap_20260701/`. The v1 ML path still serves any v1 model passed explicitly.

## V2 policy

V2 uses schema `edger_policy_model_v2`, full-oracle relative-side spatial observations, autoregressive card/placement/delay heads, deterministic masked argmax, and no handcrafted prior. `src/ai/generated/edgerPolicyV2Shadow.js` holds the untrained shadow bootstrap and is not used by browser gameplay.

The actor validator enforces:

- exact observation/action/architecture versions
- finite float weights and exact dimensions
- at most 50,000 actor parameters
- at most 1 MB serialized actor JSON

The `edger_autoregressive_full_grid_v1` action space scores every tile the
engine accepts for the selected troop, including all legal pocket and bridge
tiles after a tower falls. The placement scorer learns from actor-relative
row and column alongside its existing board features. Legacy artifacts and
the frozen heuristic use the original shortlist. Full-grid is the adopted
training action space (owner, November 13, 2026), and the promoted c3 makes
it live.

See `docs/EDGER_TRAINING.md` for corpus, PyTorch learning, checkpoint, scaling, league, and scheduling details.

## Internal baselines

Internal baselines exist only for tests, corpus generation, and evaluation:

- `edger_heuristic` / `heuristic`: frozen handcrafted oracle
- `random`: noisy legal actions with frequent passing
- `aggressive`: over-commits into pressure
- `defender`: favors defense and delayed commits

They are not product levels.

## Profile

The browser stores only aggregate Edger match counts, wins, losses, draws, and timestamps under `edge_royale_profile_v2`.

## Current validation

```bash
npm test
npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
npm run smoke:browser
npm run edger:canary -- --seed 20260718 --canary-ticks 80
```

The legacy `npm run edger:evaluate` and `npm run edger:promote` commands apply to v1 only. V2 uses `npm run edger:evaluate:v2` and `npm run edger:promote:v2`; a v2 model promotes only with a passing full report under the large-sample contract in `docs/EDGER_TRAINING.md` and the owner's approval. Both v2 commands refuse `diagnostic_only_not_promotable` models.

`npm run bot:bench` still plays Edger through `selectBotAction`: the legacy shortlist, a one-tick delay and a single-tower arena. For the promoted c3 that is not its live path; see the [promotion record](EDGER_CANDIDATE_CAMPAIGN.md#owner-promotion-decision-november-25-2026) and the [harness review](EDGER_HARNESS_REVIEW.md), which awaits an owner decision.
