export type Rng = () => number;

export function seededRng(seed: number | string): Rng {
  let state = 0x811c9dc5;
  for (const character of String(seed)) {
    state ^= character.codePointAt(0)!;
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}
