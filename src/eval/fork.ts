import type { Battle } from 'pokemon-showdown';

import { buildMenus } from '../choices.js';
import { defaultPsDir } from '../paths.js';
import { loadShowdown } from '../showdown.js';
import { routeUpdateLines } from '../sim.js';
import type { BattleRequest, Pid } from '../types.js';

export interface GameSource {
  format: string;
  seed: [number, number, number, number];
  names: Record<Pid, string>;
  packed: Record<Pid, string>;
  choices: Record<Pid, string[]>;
  psDir?: string;
}

export interface Position {
  /** Ordinal among the game's joint decisions, where both sides answered the same request. */
  index: number;
  turn: number;
  requests: Record<Pid, BattleRequest>;
  actual: Record<Pid, string>;
  snapshot: string;
}

export interface Replay {
  /** True only when the replay reproduced the recorded log line for line. Every downstream number
   * rests on this: an unverified replay is a different battle wearing the same identifiers. */
  verified: boolean;
  positions: Position[];
  log: string[];
  turns: number;
  winner: string | null;
  ranOutOfChoices: boolean;
}

const CHOICE_LIMIT = 500;

/** Collapses `|split|` triples the way the simulator's own router does, so a replayed log is
 * compared against the recorded one under the definition that wrote it. */
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

function comparable(lines: string[]): string[] {
  return lines.filter((line) => line && !line.startsWith('|t:|') && !line.startsWith('|timer|'));
}

/** The forfeit entry is dropped: it is always available, always loses, and never competes for the
 * best action, so carrying it through a regret matrix only multiplies simulations. Two slots cannot
 * claim the same benched Pokémon, which the per-slot menus have no way to express. */
export function legalActions(request: BattleRequest): string[] {
  const menus = buildMenus(request);
  if (!menus.length) return [];
  let combinations: Array<{ parts: string[]; claimed: Set<string> }> = [{ parts: [], claimed: new Set() }];
  for (const menu of menus) {
    combinations = combinations.flatMap((prefix) =>
      menu.flatMap((item) => {
        const exclusive = item.kind === 'switch' || item.kind === 'team';
        if (item.kind === 'forfeit' || (exclusive && prefix.claimed.has(item.part))) return [];
        const claimed = exclusive ? new Set(prefix.claimed).add(item.part) : prefix.claimed;
        return [{ parts: [...prefix.parts, item.part], claimed }];
      }),
    );
  }
  const join = (parts: string[]) => (request.teamPreview ? `team ${parts.join('')}` : parts.join(', '));
  return [...new Set(combinations.map((combination) => join(combination.parts)))];
}

export function newBattle(source: GameSource): Battle {
  const { Battle: BattleClass } = loadShowdown(source.psDir ?? defaultPsDir());
  /** Runs record the seed as the four-word array the simulator was started with; joining it is the
   * same conversion the PRNG performs on an array, and the string form is the one the types admit. */
  const battle = new BattleClass({ formatid: source.format, seed: source.seed.join(',') as `${number},${string}` });
  for (const pid of ['p1', 'p2'] as const) {
    battle.setPlayer(pid, { name: source.names[pid], team: source.packed[pid] });
  }
  return battle;
}

export function pendingSides(battle: Battle): Pid[] {
  return (['p1', 'p2'] as const).filter((pid) => {
    const request = battle.getSide(pid).activeRequest;
    return Boolean(request) && !request?.wait;
  });
}

export function replayGame(source: GameSource, recordedLog?: string[]): Replay {
  const battle = newBattle(source);
  const cursor: Record<Pid, number> = { p1: 0, p2: 0 };
  const positions: Position[] = [];
  let ranOutOfChoices = false;
  let steps = 0;

  while (!battle.ended && steps++ < CHOICE_LIMIT) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const taken: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const choice = source.choices[pid][cursor[pid]];
      if (choice === undefined) {
        ranOutOfChoices = true;
        break;
      }
      cursor[pid] += 1;
      taken[pid] = choice;
    }
    if (ranOutOfChoices) break;
    if (pending.length === 2) {
      positions.push({
        index: positions.length,
        turn: battle.turn,
        requests: {
          p1: battle.getSide('p1').activeRequest as unknown as BattleRequest,
          p2: battle.getSide('p2').activeRequest as unknown as BattleRequest,
        },
        actual: { p1: taken.p1 as string, p2: taken.p2 as string },
        snapshot: JSON.stringify(battle.toJSON()),
      });
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }

  const log = omniscientLog(battle.log);
  const expected = recordedLog === undefined ? undefined : comparable(recordedLog);
  const produced = comparable(log);
  const verified =
    expected !== undefined &&
    !ranOutOfChoices &&
    produced.length === expected.length &&
    produced.every((line, index) => line === expected[index]);

  return { verified, positions, log, turns: battle.turn, winner: battle.winner || null, ranOutOfChoices };
}

/** The restored battle needs its own sink: a deserialized battle has no `send`, and the simulator
 * reports a rejected choice through it rather than by returning. */
export function openPosition(position: Position, psDir = defaultPsDir()): Battle {
  const { Battle: BattleClass } = loadShowdown(psDir);
  const battle = BattleClass.fromJSON(position.snapshot);
  battle.restart(() => {});
  return battle;
}

export function playJoint(battle: Battle, choices: Record<Pid, string>): boolean {
  for (const pid of ['p1', 'p2'] as const) {
    if (!battle.choose(pid, choices[pid])) return false;
  }
  return true;
}
