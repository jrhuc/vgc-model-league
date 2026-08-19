import { requestActionCandidateEntries } from '../../src/fork.js';
import { routeUpdateLines } from '../../src/sim.js';
import type { BattleRequest } from '../../src/types.js';

export function omniscientLog(lines: string[]): string[] {
  const state = {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null as string | null,
    turns: 0,
  };
  routeUpdateLines(
    lines.filter((line) => line),
    state,
  );
  return state.log;
}

export function requestActionCandidates(request: BattleRequest): string[] {
  return requestActionCandidateEntries(request).map((entry) => entry.command);
}
