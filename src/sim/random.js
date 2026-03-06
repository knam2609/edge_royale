export function createRng(seed) {
  let state = (seed >>> 0) || 1;

  return function next() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
