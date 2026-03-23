const TROOP_DEPLOY_TICKS = 20;

function freezeSpawnOffsets(offsets) {
  return Object.freeze(offsets.map((offset) => Object.freeze(offset)));
}

const SINGLE_SPAWN_OFFSETS = freezeSpawnOffsets([{ x: 0, y: 0 }]);

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
    spawn_offsets: SINGLE_SPAWN_OFFSETS,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  knight: Object.freeze({
    id: "knight",
    type: "troop",
    cost: 3,
    hp: 1400,
    spawn_count: 1,
    spawn_offsets: SINGLE_SPAWN_OFFSETS,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  archers: Object.freeze({
    id: "archers",
    type: "troop",
    cost: 3,
    hp: 300,
    spawn_count: 2,
    spawn_offsets: freezeSpawnOffsets([
      { x: -0.35, y: 0 },
      { x: 0.35, y: 0 },
    ]),
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  mini_pekka: Object.freeze({
    id: "mini_pekka",
    type: "troop",
    cost: 4,
    hp: 1200,
    spawn_count: 1,
    spawn_offsets: SINGLE_SPAWN_OFFSETS,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  musketeer: Object.freeze({
    id: "musketeer",
    type: "troop",
    cost: 4,
    hp: 700,
    spawn_count: 1,
    spawn_offsets: SINGLE_SPAWN_OFFSETS,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  goblins: Object.freeze({
    id: "goblins",
    type: "troop",
    cost: 2,
    hp: 220,
    spawn_count: 4,
    spawn_offsets: freezeSpawnOffsets([
      { x: -0.4, y: -0.2 },
      { x: 0.4, y: -0.2 },
      { x: -0.22, y: 0.25 },
      { x: 0.22, y: 0.25 },
    ]),
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
  }),
  arrows: Object.freeze({ id: "arrows", type: "spell", cost: 3 }),
  fireball: Object.freeze({ id: "fireball", type: "spell", cost: 4 }),
});

export function getCard(cardId) {
  return CARD_LIBRARY[cardId] ?? null;
}
