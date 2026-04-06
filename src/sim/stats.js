const TROOP_DEPLOY_TICKS = 20;

function freezeSpawnOffsets(offsets) {
  return Object.freeze(offsets.map((offset) => Object.freeze(offset)));
}

const SINGLE_SPAWN_OFFSETS = freezeSpawnOffsets([{ x: 0, y: 0 }]);

export const MOVE_SPEED_CLASS = Object.freeze({
  SLOW: "Slow",
  MEDIUM: "Medium",
  FAST: "Fast",
  VERY_FAST: "Very Fast",
});

export const MOVE_SPEED_TILES_PER_SECOND = Object.freeze({
  [MOVE_SPEED_CLASS.SLOW]: 1.0,
  [MOVE_SPEED_CLASS.MEDIUM]: 1.2,
  [MOVE_SPEED_CLASS.FAST]: 1.8,
  [MOVE_SPEED_CLASS.VERY_FAST]: 2.4,
});

function withMoveSpeed(spec) {
  const moveSpeed = MOVE_SPEED_TILES_PER_SECOND[spec.move_speed_class];
  return Object.freeze({
    ...spec,
    move_speed: moveSpeed ?? MOVE_SPEED_TILES_PER_SECOND[MOVE_SPEED_CLASS.MEDIUM],
  });
}

function defineTroop(spec) {
  return withMoveSpeed({
    type: "troop",
    spawn_count: 1,
    spawn_offsets: SINGLE_SPAWN_OFFSETS,
    deploy_time_ticks: TROOP_DEPLOY_TICKS,
    body_mass: 1,
    ...spec,
  });
}

function defineSpell(spec) {
  return Object.freeze({
    type: "spell",
    ...spec,
  });
}

export const CARD_STATS = Object.freeze({
  giant: defineTroop({
    id: "giant",
    cost: 5,
    hp: 4090,
    body_mass: 18,
    move_speed_class: MOVE_SPEED_CLASS.SLOW,
    attack_damage: 253,
    attack_range: 1.2,
    sight_range: 7.5,
    hit_speed_seconds: 1.5,
    targeting_mode: "buildings",
  }),
  knight: defineTroop({
    id: "knight",
    cost: 3,
    hp: 1766,
    body_mass: 6,
    move_speed_class: MOVE_SPEED_CLASS.MEDIUM,
    attack_damage: 202,
    attack_range: 1.2,
    sight_range: 5.5,
    hit_speed_seconds: 1.2,
    targeting_mode: "any",
  }),
  archers: defineTroop({
    id: "archers",
    cost: 3,
    hp: 304,
    body_mass: 3,
    spawn_count: 2,
    spawn_offsets: freezeSpawnOffsets([
      { x: -0.35, y: 0 },
      { x: 0.35, y: 0 },
    ]),
    move_speed_class: MOVE_SPEED_CLASS.MEDIUM,
    attack_damage: 112,
    attack_range: 5.0,
    sight_range: 5.5,
    hit_speed_seconds: 0.9,
    targeting_mode: "any",
  }),
  mini_pekka: defineTroop({
    id: "mini_pekka",
    cost: 4,
    hp: 1433,
    body_mass: 4,
    move_speed_class: MOVE_SPEED_CLASS.FAST,
    attack_damage: 755,
    attack_range: 0.8,
    sight_range: 5.5,
    hit_speed_seconds: 1.6,
    targeting_mode: "any",
  }),
  musketeer: defineTroop({
    id: "musketeer",
    cost: 4,
    hp: 721,
    body_mass: 5,
    move_speed_class: MOVE_SPEED_CLASS.MEDIUM,
    attack_damage: 217,
    attack_range: 6.0,
    sight_range: 6.0,
    hit_speed_seconds: 1.0,
    targeting_mode: "any",
  }),
  goblins: defineTroop({
    id: "goblins",
    cost: 2,
    hp: 202,
    body_mass: 2,
    spawn_count: 4,
    spawn_offsets: freezeSpawnOffsets([
      { x: -0.4, y: -0.2 },
      { x: 0.4, y: -0.2 },
      { x: -0.22, y: 0.25 },
      { x: 0.22, y: 0.25 },
    ]),
    move_speed_class: MOVE_SPEED_CLASS.VERY_FAST,
    attack_damage: 120,
    attack_range: 0.5,
    sight_range: 5.5,
    hit_speed_seconds: 1.1,
    targeting_mode: "any",
  }),
  arrows: defineSpell({
    id: "arrows",
    cost: 3,
    troop_damage: 366,
    tower_damage: 93,
    radius_tiles: 3.5,
    cast_delay_ticks: 16,
  }),
  fireball: defineSpell({
    id: "fireball",
    cost: 4,
    troop_damage: 688,
    tower_damage: 207,
    radius_tiles: 2.5,
    cast_delay_ticks: 6,
    travel_speed_tiles_per_second: 10,
    knockback_distance_tiles: 0.75,
    knockback_duration_ticks: 5,
    knockback_immune_card_ids: Object.freeze(["giant"]),
  }),
});

export const TOWER_STATS = Object.freeze({
  crown: Object.freeze({
    hp: 3052,
    move_speed: 0,
    attack_damage: 109,
    attack_range: 7.5,
    hit_speed_seconds: 0.8,
    targeting_mode: "troops",
  }),
  king: Object.freeze({
    hp: 4824,
    move_speed: 0,
    attack_damage: 109,
    attack_range: 7.0,
    hit_speed_seconds: 1.0,
    targeting_mode: "troops",
  }),
});

export function getCardStats(cardId) {
  return CARD_STATS[cardId] ?? null;
}

export function getTroopStats(cardId) {
  const card = getCardStats(cardId);
  if (card?.type === "troop") {
    return card;
  }
  return CARD_STATS.knight;
}

export function getSpellStats(cardId) {
  const card = getCardStats(cardId);
  if (card?.type === "spell") {
    return card;
  }
  return null;
}

export function getTowerStats(towerRole = "crown") {
  return TOWER_STATS[towerRole] ?? TOWER_STATS.crown;
}
