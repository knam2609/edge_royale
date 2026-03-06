Original prompt: PLEASE IMPLEMENT THIS PLAN (3x overtime elixir + Fireball knockback exception), then continue.

- Initialized headless simulation, replay, AI, and tests for overtime + knockback rules.
- Current step: scaffold browser client with deterministic hooks (`window.render_game_to_text`, `window.advanceTime`).
- TODO: wire canvas UI to sim tick loop and click-to-cast fireball interaction.
- TODO: run browser automation loop and inspect screenshot/state output.

- Added browser client (`index.html`, `src/client/webGame.js`) with canvas rendering, player click Fireball, bot Fireball, overtime transition, and deterministic hooks.
- Added local static dev server (`scripts/dev-server.mjs`) and `npm run dev` script.
- Updated engine to enforce Fireball elixir spend by actor.
- Installed Playwright tooling and browsers for validation.
- Ran Playwright loop against local server; fixed browser import issue by removing Node-only crypto dependency from shared sim hash utility.
- Re-ran Playwright with click actions: screenshots and state snapshots confirm gameplay loop, elixir spend, troop knockback (Giant immunity), and no console errors.
