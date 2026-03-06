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

Learn how to implement UI here: https://github.com/Noisyboy-9/clash_royale_game

## Detailed planning docs

- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Game rules spec: `docs/GAME_RULES.md`
- Card balance spec: `docs/CARD_SPECS.md`
- Bot tiers spec: `docs/BOT_LEVELS.md`
- Sprint/task backlog: `docs/SPRINT_BACKLOG.md`

## Run prototype

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Controls:
- Click a card slot, then click the arena to play that card (troops on your side only)
- `Space` pause/resume
- `R` reset
- `F` fullscreen toggle

Ladder + training:
- Select bot difficulty from the `Bot Level` dropdown (locked levels show as disabled).
- Beat a tier to unlock the next (`Noob` -> `Mid-ladder Menace` -> `Top Ladder`).
- Click `Train Self Bot` to fit a local imitation model from logged player actions.
- Self-play unlock rule is enforced from profile data (`100` matches and `3` wins vs Top).

Automation hooks exposed in browser:
- `window.render_game_to_text()`
- `window.advanceTime(ms)`
