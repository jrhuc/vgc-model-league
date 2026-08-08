import { createHash } from 'node:crypto';

import { canonicalJsonDigest } from './eval/serialization.js';
import {
  FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
  type FrozenBattleObservation,
  FrozenBattleReferee,
  type FrozenBattleSnapshot,
  type FrozenBattleTerminalEvidence,
  type FrozenLegalActions,
} from './frozen-battle-referee.js';
import { loadShowdown, showdownCommit } from './showdown.js';
import { type TeamBuildSubmissionValidation, validateTeamBuildSubmission } from './teambuild.js';
import type { Pid } from './types.js';

export const FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION = 1 as const;
export const FROZEN_MATCHDAY_FORMAT = 'gen9championsvgc2026regmbbo3' as const;
export const FROZEN_MATCHDAY_NOTEBOOK_LIMIT = 20_000;

export type FrozenMatchdayPhase = 'playing' | 'between-games' | 'terminal';

type AcceptedConstruction = Extract<TeamBuildSubmissionValidation, { status: 'accepted' }>;
type Seed = readonly [number, number, number, number];

export interface FrozenMatchdaySeat {
  pid: Pid;
  name: string;
  construction: TeamBuildSubmissionValidation;
}

export interface FrozenMatchdayRefereeOptions {
  format: string;
  gameSeeds: readonly [Seed, Seed, Seed];
  seats: readonly FrozenMatchdaySeat[];
}

export interface FrozenMatchdayScore {
  p1: number;
  p2: number;
  ties: number;
}

export interface FrozenMatchdayObservation {
  protocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  battleProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  pid: Pid;
  phase: FrozenMatchdayPhase;
  gameNumber: number;
  score: FrozenMatchdayScore;
  revision: number;
  stateHash: string;
  battle: FrozenBattleObservation | null;
  terminal: boolean;
}

export type FrozenMatchdayLegalActions = Omit<FrozenLegalActions, 'revision' | 'stateHash'> & {
  protocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  gameNumber: number;
  revision: number;
  stateHash: string;
  battleRevision: number;
  battleStateHash: string;
};

export interface FrozenMatchdaySubmissionResult {
  advanced: boolean;
  phase: FrozenMatchdayPhase;
  gameNumber: number;
  score: FrozenMatchdayScore;
  revision: number;
  stateHash: string;
  terminal: boolean;
}

export interface FrozenBetweenGameInput {
  notebookReplacement?: string;
}

export interface FrozenBetweenGameReceipt {
  gameNumber: number;
  supplied: boolean;
  notebookSha256: string;
}

interface FrozenBetweenGamePrivateRecord extends FrozenBetweenGameReceipt {
  notebook: string;
}

export interface FrozenMatchdayPrivateEvidence {
  pid: Pid;
  currentNotebook: string;
  intervals: FrozenBetweenGamePrivateRecord[];
}

export type FrozenMatchdayResult = { type: 'win'; winner: { pid: Pid; name: string } } | { type: 'tie'; winner: null };

interface FrozenMatchdayRegistration {
  pid: Pid;
  name: string;
  packedTeam: string;
  teamSha256: string;
  constructionSha256: string;
  initialNotebook: string;
}

export interface FrozenMatchdayTerminalEvidence {
  protocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  battleProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  showdownRevision: string;
  format: string;
  configDigest: string;
  registrations: Array<{
    pid: Pid;
    name: string;
    teamSha256: string;
    constructionSha256: string;
  }>;
  gameSeeds: Array<[number, number, number, number]>;
  score: FrozenMatchdayScore;
  result: FrozenMatchdayResult;
  games: FrozenBattleTerminalEvidence[];
  notebookReceipts: Array<{ pid: Pid; intervals: FrozenBetweenGameReceipt[] }>;
}

interface FrozenReadyState {
  supplied: boolean;
  notebook: string;
  notebookSha256: string;
}

interface FrozenMatchdaySnapshotBody {
  protocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  options: FrozenMatchdayRefereeOptions;
  configDigest: string;
  revision: number;
  phase: FrozenMatchdayPhase;
  score: FrozenMatchdayScore;
  completedGames: FrozenBattleTerminalEvidence[];
  activeBattle: FrozenBattleSnapshot | null;
  ready: Partial<Record<Pid, FrozenReadyState>>;
  notebooks: Record<Pid, string>;
  privateEvidence: Record<Pid, FrozenBetweenGamePrivateRecord[]>;
  stateHash: string;
}

export interface FrozenMatchdaySnapshot extends FrozenMatchdaySnapshotBody {
  sha256: string;
}

export type FrozenMatchdayRefereeErrorCode =
  | 'invalid-construction'
  | 'unknown-seat'
  | 'wrong-phase'
  | 'stale-revision'
  | 'stale-state'
  | 'duplicate-submission'
  | 'snapshot-protocol';

export class FrozenMatchdayRefereeError extends Error {
  constructor(
    readonly code: FrozenMatchdayRefereeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrozenMatchdayRefereeError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactPid(value: unknown): Pid | null {
  return value === 'p1' || value === 'p2' ? value : null;
}

function copyScore(score: FrozenMatchdayScore): FrozenMatchdayScore {
  return { p1: score.p1, p2: score.p2, ties: score.ties };
}

function copySeed(seed: Seed): [number, number, number, number] {
  if (seed.length !== 4 || seed.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      'each game seed must contain four unsigned 16-bit integers',
    );
  }
  return [...seed];
}

function asAccepted(value: TeamBuildSubmissionValidation, pid: Pid): AcceptedConstruction {
  if (value.status !== 'accepted') {
    throw new FrozenMatchdayRefereeError('invalid-construction', `${pid} construction was not accepted`);
  }
  return value;
}

function assertConstruction(seat: FrozenMatchdaySeat, format: string, revision: string): FrozenMatchdayRegistration {
  const construction = asAccepted(seat.construction, seat.pid);
  const artifact = construction.artifact;
  const action = artifact.action;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.status !== 'valid' ||
    artifact.executionPolicy !== 'strict' ||
    artifact.task.executionPolicy !== 'strict' ||
    artifact.task.sheetPolicy !== 'open' ||
    artifact.task.format !== format ||
    artifact.showdownCommit !== revision ||
    !action ||
    artifact.fallback ||
    !artifact.validation.showdown ||
    artifact.validation.repaired ||
    artifact.validation.repairs.length > 0 ||
    artifact.validation.problems.length > 0 ||
    typeof artifact.evidence.notebook !== 'string' ||
    artifact.evidence.notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT ||
    artifact.task.constraint.teamSize !== 6 ||
    action.selected.length !== 6 ||
    action.sets.length !== 6 ||
    construction.packed !== action.packed
  ) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      `${seat.pid} construction artifact is not strict and valid`,
    );
  }
  const submitted = {
    sets: action.sets.map((set, index) => ({
      id: action.selected[index],
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs: set.evs,
      note: set.note,
    })),
    ...(artifact.evidence.supplied.rationale ? { team_plan: artifact.evidence.rationale } : {}),
    ...(artifact.evidence.supplied.notebookUpdate ? { notebook: artifact.evidence.notebook } : {}),
  };
  const replayed = validateTeamBuildSubmission(artifact.task, JSON.stringify(submitted), {
    attempts: artifact.attempts,
    createdAt: artifact.createdAt,
  });
  if (
    replayed.status !== 'accepted' ||
    replayed.packed !== construction.packed ||
    canonicalJsonDigest(replayed.artifact) !== canonicalJsonDigest(artifact)
  ) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      `${seat.pid} construction does not reproduce through the strict referee`,
    );
  }
  const sets = loadShowdown().Teams.unpack(construction.packed);
  if (sets?.length !== 6) {
    throw new FrozenMatchdayRefereeError('invalid-construction', `${seat.pid} must register exactly six Pokémon`);
  }
  if (sets.some((set) => Boolean(set.teraType))) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      `${seat.pid} construction contains unsupported Tera metadata`,
    );
  }
  return {
    pid: seat.pid,
    name: seat.name,
    packedTeam: construction.packed,
    teamSha256: sha256(construction.packed),
    constructionSha256: canonicalJsonDigest(artifact),
    initialNotebook: artifact.evidence.notebook,
  };
}

function foldScore(games: readonly FrozenBattleTerminalEvidence[]): FrozenMatchdayScore {
  const score: FrozenMatchdayScore = { p1: 0, p2: 0, ties: 0 };
  for (const game of games) {
    if (game.result.type === 'tie') score.ties += 1;
    else score[game.result.winner.pid] += 1;
  }
  return score;
}

function matchEnded(score: FrozenMatchdayScore, games: number): boolean {
  return score.p1 >= 2 || score.p2 >= 2 || games >= 3;
}

function resultFor(
  score: FrozenMatchdayScore,
  registrations: Record<Pid, FrozenMatchdayRegistration>,
): FrozenMatchdayResult {
  if (score.p1 === score.p2) return { type: 'tie', winner: null };
  const pid: Pid = score.p1 > score.p2 ? 'p1' : 'p2';
  return { type: 'win', winner: { pid, name: registrations[pid].name } };
}

function copiedOptions(options: FrozenMatchdayRefereeOptions): FrozenMatchdayRefereeOptions {
  if (!options.format) throw new FrozenMatchdayRefereeError('invalid-construction', 'format must be explicit');
  const seats = options.seats.map((seat) => structuredClone(seat));
  if (seats.length !== 2 || new Set(seats.map((seat) => seat.pid)).size !== 2) {
    throw new FrozenMatchdayRefereeError('invalid-construction', 'seats must contain exactly one p1 and one p2');
  }
  for (const seat of seats) {
    if (!exactPid(seat.pid) || !seat.name) {
      throw new FrozenMatchdayRefereeError('invalid-construction', 'each seat needs an exact pid and non-empty name');
    }
  }
  if (options.gameSeeds.length !== 3) {
    throw new FrozenMatchdayRefereeError('invalid-construction', 'a matchday needs exactly three game seeds');
  }
  return {
    format: options.format,
    gameSeeds: options.gameSeeds.map(copySeed) as [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ],
    seats,
  };
}

function assertFormat(format: string): void {
  if (format !== FROZEN_MATCHDAY_FORMAT) {
    throw new FrozenMatchdayRefereeError('invalid-construction', `format must be the pinned ${FROZEN_MATCHDAY_FORMAT}`);
  }
  const { Dex } = loadShowdown();
  const resolved = Dex.formats.get(format);
  const rules = Dex.formats.getRuleTable(resolved);
  if (
    resolved.mod !== 'champions' ||
    resolved.gameType !== 'doubles' ||
    Number(rules.valueRules.get('bestof')) !== 3 ||
    rules.pickedTeamSize !== 4 ||
    !rules.has('forceopenteamsheets')
  ) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      'format must be the pinned Champions doubles Bo3 with forced open team sheets and bring four',
    );
  }
}

function snapshotBody(snapshot: FrozenMatchdaySnapshot): FrozenMatchdaySnapshotBody {
  const { sha256: _digest, ...body } = snapshot;
  return body;
}

export class FrozenMatchdayReferee {
  readonly format: string;
  readonly gameSeeds: readonly [Seed, Seed, Seed];
  readonly showdownRevision: string;
  readonly configDigest: string;

  private readonly options: FrozenMatchdayRefereeOptions;
  private readonly registrations: Record<Pid, FrozenMatchdayRegistration>;
  private phase: FrozenMatchdayPhase = 'playing';
  private revision = 0;
  private score: FrozenMatchdayScore = { p1: 0, p2: 0, ties: 0 };
  private completedGames: FrozenBattleTerminalEvidence[] = [];
  private battle: FrozenBattleReferee | null;
  private ready: Partial<Record<Pid, FrozenReadyState>> = {};
  private notebooks: Record<Pid, string>;
  private privateEvidence: Record<Pid, FrozenBetweenGamePrivateRecord[]> = { p1: [], p2: [] };

  constructor(options: FrozenMatchdayRefereeOptions) {
    this.options = copiedOptions(options);
    this.format = this.options.format;
    assertFormat(this.format);
    this.gameSeeds = this.options.gameSeeds;
    this.showdownRevision = showdownCommit();
    const registrations = this.options.seats.map((seat) =>
      assertConstruction(seat, this.format, this.showdownRevision),
    );
    this.registrations = {
      p1: registrations.find((seat) => seat.pid === 'p1')!,
      p2: registrations.find((seat) => seat.pid === 'p2')!,
    };
    this.configDigest = canonicalJsonDigest({
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      showdownRevision: this.showdownRevision,
      format: this.format,
      gameSeeds: this.gameSeeds.map((seed) => [...seed]),
      registrations: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        name: this.registrations[pid].name,
        teamSha256: this.registrations[pid].teamSha256,
        constructionSha256: this.registrations[pid].constructionSha256,
      })),
    });
    this.notebooks = {
      p1: this.registrations.p1.initialNotebook,
      p2: this.registrations.p2.initialNotebook,
    };
    this.battle = this.newBattle(0);
  }

  static restore(snapshot: FrozenMatchdaySnapshot): FrozenMatchdayReferee {
    if (snapshot.protocolVersion !== FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot protocol is not supported');
    }
    const body = snapshotBody(snapshot);
    if (canonicalJsonDigest(body) !== snapshot.sha256) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot digest does not match its state');
    }
    const referee = new FrozenMatchdayReferee(structuredClone(snapshot.options));
    if (snapshot.configDigest !== referee.configDigest) {
      throw new FrozenMatchdayRefereeError(
        'snapshot-protocol',
        'snapshot configuration does not match its construction',
      );
    }
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.completedGames.length > 3) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot revision or game count is invalid');
    }
    const completedGames = structuredClone(snapshot.completedGames);
    let completedRevisions = 0;
    let score: FrozenMatchdayScore = { p1: 0, p2: 0, ties: 0 };
    for (const [index, game] of completedGames.entries()) {
      if (matchEnded(score, index)) {
        throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot contains a game after the match ended');
      }
      completedRevisions += referee.assertCompletedGame(game, index);
      score = foldScore(completedGames.slice(0, index + 1));
    }
    if (JSON.stringify(score) !== JSON.stringify(snapshot.score)) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot score does not match its games');
    }
    const ended = matchEnded(score, completedGames.length);
    if (
      (snapshot.phase === 'playing' && (!snapshot.activeBattle || ended)) ||
      (snapshot.phase === 'between-games' && (snapshot.activeBattle || ended || completedGames.length === 0)) ||
      (snapshot.phase === 'terminal' && (snapshot.activeBattle || !ended))
    ) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot phase does not match its games');
    }
    if (!['playing', 'between-games', 'terminal'].includes(snapshot.phase)) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot phase is invalid');
    }
    const battle = snapshot.activeBattle ? FrozenBattleReferee.restore(structuredClone(snapshot.activeBattle)) : null;
    let activeRevision = 0;
    if (battle && snapshot.activeBattle) {
      const expectedSeed = referee.gameSeeds[completedGames.length]!;
      if (
        battle.format !== referee.format ||
        JSON.stringify(battle.seed) !== JSON.stringify(expectedSeed) ||
        battle.seats.some(
          (seat) =>
            seat.name !== referee.registrations[seat.pid].name ||
            seat.packedTeam !== referee.registrations[seat.pid].packedTeam,
        )
      ) {
        throw new FrozenMatchdayRefereeError('snapshot-protocol', 'active battle does not match its registration');
      }
      activeRevision = referee.assertActiveBattle(snapshot.activeBattle, completedGames.length, battle);
    }
    const intervalTransitions =
      snapshot.phase === 'playing' ? completedGames.length : Math.max(0, completedGames.length - 1);
    if (snapshot.revision !== completedRevisions + activeRevision + intervalTransitions) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot revision does not match its transitions');
    }
    const ready = structuredClone(snapshot.ready);
    if (snapshot.phase !== 'between-games' && Object.keys(ready).length > 0) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot has readiness outside an interval');
    }
    for (const [rawPid, value] of Object.entries(ready)) {
      if (
        !exactPid(rawPid) ||
        !value ||
        typeof value.notebook !== 'string' ||
        value.notebookSha256 !== sha256(value.notebook)
      ) {
        throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot readiness evidence is invalid');
      }
    }
    referee.assertPrivateSnapshot(snapshot, completedGames.length);
    referee.revision = snapshot.revision;
    referee.phase = snapshot.phase;
    referee.score = score;
    referee.completedGames = completedGames;
    referee.battle = battle;
    referee.ready = ready;
    referee.notebooks = structuredClone(snapshot.notebooks);
    referee.privateEvidence = structuredClone(snapshot.privateEvidence);
    if (referee.stateHash() !== snapshot.stateHash) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot state hash does not match its state');
    }
    return referee;
  }

  observe(pid: Pid): FrozenMatchdayObservation {
    this.requireSeat(pid);
    return {
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      pid,
      phase: this.phase,
      gameNumber: this.gameNumber(),
      score: copyScore(this.score),
      revision: this.revision,
      stateHash: this.stateHash(),
      battle: this.phase === 'playing' ? this.requireBattle().observe(pid) : null,
      terminal: this.phase === 'terminal',
    };
  }

  legalActions(pid: Pid): FrozenMatchdayLegalActions {
    this.requireSeat(pid);
    if (this.phase !== 'playing')
      throw new FrozenMatchdayRefereeError('wrong-phase', 'legal actions exist only while playing');
    const { revision: battleRevision, stateHash: battleStateHash, ...legal } = this.requireBattle().legalActions(pid);
    return {
      ...legal,
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      gameNumber: this.gameNumber(),
      revision: this.revision,
      stateHash: this.stateHash(),
      battleRevision,
      battleStateHash,
    };
  }

  submit(
    pid: Pid,
    command: string,
    expectedRevision: number,
    expectedStateHash: string,
  ): FrozenMatchdaySubmissionResult {
    this.assertToken(pid, expectedRevision, expectedStateHash);
    if (this.phase !== 'playing')
      throw new FrozenMatchdayRefereeError('wrong-phase', 'battle actions are accepted only while playing');
    const battle = this.requireBattle();
    const inner = battle.snapshot();
    const result = battle.submit(pid, command, inner.revision, inner.stateHash);
    if (!result.advanced) return this.submissionResult(false);
    this.revision += 1;
    const terminal = battle.terminalEvidence();
    if (terminal) this.archiveGame(terminal);
    return this.submissionResult(true);
  }

  readyNextGame(
    pid: Pid,
    input: FrozenBetweenGameInput,
    expectedRevision: number,
    expectedStateHash: string,
  ): FrozenMatchdaySubmissionResult {
    this.assertToken(pid, expectedRevision, expectedStateHash);
    if (this.phase !== 'between-games') {
      throw new FrozenMatchdayRefereeError('wrong-phase', 'between-game evidence is accepted only between games');
    }
    if (this.ready[pid]) {
      throw new FrozenMatchdayRefereeError('duplicate-submission', `${pid} already acknowledged this interval`);
    }
    const supplied = Object.hasOwn(input, 'notebookReplacement');
    if (supplied && typeof input.notebookReplacement !== 'string') {
      throw new FrozenMatchdayRefereeError('wrong-phase', 'notebookReplacement must be a string when supplied');
    }
    const notebook = supplied ? input.notebookReplacement! : this.notebooks[pid];
    if (notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT) {
      throw new FrozenMatchdayRefereeError(
        'wrong-phase',
        `notebook exceeds ${FROZEN_MATCHDAY_NOTEBOOK_LIMIT} characters`,
      );
    }
    const ready = { ...this.ready, [pid]: { supplied, notebook, notebookSha256: sha256(notebook) } };
    if (!ready.p1 || !ready.p2) {
      this.ready = ready;
      return this.submissionResult(false);
    }
    for (const readyPid of ['p1', 'p2'] as const) {
      const value = ready[readyPid]!;
      const record: FrozenBetweenGamePrivateRecord = {
        gameNumber: this.completedGames.length,
        supplied: value.supplied,
        notebook: value.notebook,
        notebookSha256: value.notebookSha256,
      };
      this.notebooks[readyPid] = value.notebook;
      this.privateEvidence[readyPid].push(record);
    }
    this.ready = {};
    this.battle = this.newBattle(this.completedGames.length);
    this.phase = 'playing';
    this.revision += 1;
    return this.submissionResult(true);
  }

  seatPrivateEvidence(pid: Pid): FrozenMatchdayPrivateEvidence {
    this.requireSeat(pid);
    return {
      pid,
      currentNotebook: this.notebooks[pid],
      intervals: structuredClone(this.privateEvidence[pid]),
    };
  }

  snapshot(): FrozenMatchdaySnapshot {
    const body: FrozenMatchdaySnapshotBody = {
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      options: structuredClone(this.options),
      configDigest: this.configDigest,
      revision: this.revision,
      phase: this.phase,
      score: copyScore(this.score),
      completedGames: structuredClone(this.completedGames),
      activeBattle: this.battle?.snapshot() ?? null,
      ready: structuredClone(this.ready),
      notebooks: structuredClone(this.notebooks),
      privateEvidence: structuredClone(this.privateEvidence),
      stateHash: this.stateHash(),
    };
    return { ...body, sha256: canonicalJsonDigest(body) };
  }

  terminalEvidence(): FrozenMatchdayTerminalEvidence | null {
    if (this.phase !== 'terminal') return null;
    return {
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      showdownRevision: this.showdownRevision,
      format: this.format,
      configDigest: this.configDigest,
      registrations: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        name: this.registrations[pid].name,
        teamSha256: this.registrations[pid].teamSha256,
        constructionSha256: this.registrations[pid].constructionSha256,
      })),
      gameSeeds: this.gameSeeds.map((seed) => [...seed]),
      score: copyScore(this.score),
      result: resultFor(this.score, this.registrations),
      games: structuredClone(this.completedGames),
      notebookReceipts: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        intervals: this.privateEvidence[pid].map(({ notebook: _notebook, ...receipt }) => ({ ...receipt })),
      })),
    };
  }

  private replayActions(
    actions: ReadonlyArray<FrozenBattleTerminalEvidence['submittedActions'][number]>,
    index: number,
  ): FrozenBattleReferee {
    const replay = this.newBattle(index);
    try {
      for (const action of actions) {
        const state = replay.snapshot();
        if (action.decisionRevision !== state.revision || action.stateHash !== state.stateHash) {
          throw new Error('action provenance is invalid');
        }
        replay.submit(action.pid, action.command, state.revision, state.stateHash);
      }
    } catch (error) {
      throw new FrozenMatchdayRefereeError(
        'snapshot-protocol',
        `game ${index + 1} action replay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return replay;
  }

  private assertCompletedGame(evidence: FrozenBattleTerminalEvidence, index: number): number {
    const replay = this.replayActions(evidence.submittedActions, index);
    const reproduced = replay.terminalEvidence();
    if (!reproduced || JSON.stringify(reproduced) !== JSON.stringify(evidence)) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', `game ${index + 1} does not replay to its evidence`);
    }
    return replay.snapshot().revision;
  }

  private assertActiveBattle(snapshot: FrozenBattleSnapshot, index: number, restored: FrozenBattleReferee): number {
    const replay = this.replayActions(snapshot.submittedActions, index);
    try {
      for (const [rawPid, command] of Object.entries(snapshot.stagedActions)) {
        const pid = exactPid(rawPid);
        if (!pid || typeof command !== 'string') throw new Error('staged action is invalid');
        const state = replay.snapshot();
        const result = replay.submit(pid, command, state.revision, state.stateHash);
        if (result.advanced) throw new Error('staged actions contain a complete joint decision');
      }
    } catch (error) {
      throw new FrozenMatchdayRefereeError(
        'snapshot-protocol',
        `game ${index + 1} staged action replay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const expected = replay.snapshot();
    if (
      replay.terminalEvidence() ||
      restored.terminalEvidence() ||
      expected.revision !== snapshot.revision ||
      expected.stateHash !== snapshot.stateHash ||
      expected.winnerPid !== snapshot.winnerPid ||
      JSON.stringify(expected.submittedActions) !== JSON.stringify(snapshot.submittedActions) ||
      JSON.stringify(expected.stagedActions) !== JSON.stringify(snapshot.stagedActions)
    ) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', `game ${index + 1} active state does not replay`);
    }
    return expected.revision;
  }

  private assertPrivateSnapshot(snapshot: FrozenMatchdaySnapshot, completedGameCount: number): void {
    if (!snapshot.notebooks || !snapshot.privateEvidence) {
      throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot private evidence is missing');
    }
    const expectedIntervals = snapshot.phase === 'playing' ? completedGameCount : Math.max(0, completedGameCount - 1);
    for (const pid of ['p1', 'p2'] as const) {
      const records = snapshot.privateEvidence[pid];
      if (!Array.isArray(records) || records.length !== expectedIntervals) {
        throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot private evidence count is invalid');
      }
      let current = this.registrations[pid].initialNotebook;
      for (const [index, record] of records.entries()) {
        if (
          record.gameNumber !== index + 1 ||
          typeof record.supplied !== 'boolean' ||
          typeof record.notebook !== 'string' ||
          record.notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT ||
          record.notebookSha256 !== sha256(record.notebook)
        ) {
          throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot private evidence is invalid');
        }
        current = record.notebook;
      }
      if (snapshot.notebooks[pid] !== current) {
        throw new FrozenMatchdayRefereeError(
          'snapshot-protocol',
          'snapshot current notebook does not match its evidence',
        );
      }
      const staged = snapshot.ready[pid];
      if (
        staged &&
        (typeof staged.supplied !== 'boolean' ||
          typeof staged.notebook !== 'string' ||
          staged.notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT ||
          staged.notebookSha256 !== sha256(staged.notebook) ||
          (!staged.supplied && staged.notebook !== current))
      ) {
        throw new FrozenMatchdayRefereeError('snapshot-protocol', 'snapshot staged notebook is invalid');
      }
    }
    if (Object.keys(snapshot.ready).length > 1) {
      throw new FrozenMatchdayRefereeError(
        'snapshot-protocol',
        'snapshot contains an uncommitted joint acknowledgement',
      );
    }
  }

  private newBattle(index: number): FrozenBattleReferee {
    const seed = this.gameSeeds[index];
    if (!seed) throw new Error('no scheduled seed remains');
    return new FrozenBattleReferee({
      format: this.format,
      seed,
      seats: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        name: this.registrations[pid].name,
        packedTeam: this.registrations[pid].packedTeam,
      })),
    });
  }

  private archiveGame(evidence: FrozenBattleTerminalEvidence): void {
    this.completedGames.push(structuredClone(evidence));
    this.score = foldScore(this.completedGames);
    this.battle = null;
    this.ready = {};
    this.phase = matchEnded(this.score, this.completedGames.length) ? 'terminal' : 'between-games';
  }

  private gameNumber(): number {
    return Math.min(this.completedGames.length + 1, 3);
  }

  private stateHash(): string {
    return canonicalJsonDigest({
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      configDigest: this.configDigest,
      phase: this.phase,
      revision: this.revision,
      gameNumber: this.gameNumber(),
      score: this.score,
      completedGameDigests: this.completedGames.map((game) => canonicalJsonDigest(game)),
      activeBattleStateHash: this.battle?.snapshot().stateHash ?? null,
    });
  }

  private submissionResult(advanced: boolean): FrozenMatchdaySubmissionResult {
    return {
      advanced,
      phase: this.phase,
      gameNumber: this.gameNumber(),
      score: copyScore(this.score),
      revision: this.revision,
      stateHash: this.stateHash(),
      terminal: this.phase === 'terminal',
    };
  }

  private assertToken(pid: Pid, revision: number, stateHash: string): void {
    this.requireSeat(pid);
    if (revision !== this.revision) {
      throw new FrozenMatchdayRefereeError(
        'stale-revision',
        `expected revision ${revision}, current revision is ${this.revision}`,
      );
    }
    if (stateHash !== this.stateHash()) {
      throw new FrozenMatchdayRefereeError(
        'stale-state',
        'expected state hash does not match the current matchday state',
      );
    }
  }

  private requireSeat(pid: Pid): void {
    if (!exactPid(pid)) throw new FrozenMatchdayRefereeError('unknown-seat', `unknown seat ${String(pid)}`);
  }

  private requireBattle(): FrozenBattleReferee {
    if (!this.battle) throw new FrozenMatchdayRefereeError('wrong-phase', 'there is no active game');
    return this.battle;
  }
}
