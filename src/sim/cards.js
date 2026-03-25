import { CARD_STATS } from "./stats.js";

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

export const CARD_LIBRARY = CARD_STATS;

export function getCard(cardId) {
  return CARD_LIBRARY[cardId] ?? null;
}
