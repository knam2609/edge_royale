# How internal harnesses play `edger` after the c3 promotion: review, November 28, 2026

This review prepares the owner decision in Next Task 2 of `progress.md`. When
written, no harness, gate, test or frozen run had changed. The numbers come
from a read-only scratch copy of the benchmark suite, run on the clean
`edger-v2-accumulated` tree.

- `HR` = `~/edge_royale-runs/20261127-harness-review.noindex/`: `scripts/gate.mjs`, `logs/` (one JSON line per variant), `repo-commit.txt`, `README.md` (commands) and `SHA256SUMS`.
- `PV` = `~/edge_royale-runs/20261125-promotion-review.noindex/`, the November 25 promotion review (its gate log, scratch live-path benchmark and acceptance probe).

## Summary

- **The bare bot id `edger` now means a bot that nobody plays.** Three harnesses resolve it to the live module (c3), but play it through `selectBotAction`: the legacy shortlist and a one-tick delay. Before the promotion that path was exactly live v1. Now it is neither live c3 (full grid, its own learned delay) nor live v1.
- **The AGENTS.md gate is the visible case.** It reports 1.000 against all three baselines, but it measures that off-path bot on a single-tower arena whose integer tile list does not contain the v2 decoder's tile centres. All 2,557 of its plays are off the model's own legal list, and the engine snaps them. Played as players face it, c3 also wins every resolved game there, but 30 of 90 games are draws, and again every play (3,684) is off-list.
- **On the production arena, c3's live path passes cleanly**: 30-0, 29-1 and 30-0, with 0 off-list plays. The off-path c3 there beats aggressive only 21-9 (0.700), below both live c3 and v1 (24-6), so the harness bot is a different opponent, not just a different label.
- **Training, selection and corpus collection have drifted silently.** In the cadence tooling, `edger` is the champion bucket of every seed plan (about 80% of training games) and the "live v1" opponent of the candidate selection rule. In corpus collection it is the Edger side of every game, labelled with the live model's id. Rerun at this commit, each would play the off-path c3 instead of v1. The candidate campaign is unaffected only because it ran in a clean clone of `567ec98`.
- **Recommendation (option B): play the shipped bot where the gate means the shipped bot, and pin the retired v1 where the history means v1.** The benchmark gate plays c3 through `selectBotDecision` on the production arena. The cadence tooling and corpus collection play the retired v1 module explicitly, labelled as v1. That keeps every recorded plan, comparison, campaign and the 10,000-game base corpus reproducible at the new commit. A future recipe that trains or selects against c3 is a separate experiment, and the existing `--opponent-model` path already plays c3 on its own cadence.

## Where `edger` is played off its live path

The browser calls `selectBotDecision`. For a v2 model, that function enumerates the model's own legal actions and returns the model's delay. For every other bot it rolls the delay, then calls `selectBotAction`. `selectBotAction` passes a v2 model whatever list the caller enumerated. It does not roll a delay: callers roll `BOT_CONFIG`'s, which is one tick for `edger`.

| Harness | Used by | What `edger` plays today | RNG order for other bots |
|---|---|---|---|
| `src/ai/benchmark.js` | `npm run bot:bench` (the AGENTS.md gate), `tests/bot-regression.test.js`, the legacy v1 evaluator `edger:evaluate` (which passes its v1 model explicitly) | live c3 on the legacy shortlist, one-tick delay, single-tower 18×32 arena | delay roll, then selection |
| `scripts/edger-v2-cadence-core.mjs`, bot-opponent branch | `train-arm` (each plan's `training_opponents`: `edger` everywhere outside the heuristic band [0.4, 0.6)), `evaluate --opponent edger` (development and selection seed sets), `probe` | the same off-path c3, production arena | **selection, then delay roll** |
| `scripts/edger-collection-core.mjs` | `edger:corpus:collect` (the `edger-corpus-collect.yml` workflow), `edger:canary` | the same off-path c3, production arena, labelled `checkpoint_id` = c3's id with `behavior_probabilities: "known"` | delay roll, then selection |

These already pass models explicitly and are unaffected: the v2 evaluator and its worker, the league worker (the champion and snapshots are model opponents), the scaling evaluator (live v1 by path), the October runtime-cost study (pinned to v1), and the browser.

One correction to the earlier note in `progress.md`, which said rerouting through `selectBotDecision` is bit-identical for every other bot because the delay roll comes first. That holds for the benchmark and collection harnesses. The cadence harness selects first and rolls after, so rerouting its whole bot branch would change the random, aggressive and defender games (the heuristic draws nothing from the RNG). Aggressive is a selection opponent. Only that harness's `edger` case can change without moving other games.

On `main`, nothing has drifted: live Edger is v1 there, and `selectBotAction` is its live path. The drift arrives with publication. Once the branch reaches `main`, a dispatched corpus collection would collect the off-path c3.

## Measurements

The AGENTS.md suite (suite seed 20260630, 30 rounds per opponent with sides swapped on odd rounds, 6,040 ticks, the same pair, match and controller seeds), varying the arena and how Edger plays. Wins-losses-draws; the win rate is over resolved games. "Off-list" counts plays not in the list the model itself enumerates on that arena.

| Arena | Edger | random | aggressive | defender | Edger plays (Giant / Fireball / Arrows) | Off-list | Time |
|---|---|---|---|---|---|---|---|
| benchmark | off-path c3 (today's gate) | 30-0-0 (1.000) | 30-0-0 (1.000) | 29-0-1 (1.000) | 2,557 (0 / 0 / 0) | 2,557 | 204 s |
| benchmark | live c3 | 26-0-4 (1.000) | 20-0-10 (1.000) | 14-0-16 (1.000) | 3,684 (0 / 0 / 57) | 3,684 | 56 s |
| benchmark | retired v1 | 26-0-4 (1.000) | 15-3-12 (0.833) | 23-0-7 (1.000) | 3,358 (105 / 9 / 56) | 0 | 170 s |
| production | off-path c3 | 30-0-0 (1.000) | 21-9-0 (0.700) | 30-0-0 (1.000) | 1,371 (0 / 0 / 1) | 0 | 129 s |
| production | live c3 | 30-0-0 (1.000) | 29-1-0 (0.967) | 30-0-0 (1.000) | 1,372 (0 / 0 / 0) | 0 | 16 s |
| production | retired v1 | 29-1-0 (0.967) | 24-6-0 (0.800) | 30-0-0 (1.000) | 1,785 (46 / 11 / 98) | 0 | 64 s |

Times are wall clock with all six variants running at once on the M6, so they compare paths only roughly.

- The off-path c3 on the benchmark arena is today's gate, and it reproduces the recorded November 25 result (`PV/logs/bot-bench-gate.log`).
- Live c3 on the benchmark arena reproduces the November 25 scratch run in `PV`, play counts included.
- **The retired v1 on the benchmark arena reproduces the pre-promotion gate exactly** (26-0 with 4 draws, 15-3 with 12, 23-0 with 7; [runtime review](EDGER_RUNTIME_REVIEW.md)). Pinning the retired module therefore restores the pre-promotion behaviour, at least on this suite.
- **The off-path c3 is a distinct opponent.** On the production arena it beats aggressive 0.700, below both live c3 (0.967) and v1 (0.800). It is the bot every cadence plan and corpus collection would now face.
- On the benchmark arena, the v2 decoder's tile centres are never in the integer tile list, so every c3 play is off-list. The engine accepted every play the probe checked (`PV/logs/probe-accept.log`). That rests on its snapping, not on the model's mask.
- c3's live path decides on its own cadence: 10,062 decisions over the 90 production-arena games. v1 and the off-path c3 decide every tick (245,440 decisions for v1 there). That is why the live path runs several times faster.

## Options

**A. Live path everywhere.** All three harnesses play c3 through `selectBotDecision`.
- The gate measures the shipped bot.
- The cadence champion bucket and the selection rule's "live v1" become live c3, so every recorded plan changes meaning at the new commit. The candidate recipe was validated against v1; training against c3 is an untested recipe.
- New corpora would use c3 as the Edger side. That changes the BC teacher (c3 casts no Fireball and almost never plays Giant). Such corpora also cannot be merged with the base corpus, whose `edger` stratum is v1.

**B. Split by purpose (recommended).**
- Gate: c3 through `selectBotDecision`. Other bots stay bit-identical (roll, then select).
- Cadence `edger` and corpus collection: the retired v1 module (`artifacts/edger-training/retired/edger_policy_bootstrap_20260701/edgerPolicyCurrent.js`, `69333cd5…`) through `selectBotAction`. That is byte for byte the bot every recorded plan, comparison, the campaign and the base corpus played. Collection labels it with v1's id. The cadence harness's other bots are untouched.
- A recipe that wants c3 as the champion or selection opponent uses `--opponent-model` or the snapshot-league mix. Both already play a v2 model on its own cadence with both sides checked for legality. That would be a new recipe, decided and measured on its own.

**C. Pin v1 everywhere.** The gate would then measure v1, not the shipped bot. Not recommended: the gate exists to check the bot players face.

### The gate's arena (part of A or B)

- **B1, keep the benchmark arena.** The gate keeps its historical arena. c3 passes at 1.000 on resolved games, but 30 of 90 games are draws and every play depends on engine snapping.
- **B2, move the gate to the production arena (recommended).** It measures the shipped bot in the shipped arena. The gate command is unchanged. Its numbers move for every bot: the retired v1, `main`'s live bot, reads 0.967, 0.800 and 1.000 there, against 1.000, 0.833 and 1.000 on the benchmark arena. (Measured on this branch, whose `src/sim` equals `main`'s.) Add an off-list count to the suite's output that fails the gate on any off-list play. The legacy v1 evaluator `edger:evaluate` also calls this suite, so B2 should either keep the benchmark arena behind a parameter for it, or accept that its v1-only reports move too. Keeping the parameter is the smaller change.

## What B2 would change

- `src/ai/benchmark.js`: Edger through `selectBotDecision` (other bots unchanged); an `arena` parameter defaulting to `production` for `runEdgerBenchmarkSuite`, with the legacy evaluator passing `benchmark`; an `off_list` count per pair; `scripts/bot-benchmark.mjs` fails on any off-list play.
- `scripts/edger-v2-cadence-core.mjs` and `scripts/edger-collection-core.mjs`: the `edger` bot id plays the retired v1 module explicitly; collection's descriptor records v1's model id.
- Tests:
  - the cadence `edger` opponent and the collection canary reproduce a clean `d53fdf8` clone's output (the last pre-promotion commit);
  - the benchmark's non-Edger games are unchanged;
  - the gate test passes on the production arena with 0 off-list plays.
- Docs: `AGENTS.md` (Current Hot Spots and the gate), `docs/BOT_LEVELS.md`, `docs/EDGER_TRAINING.md` (what `edger` means in plans and corpora), `README.md`, `progress.md`.
- Validation: `PYTHON=/usr/local/bin/python3 npm test` and the AGENTS.md benchmark gate.

## Questions for the owner

1. Option A, B or C for the cadence tooling and corpus collection?
2. For the gate, B1 (benchmark arena) or B2 (production arena)?
3. Should the cadence and corpus harnesses refuse the bare `edger` id and require an explicit `edger_v1` pin? That is safer against the next promotion, but it changes every seed plan's opponent labels, so recorded plans would need a translation.

## Limits

- 90 games per variant on one suite seed. These show where each path stands against the gate, not how close the variants are to each other.
- The off-list count reflects the model's own enumeration on each arena. It is not a test of the engine's snapping rules.
- No variant was measured against the heuristic, which the AGENTS.md gate does not include (the bot spec's longer command does).
