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
  index: number;
  turn: number;
  requests: Record<Pid, BattleRequest>;
  actual: Record<Pid, string>;
  choiceIndex: Record<Pid, number>;
  seen: Record<Pid, number>;
  snapshot: string;
}

export interface Replay {
  verified: boolean;
  positions: Position[];
  log: string[];
  pov: Record<Pid, string[]>;
  turns: number;
  winner: string | null;
  ranOutOfChoices: boolean;
}

const CHOICE_LIMIT = 500;

function routeState() {
  return {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null as string | null,
    turns: 0,
  };
}

export function omniscientLog(lines: string[]): string[] {
  const state = routeState();
  routeUpdateLines(
    lines.filter((line) => line),
    state,
  );
  return state.log;
}

function comparable(lines: string[]): string[] {
  return lines.filter((line) => line && !line.startsWith('|t:|') && !line.startsWith('|timer|'));
}

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
  const state = routeState();
  let consumed = 0;
  let ranOutOfChoices = false;
  let steps = 0;

  const drain = () => {
    const fresh = battle.log.slice(consumed).filter((line) => line);
    consumed = battle.log.length;
    if (fresh.length) routeUpdateLines(fresh, state);
  };

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
      drain();
      positions.push({
        index: positions.length,
        turn: battle.turn,
        requests: {
          p1: battle.getSide('p1').activeRequest as unknown as BattleRequest,
          p2: battle.getSide('p2').activeRequest as unknown as BattleRequest,
        },
        actual: { p1: taken.p1 as string, p2: taken.p2 as string },
        choiceIndex: { p1: cursor.p1 - 1, p2: cursor.p2 - 1 },
        seen: { p1: state.pov.p1.length, p2: state.pov.p2.length },
        snapshot: JSON.stringify(battle.toJSON()),
      });
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }

  drain();
  const expected = recordedLog === undefined ? undefined : comparable(recordedLog);
  const produced = comparable(state.log);
  const verified =
    expected !== undefined &&
    !ranOutOfChoices &&
    produced.length === expected.length &&
    produced.every((line, index) => line === expected[index]);

  return {
    verified,
    positions,
    log: state.log,
    pov: state.pov,
    turns: battle.turn,
    winner: battle.winner || null,
    ranOutOfChoices,
  };
}

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
