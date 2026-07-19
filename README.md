# edge_royale

`edge_royale` is a lightweight, single-player Clash Royale-inspired browser game.

The shipped game is human vs **Edger** only:

- one six-tower Royale arena with pocket placement
- one fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball
- deterministic simulation
- one deterministic offline-trained policy bot, Edger
- simple local match stats against Edger
- replay hooks for deterministic debugging and opted-in training export

There are no player-facing bot levels, unlock gates, model selectors, self-play mirror mode, or browser training controls.

## Runtime model

The live browser opponent still imports the promoted `edger_policy_model_v1` artifact synchronously from `src/ai/generated/edgerPolicyCurrent.js`. The compact `edger_policy_model_v2` actor exists beside it in shadow mode and cannot become live until every v2 scaling, safety, quality, replay, timing, test, and browser gate passes.

V2 uses:

- a relative-side `32×18×24` board and 96 full-oracle global features
- masked autoregressive card, row-major placement, and 1–200 tick delay heads
- deterministic argmax and stable ties in production
- no handcrafted heuristic prior
- 36,402 exported actor parameters, below the 50,000 parameter and 1 MB limits

The frozen handcrafted oracle remains `edger_heuristic` (alias `heuristic`) for corpus teaching, league opposition, and evaluation only.

## Run the game

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Controls:

- Click a card slot, or press `1-4`, to select a hand card.
- Click or drag onto the arena to play.
- `Space` pauses, `R` resets, and `F` toggles fullscreen.
- After a match, **Export replay** downloads an identity-free file. Nothing is uploaded automatically.

Browser automation hooks:

- `window.render_game_to_text()`
- `window.advanceTime(ms)`

## Cumulative Edger training

Raw runs and caches remain ignored. Immutable promoted artifacts remain tracked.

```bash
# Collect full production simulator matches into a local or s3:// corpus.
npm run edger:corpus:collect -- --matches 2 --seed 20260718 --opponents edger_heuristic

# Validate and import a manually opted-in replay.
npm run edger:corpus:import -- --file /path/to/edge-royale-replay.json

# Validate all replay hashes/events and build an immutable manifest.
npm run edger:corpus:validate
npm run edger:corpus:manifest -- --out /private/tmp/edger_manifest.json

# Build disposable Parquet/Zstd caches, including fixed scaling subsets.
npm run edger:dataset -- \
  --manifest /private/tmp/edger_manifest.json \
  --scales-dir /private/tmp/edger_scales

# Structured behavior cloning, conservative offline improvement, and export.
npm run edger:train:bc -- \
  --dataset /private/tmp/edger_scales/edger_decisions_100pct.parquet \
  --out /private/tmp/edger_bc.pt
npm run edger:train:offline -- \
  --dataset /private/tmp/edger_scales/edger_decisions_100pct.parquet \
  --checkpoint /private/tmp/edger_bc.pt \
  --out /private/tmp/edger_offline.pt
npm run edger:export:v2 -- \
  --checkpoint /private/tmp/edger_offline.pt \
  --out /private/tmp/edger_policy_v2_candidate.json
npm run edger:generate:v2 -- \
  --model /private/tmp/edger_policy_v2_candidate.json \
  --out /private/tmp/edgerPolicyV2Candidate.js
```

Snapshot-league IMPALA/V-trace is guarded by a passing fixed 1%/10%/100% scaling report:

```bash
npm run edger:train:league -- \
  --scaling-report /path/to/scaling_report.json \
  --model /path/to/accepted_v2_champion.json \
  --checkpoint /path/to/accepted_v2_champion.pt \
  --dataset-out /private/tmp/league.parquet \
  --out-checkpoint /private/tmp/league_candidate.pt
```

See `docs/EDGER_TRAINING.md` for schemas, object layout, learning rules, league allocation, and campaign triggers.

## Validation

```bash
npm test
npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
npm run smoke:browser
npm run edger:canary -- --seed 20260718 --canary-ticks 80
```

V2 has a separate full evaluator and checksum-bound promotion command:

```bash
npm run edger:evaluate:v2 -- \
  --candidate /path/to/candidate.json \
  --champion /path/to/champion.json \
  --anchors /path/to/anchor-1.json,/path/to/anchor-2.json \
  --reference /path/to/champion-reference.json \
  --test-report /path/to/test-report.json \
  --browser-report /path/to/browser-report.json \
  --profile full \
  --out /path/to/evaluation-report.json
npm run edger:promote:v2 -- \
  --model /path/to/candidate.json \
  --report /path/to/evaluation-report.json
```

The promotion command refuses smoke profiles, artifact checksum mismatches, missing external reports, or any failed gate. Campaign automation opens a pull request after it succeeds.

## Docs

- Game rules: `docs/GAME_RULES.md`
- Card balance: `docs/CARD_SPECS.md`
- Edger runtime and baselines: `docs/BOT_LEVELS.md`
- Cumulative training: `docs/EDGER_TRAINING.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Sprint backlog: `docs/SPRINT_BACKLOG.md`
