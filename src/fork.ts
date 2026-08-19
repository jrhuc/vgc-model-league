import crypto from 'node:crypto';

import type { Battle } from 'pokemon-showdown';

import { BaseEngine } from './battle-agent.js';
import { buildMenus } from './choices.js';
import { defaultPsDir } from './paths.js';
import { canonicalJson } from './serialization.js';
import { loadShowdown } from './showdown.js';
import { routeUpdateLines } from './sim.js';
import type { BattleRequest, Pid } from './types.js';

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
  pending: Pid[];
  requests: Record<Pid, BattleRequest>;
  actual: Partial<Record<Pid, string>>;
  choiceIndex: Partial<Record<Pid, number>>;
  seen: Record<Pid, number>;
  snapshot: string;
}

export function positionDigest(position: Position, pid: Pid): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([position.snapshot, position.pending, position.actual, pid]))
    .digest('hex');
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

export const ACTION_PROTOCOL = {
  version: 3,
  canonicalization: 'showdown-choice-v1',
  concession: 'excluded-stream-command',
  jointOrder: 'active-slot',
  candidateGenerator: 'request-derived-menus-v1',
  acceptanceOracle: 'native-side-choose-on-tojson-fromjson-restart-clone-v1',
  completeness: 'accepted-candidates-only-not-universal-showdown-completeness',
  numberBase: 0,
  numbering: 'dense-after-acceptance-filter',
  sort: 'canonical-action-utf8-byte-ascending-before-acceptance',
  label: 'menu-labels-v1',
} as const;

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

function comparable(lines: string[]): string[] {
  return lines.filter((line) => line && !line.startsWith('|t:|') && !line.startsWith('|timer|'));
}

export interface LegalActionEntry {
  number: number;
  choices: number[];
  command: string;
  label: string;
}

/** Enumerates the modeled request-menu candidate superset; only the native acceptance helpers
 * below may promote these commands into an authoritative action set. */
export function requestActionCandidateEntries(request: BattleRequest): LegalActionEntry[] {
  const menus = buildMenus(request);
  if (!menus.length) return [];
  let combinations: number[][] = [[]];
  for (const menu of menus) {
    combinations = combinations.flatMap((prefix) =>
      menu.flatMap((item, index) => (item.kind === 'forfeit' ? [] : [[...prefix, index]])),
    );
  }
  const actions = new Map<string, LegalActionEntry>();
  for (const choices of combinations) {
    let parts: string[];
    try {
      parts = BaseEngine.parts(menus, choices);
    } catch {
      continue;
    }
    const command = request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
    const labels = choices.map((choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? 'pass');
    const label = request.teamPreview
      ? labels
          .map((entry, slot) => `${['Lead 1', 'Lead 2', 'Back 1', 'Back 2'][slot] ?? `Slot ${slot + 1}`}: ${entry}`)
          .join('; ')
      : labels.length === 1
        ? (labels[0] ?? command)
        : labels.map((entry, slot) => `Slot ${slot + 1}: ${entry}`).join('; ');
    if (!actions.has(command)) actions.set(command, { number: -1, choices, command, label });
  }
  return [...actions.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.command), Buffer.from(b.command)))
    .map((entry, number) => ({ ...entry, number }));
}

type NativeBattleConstructor = {
  fromJSON(serialized: ReturnType<Battle['toJSON']>): Battle;
};

/** Filters the declared request-derived candidates through the authoritative Showdown side-choice
 * oracle. Each candidate gets an independent restarted serialization clone, and accepted candidates
 * are assigned canonical dense zero-based numbers without changing their generator order. */
export function acceptedLegalActionEntries(
  battle: Battle,
  pid: Pid,
  candidates: readonly LegalActionEntry[],
): LegalActionEntry[] {
  const BattleClass = battle.constructor as unknown as NativeBattleConstructor;
  const serialized = battle.toJSON();
  const accepted: LegalActionEntry[] = [];
  for (const candidate of candidates) {
    try {
      const clone = BattleClass.fromJSON(structuredClone(serialized));
      clone.restart(() => {});
      if (clone.getSide(pid).choose(candidate.command) === true) {
        accepted.push({ ...structuredClone(candidate), number: accepted.length });
      }
    } catch {}
  }
  return accepted;
}

export function acceptedLegalActions(battle: Battle, pid: Pid, candidates: readonly LegalActionEntry[]): string[] {
  return acceptedLegalActionEntries(battle, pid, candidates).map((entry) => entry.command);
}

export function acceptedBattleActionEntries(battle: Battle, pid: Pid): LegalActionEntry[] {
  const request = battle.getSide(pid).activeRequest;
  if (!request || request.wait) return [];
  return acceptedLegalActionEntries(battle, pid, requestActionCandidateEntries(request as unknown as BattleRequest));
}

export function acceptedBattleActions(battle: Battle, pid: Pid): string[] {
  return acceptedBattleActionEntries(battle, pid).map((entry) => entry.command);
}

/** Removes exact Showdown wall-clock messages without treating lookalike text as time. Recursive
 * canonical serialization defines new snapshot bytes; older noncanonical snapshots remain restorable. */
export function deterministicBattleSnapshot(battle: Battle): string {
  const serialized = JSON.parse(JSON.stringify(battle.toJSON())) as ReturnType<Battle['toJSON']> & { log?: unknown };
  if (Array.isArray(serialized.log)) {
    serialized.log = serialized.log.map((line: unknown) =>
      typeof line === 'string' && /^\|t:\|\d+$/u.test(line) ? '|t:|' : line,
    );
  }
  return canonicalJson(serialized);
}

export function requestPhase(request: BattleRequest): 'team_preview' | 'forced_switch' | 'turn' {
  if (request.teamPreview) return 'team_preview';
  if (request.forceSwitch) return 'forced_switch';
  return 'turn';
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
  let rejectedChoice = false;
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
    drain();
    positions.push({
      index: positions.length,
      turn: battle.turn,
      pending,
      requests: {
        p1: battle.getSide('p1').activeRequest as unknown as BattleRequest,
        p2: battle.getSide('p2').activeRequest as unknown as BattleRequest,
      },
      actual: taken,
      choiceIndex: Object.fromEntries(pending.map((pid) => [pid, cursor[pid] - 1])),
      seen: { p1: state.pov.p1.length, p2: state.pov.p2.length },
      snapshot: deterministicBattleSnapshot(battle),
    });
    for (const pid of pending) {
      if ((taken[pid] as string).split(', ').includes('forfeit')) {
        battle.lose(pid);
        break;
      }
      if (!battle.choose(pid, taken[pid] as string)) {
        rejectedChoice = true;
        break;
      }
    }
    if (rejectedChoice) break;
  }

  drain();
  const expected = recordedLog === undefined ? undefined : comparable(recordedLog);
  const produced = comparable(state.log);
  const consumedEveryChoice = (['p1', 'p2'] as const).every((pid) => cursor[pid] === source.choices[pid].length);
  const verified =
    expected !== undefined &&
    battle.ended &&
    steps <= CHOICE_LIMIT &&
    !ranOutOfChoices &&
    !rejectedChoice &&
    consumedEveryChoice &&
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

export function playJoint(battle: Battle, choices: Partial<Record<Pid, string>>): boolean {
  for (const pid of pendingSides(battle)) {
    const choice = choices[pid];
    if (!choice || !battle.choose(pid, choice)) return false;
    if (battle.ended) return true;
  }
  return true;
}
