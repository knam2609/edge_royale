# edge_royale plan

## Context
This is a super lightweight version of Clash Royale, the most famous Supercell mobile game.

Instead of playing against other player online, player will play will play against bots that have different levels of playing:

- Noob (random playing)
- Mid-ladder Menace (low-level strategic, greedy aggressive playing style)
- Top Ladder (mid-level strategic, good elixir management and cycle count)
- Pro (Ryley) (high-level strategic, very good elixir management and close to prefect cycle count)
- Goat (Mo Light) (extremly high-level strategic, perfect elixir management and cycle count)
- God (perfect gameply, can see opponents' cycle and elixir)

Players have to beat previous level to play the next one.

Once they play enough games for us to gather their gameplay data, we will unlock self play, which is playing again ur own self and use reinforcement learning to make the self bot better as you get better.

## Details
Gameplay will be the same as Clash Royale. Link to game details: https://clashroyale.fandom.com/wiki/Basics_of_Battle 

We only gonna use one basic deck: Giant, Knight, Archers, Mini Pekka, Musketeer, Goblins, Arrows and Fireball to make sure we focus on building the algorithm for bots.
The sim currently uses a level 11 tournament-standard stat baseline with simplified mechanics where the engine intentionally diverges from full Clash Royale parity.

Learn how to implement UI here: https://github.com/Noisyboy-9/clash_royale_game

## Detailed planning docs

- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Game rules spec: `docs/GAME_RULES.md`
- Card balance spec: `docs/CARD_SPECS.md`
- Bot tiers spec: `docs/BOT_LEVELS.md`
- Neural training pipeline: `docs/TRAINING_PIPELINE.md`
- Sprint/task backlog: `docs/SPRINT_BACKLOG.md`

## Run prototype

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Controls:
- Click a card slot (or press `1-4`) to select a hand card
- Click arena to play the selected card (troops on your side unless you have unlocked a pocket by destroying a crown tower)
- Drag a card from hand to arena to play on release
- `Space` pause/resume
- `R` reset
- `F` fullscreen toggle

Ladder + training:
- Select bot difficulty from the `Bot Level` dropdown (locked levels show as disabled).
- Beat a tier to unlock the next (`Noob` -> `Mid-ladder Menace` -> `Top Ladder`).
- Click `Train Self Bot` to fit the current local self-play placeholder model from logged player actions.
- Self-play unlock rule is enforced from profile data (`100` matches and `3` wins vs Top).

Automation hooks exposed in browser:
- `window.render_game_to_text()`
- `window.advanceTime(ms)`

## Offline Ladder training

```bash
bash scripts/train-bot-ladder.sh
```

By default the script writes a timestamped run under `artifacts/training/runs/`, exports shard files for each fair ladder tier (`noob`, `mid`, `top`, `pro`, `goat`), trains one saved model per tier, and benchmarks each saved model.

Customize a run with env vars when needed:

```bash
LADDER_RUN_NAME=ladder-v2 LADDER_SHARDS=4 LADDER_EPISODES=500 LADDER_BENCH_ROUNDS=50 bash scripts/train-bot-ladder.sh
```

Generated training artifacts are ignored by git. `data:export` still writes compact JSON shard files by default, and `train:bot` trains a specific fair ladder tier with `--target-tier <tier>`.

Fair ladder tiers use deterministic plain-JS inference when a valid same-tier model artifact is supplied and fall back to their heuristic policies otherwise.
`train:ladder` also writes `artifacts/training/ladder-models.json`, an ignored local manifest that points each trained fair tier at the latest run's saved model.
The browser loads that manifest on startup; missing, invalid, or mismatched model entries fall back to heuristics.

Benchmark the normal ladder matrix against the configured local models with:

```bash
npm run bot:bench -- --model-config artifacts/training/ladder-models.json
```
