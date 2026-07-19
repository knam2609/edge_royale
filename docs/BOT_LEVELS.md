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

## Live v1

The live artifact remains:

- `artifacts/edger-training/promoted/edger_policy_current.json`
- `src/ai/generated/edgerPolicyCurrent.js`
- schema `edger_policy_model_v1`

It uses the existing masked action-scoring MLP and stable action ordering. The frozen handcrafted prior is still part of this promoted bootstrap artifact. It remains live until v2 clears every separate promotion gate.

## Shadow v2

V2 uses schema `edger_policy_model_v2`, full-oracle relative-side spatial observations, autoregressive card/placement/delay heads, deterministic masked argmax, and no handcrafted prior. `src/ai/generated/edgerPolicyV2Shadow.js` is synchronous but is not used by browser gameplay.

The actor validator enforces:

- exact observation/action/architecture versions
- finite float weights and exact dimensions
- at most 50,000 actor parameters
- at most 1 MB serialized actor JSON

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

The legacy `npm run edger:evaluate` and `npm run edger:promote` commands apply to v1 only. V2 uses `npm run edger:evaluate:v2` and `npm run edger:promote:v2`; promotion remains blocked until the large-sample contract in `docs/EDGER_TRAINING.md` has actually passed.
