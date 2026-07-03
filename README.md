# edge_royale

`edge_royale` is a lightweight, single-player Clash Royale-inspired browser game.

The shipped game is human vs **Edger** only:

- one arena
- one fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball
- deterministic simulation
- one deterministic offline-trained policy bot, Edger
- simple local match stats against Edger
- core replay serialization for determinism/debugging

There are no player-facing bot levels, unlock gates, self-play mirror bot, or browser training UI.

## Game Shape

Edger is a deterministic ML policy loaded from a generated JavaScript module at browser startup. It may use exact opponent elixir, hand, and deck queue, acts every tick, scores legal actions with a stateless feed-forward model, uses no runtime sampling or RNG, and breaks ties with stable action ordering.

The previous handcrafted oracle is frozen as the internal baseline `edger_heuristic`, also available through the alias `heuristic`.

Internal benchmark baselines exist only for CLI/tests:

- `edger_heuristic`
- `random`
- `aggressive`
- `defender`

These are not product levels and are not exposed in the browser UI.

The sim currently uses a level 11 tournament-standard stat baseline with simplified mechanics where the engine intentionally diverges from full Clash Royale parity.

## Docs

- Game rules: `docs/GAME_RULES.md`
- Card balance: `docs/CARD_SPECS.md`
- Edger/baseline AI spec: `docs/BOT_LEVELS.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Sprint/task backlog: `docs/SPRINT_BACKLOG.md`

## Run Prototype

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Controls:

- Click a card slot, or press `1-4`, to select a hand card
- Click arena to play the selected card
- Drag a card from hand to arena to play on release
- `Space` pause/resume
- `R` reset
- `F` fullscreen toggle

Browser automation hooks:

- `window.render_game_to_text()`
- `window.advanceTime(ms)`

## Validation

Run the Node suite:

```bash
npm test
```

Run the Edger benchmark gate:

```bash
npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
```

Evaluate a promoted policy model:

```bash
npm run edger:evaluate -- --model artifacts/edger-training/promoted/edger_policy_current.json
```

Train and evaluate a candidate policy:

```bash
npm run edger:train -- --mode ppo --seed 20260704 --profile smoke --out-dir /private/tmp/edger-train-smoke
npm run edger:evaluate -- --model /private/tmp/edger-train-smoke/edger_policy_candidate.json --json-out /private/tmp/edger-train-smoke/evaluation_report.json
npm run edger:promote -- --model /private/tmp/edger-train-smoke/edger_policy_candidate.json --report /private/tmp/edger-train-smoke/evaluation_report.json --require-gates
```

Run the daily training orchestration locally:

```bash
npm run edger:daily -- --seed 20260704 --profile daily
```

Run the browser smoke:

```bash
npm run smoke:browser
```

The browser smoke starts the static dev server on an ephemeral localhost port, verifies the Edger-only UI, advances a match, checks profile stat persistence, and shuts the server down.
