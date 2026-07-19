import { randomBytes } from 'node:crypto';

export type Rng = () => number;

export function resolveSeed(seed: number | undefined): number {
  return seed ?? randomBytes(6).readUIntBE(0, 6);
}

export function seriesEntropy(random: Rng) {
  return {
    gameSeeds: Array.from(
      { length: 3 },
      () => Array.from({ length: 4 }, () => 1 + Math.floor(random() * 0xffff)) as [number, number, number, number],
    ),
    engineSeeds: {
      p1: Math.floor(random() * Number.MAX_SAFE_INTEGER),
      p2: Math.floor(random() * Number.MAX_SAFE_INTEGER),
    },
  };
}

export function shuffle<T>(items: readonly T[], random: Rng): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

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
