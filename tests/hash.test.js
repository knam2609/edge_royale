import test from "node:test";
import assert from "node:assert/strict";

import { hashState, stableStringify } from "../src/sim/hash.js";

function legacyHash(value) {
  const content = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

test("hashState streams the same canonical content as stableStringify", () => {
  const value = {
    z: [3, { c: true, a: null }, "lane"],
    a: {
      beta: 2.5,
      alpha: ["knight", "fireball"],
    },
    n: -1,
  };

  assert.equal(hashState(value), legacyHash(value));
});
