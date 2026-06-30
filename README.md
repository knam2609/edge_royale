# edge_royale

`edge_royale` is a lightweight, single-player Clash Royale-inspired browser game.

The shipped game is human vs **Edger** only:

- one arena
- one fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball
- deterministic simulation
- one no-mercy oracle bot, Edger
- simple local match stats against Edger
- core replay serialization for determinism/debugging

There are no player-facing bot levels, unlock gates, self-play mirror bot, model manifests, or local training pipeline.

## Game Shape

Edger is a deterministic handcrafted oracle bot. It may use exact opponent elixir, hand, and deck queue, acts every tick, returns legal actions only, and has no intentional mistakes or rubber-banding.

Internal benchmark baselines exist only for CLI/tests:

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
npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
```

Run the browser smoke:

```bash
npm run smoke:browser
```

The browser smoke starts the static dev server on an ephemeral localhost port, verifies the Edger-only UI, advances a match, checks profile stat persistence, and shuts the server down.
