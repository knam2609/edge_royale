const TROOP_DEPLOY_TICKS = 20;

export const DEFAULT_DECK = Object.freeze([
  "giant",
  "knight",
  "archers",
  "mini_pekka",
  "musketeer",
  "goblins",
  "arrows",
  "fireball",
]);

export const CARD_LIBRARY = Object.freeze({
  giant: Object.freeze({
    id: "giant",
    type: "troop",
    cost: 5,
    hp: 2500,
    spawn_count: 1,
    spread: 0,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  knight: Object.freeze({
    id: "knight",
    type: "troop",
    cost: 3,
    hp: 1400,
    spawn_count: 1,
    spread: 0,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  archers: Object.freeze({
    id: "archers",
    type: "troop",
    cost: 3,
    hp: 300,
    spawn_count: 2,
    spread: 0.4,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  mini_pekka: Object.freeze({
    id: "mini_pekka",
    type: "troop",
    cost: 4,
    hp: 1200,
    spawn_count: 1,
    spread: 0,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  musketeer: Object.freeze({
    id: "musketeer",
    type: "troop",
    cost: 4,
    hp: 700,
    spawn_count: 1,
    spread: 0,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  goblins: Object.freeze({
    id: "goblins",
    type: "troop",
    cost: 2,
    hp: 220,
    spawn_count: 3,
    spread: 0.35,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  arrows: Object.freeze({ id: "arrows", type: "spell", cost: 3 }),
  fireball: Object.freeze({ id: "fireball", type: "spell", cost: 4 }),
});

export function getCard(cardId) {
  return CARD_LIBRARY[cardId] ?? null;
}
