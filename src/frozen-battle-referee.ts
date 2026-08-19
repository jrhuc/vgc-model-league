import type { Battle } from 'pokemon-showdown';
import { acceptedBattleActionEntries, type LegalActionEntry, pendingSides } from './fork.js';
import { canonicalJsonDigest } from './serialization.js';
import { loadShowdown } from './showdown.js';
import { finishUpdateRouting, routeUpdateLines } from './sim.js';
import type { BattleRequest, Pid } from './types.js';

export const FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION = 1 as const;

export interface FrozenBattleSeat {
  pid: Pid;
  name: string;
  packedTeam: string;
}

export interface FrozenBattleRefereeOptions {
  format: string;
  seed: readonly [number, number, number, number];
  seats: readonly FrozenBattleSeat[];
}

export interface FrozenBattleMechanics {
  Battle: typeof Battle;
}

export interface FrozenBattleObservation {
  protocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  pid: Pid;
  seat: { pid: Pid; name: string };
  revision: number;
  stateHash: string;
  request: BattleRequest | null;
  povLines: string[];
  terminal: boolean;
}

export interface FrozenLegalActions {
  revision: number;
  stateHash: string;
  candidateScope: 'showdown-accepted-request-derived';
  candidateGenerator: 'request-derived-menus-v1';
  acceptanceOracle: 'native-side-choose-on-tojson-fromjson-restart-clone-v1';
  exhaustive: false;
  actions: LegalActionEntry[];
}

export interface FrozenSubmissionResult {
  advanced: boolean;
  revision: number;
  stateHash: string;
  terminal: boolean;
}

export interface FrozenSubmittedAction {
  decisionRevision: number;
  stateHash: string;
  pid: Pid;
  command: string;
}

export type FrozenBattleResult = { type: 'win'; winner: { pid: Pid; name: string } } | { type: 'tie'; winner: null };

export interface FrozenBattleTerminalEvidence {
  protocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  format: string;
  seed: [number, number, number, number];
  seats: Array<{ pid: Pid; name: string }>;
  result: FrozenBattleResult;
  turns: number;
  authoritativeLog: string[];
  submittedActions: FrozenSubmittedAction[];
}

interface RouteState {
  pov: Record<Pid, string[]>;
  log: string[];
  publicLog: string[];
  pendingSplit: string[];
  winner: string | null;
  turns: number;
}

export type FrozenBattleRefereeErrorCode =
  | 'unknown-seat'
  | 'stale-revision'
  | 'stale-state'
  | 'duplicate-submission'
  | 'not-requested'
  | 'illegal-action';

export class FrozenBattleRefereeError extends Error {
  constructor(
    readonly code: FrozenBattleRefereeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrozenBattleRefereeError';
  }
}

interface WinnerTracker {
  pid: Pid | null;
}

function emptyRouteState(): RouteState {
  return {
    pov: { p1: [], p2: [] },
    log: [],
    publicLog: [],
    pendingSplit: [],
    winner: null,
    turns: 0,
  };
}

function exactPid(value: unknown): Pid | null {
  return value === 'p1' || value === 'p2' ? value : null;
}

function copiedOptions(options: FrozenBattleRefereeOptions): {
  format: string;
  seed: [number, number, number, number];
  seats: FrozenBattleSeat[];
} {
  if (!options.format) throw new Error('format must be explicit');
  if (options.seed.length !== 4 || options.seed.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    throw new Error('seed must contain four unsigned 16-bit integers');
  }
  const seats = options.seats.map((seat) => ({ ...seat }));
  if (seats.length !== 2 || new Set(seats.map((seat) => seat.pid)).size !== 2) {
    throw new Error('seats must contain exactly one p1 and one p2');
  }
  for (const seat of seats) {
    if (!exactPid(seat.pid)) throw new Error(`unknown seat ${String(seat.pid)}`);
    if (!seat.name) throw new Error(`${seat.pid} name must be explicit`);
    if (!seat.packedTeam) throw new Error(`${seat.pid} packed team must be explicit`);
  }
  return {
    format: options.format,
    seed: [...options.seed],
    seats,
  };
}

function withoutWallClockLines(serialized: unknown): unknown {
  const canonical = structuredClone(serialized) as { log?: unknown };
  if (Array.isArray(canonical.log)) {
    canonical.log = canonical.log.filter((line) => typeof line !== 'string' || !line.startsWith('|t:|'));
  }
  return canonical;
}

function stateHashOf(battle: Battle): string {
  const serialized = JSON.parse(JSON.stringify(withoutWallClockLines(battle.toJSON()))) as unknown;
  return canonicalJsonDigest(serialized);
}

function installWinnerTracker(battle: Battle, winnerPid: Pid | null): WinnerTracker {
  const tracker: WinnerTracker = { pid: winnerPid };
  const originalWin = battle.win.bind(battle);
  battle.win = ((side?: Parameters<Battle['win']>[0]) => {
    if (!battle.ended) {
      tracker.pid = exactPid(typeof side === 'string' ? side : side?.id);
    }
    return originalWin(side);
  }) as Battle['win'];
  return tracker;
}

function cloneRequest(request: Battle['p1']['activeRequest']): BattleRequest | null {
  return request ? (structuredClone(request) as unknown as BattleRequest) : null;
}

export class FrozenBattleReferee {
  readonly format: string;
  readonly seed: readonly [number, number, number, number];
  readonly seats: readonly FrozenBattleSeat[];

  private battle: Battle;
  private readonly mechanics: FrozenBattleMechanics;
  private readonly seatByPid: Record<Pid, FrozenBattleSeat>;
  private routeState = emptyRouteState();
  private battleLogCursor = 0;
  private readonly povCursors: Record<Pid, number> = { p1: 0, p2: 0 };
  private revision = 0;
  private stagedActions: Partial<Record<Pid, string>> = {};
  private submittedActions: FrozenSubmittedAction[] = [];
  private winnerTracker: WinnerTracker;

  constructor(options: FrozenBattleRefereeOptions, mechanics: FrozenBattleMechanics = loadShowdown()) {
    const copied = copiedOptions(options);
    this.format = copied.format;
    this.seed = copied.seed;
    this.seats = copied.seats;
    this.mechanics = mechanics;
    this.seatByPid = {
      p1: copied.seats.find((seat) => seat.pid === 'p1')!,
      p2: copied.seats.find((seat) => seat.pid === 'p2')!,
    };
    this.battle = new mechanics.Battle({
      formatid: this.format,
      seed: this.seed.join(',') as `${number},${string}`,
    });
    for (const pid of ['p1', 'p2'] as const) {
      const seat = this.seatByPid[pid];
      this.battle.setPlayer(pid, { name: seat.name, team: seat.packedTeam });
    }
    this.winnerTracker = installWinnerTracker(this.battle, null);
    this.drainBattleLog();
  }

  observe(pid: Pid): FrozenBattleObservation {
    const seat = this.requireSeat(pid);
    this.drainBattleLog();
    const cursor = this.povCursors[pid];
    const povLines = this.routeState.pov[pid].slice(cursor);
    this.povCursors[pid] = this.routeState.pov[pid].length;
    return {
      protocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      pid,
      seat: { pid, name: seat.name },
      revision: this.revision,
      stateHash: stateHashOf(this.battle),
      request: cloneRequest(this.battle.getSide(pid).activeRequest),
      povLines,
      terminal: this.battle.ended,
    };
  }

  legalActions(pid: Pid): FrozenLegalActions {
    this.requireSeat(pid);
    const actions = acceptedBattleActionEntries(this.battle, pid);
    return {
      revision: this.revision,
      stateHash: stateHashOf(this.battle),
      candidateScope: 'showdown-accepted-request-derived',
      candidateGenerator: 'request-derived-menus-v1',
      acceptanceOracle: 'native-side-choose-on-tojson-fromjson-restart-clone-v1',
      exhaustive: false,
      actions,
    };
  }

  submit(pid: Pid, command: string, expectedRevision: number, expectedStateHash: string): FrozenSubmissionResult {
    this.requireSeat(pid);
    const currentHash = stateHashOf(this.battle);
    if (expectedRevision !== this.revision) {
      throw new FrozenBattleRefereeError(
        'stale-revision',
        `expected revision ${expectedRevision}, current revision is ${this.revision}`,
      );
    }
    if (expectedStateHash !== currentHash) {
      throw new FrozenBattleRefereeError('stale-state', 'expected state hash does not match the current state');
    }
    if (this.stagedActions[pid] !== undefined) {
      throw new FrozenBattleRefereeError('duplicate-submission', `${pid} already submitted at this revision`);
    }
    const pending = pendingSides(this.battle);
    if (!pending.includes(pid)) {
      throw new FrozenBattleRefereeError('not-requested', `${pid} does not have an active decision`);
    }
    const validation = this.cloneBattle().battle;
    if (!validation.choose(pid, command)) {
      throw new FrozenBattleRefereeError('illegal-action', `${pid} command was rejected by Pokémon Showdown`);
    }

    const staged = { ...this.stagedActions, [pid]: command };
    if (!pending.every((pendingPid) => staged[pendingPid] !== undefined)) {
      this.stagedActions = staged;
      return {
        advanced: false,
        revision: this.revision,
        stateHash: currentHash,
        terminal: this.battle.ended,
      };
    }

    const next = this.cloneBattle();
    for (const pendingPid of pending) {
      if (!next.battle.choose(pendingPid, staged[pendingPid]!)) {
        throw new Error(`validated ${pendingPid} command was rejected during atomic advancement`);
      }
    }
    const decisionRevision = this.revision;
    const committed = pending.map(
      (pendingPid): FrozenSubmittedAction => ({
        decisionRevision,
        stateHash: currentHash,
        pid: pendingPid,
        command: staged[pendingPid]!,
      }),
    );
    this.battle = next.battle;
    this.winnerTracker = next.winnerTracker;
    this.submittedActions.push(...committed);
    this.stagedActions = {};
    this.revision += 1;
    this.drainBattleLog();
    return {
      advanced: true,
      revision: this.revision,
      stateHash: stateHashOf(this.battle),
      terminal: this.battle.ended,
    };
  }

  currentState(): { revision: number; stateHash: string } {
    return { revision: this.revision, stateHash: stateHashOf(this.battle) };
  }

  terminalEvidence(): FrozenBattleTerminalEvidence | null {
    this.drainBattleLog();
    if (!this.battle.ended) return null;
    finishUpdateRouting(this.routeState);
    const winnerName = this.battle.winner || null;
    let result: FrozenBattleResult;
    if (winnerName) {
      const winnerPid = this.winnerTracker.pid;
      if (!winnerPid) throw new Error('Showdown ended with a winner but no exact winning seat');
      result = { type: 'win', winner: { pid: winnerPid, name: this.seatByPid[winnerPid].name } };
    } else {
      result = { type: 'tie', winner: null };
    }
    return {
      protocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      format: this.format,
      seed: [...this.seed],
      seats: (['p1', 'p2'] as const).map((pid) => ({ pid, name: this.seatByPid[pid].name })),
      result,
      turns: this.battle.turn,
      authoritativeLog: [...this.routeState.log],
      submittedActions: structuredClone(this.submittedActions),
    };
  }

  private requireSeat(pid: Pid): FrozenBattleSeat {
    const exact = exactPid(pid);
    if (!exact) throw new FrozenBattleRefereeError('unknown-seat', `unknown seat ${String(pid)}`);
    return this.seatByPid[exact];
  }

  private drainBattleLog(): void {
    const fresh = this.battle.log.slice(this.battleLogCursor).filter((line) => !line.startsWith('|t:|'));
    this.battleLogCursor = this.battle.log.length;
    if (fresh.length) routeUpdateLines(fresh, this.routeState);
  }

  private cloneBattle(): { battle: Battle; winnerTracker: WinnerTracker } {
    const battle = this.mechanics.Battle.fromJSON(this.battle.toJSON());
    battle.restart(() => {});
    return { battle, winnerTracker: installWinnerTracker(battle, this.winnerTracker.pid) };
  }
}
