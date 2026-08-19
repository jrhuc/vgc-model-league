import { createHash } from 'node:crypto';
import {
  FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
  type FrozenBattleObservation,
  FrozenBattleReferee,
  type FrozenBattleTerminalEvidence,
  type FrozenLegalActions,
} from './frozen-battle-referee.js';
import { canonicalJsonDigest } from './serialization.js';
import { foldSeriesGames, seriesSeedSchedule } from './series.js';
import { loadShowdown, showdownCommit } from './showdown.js';
import { replayTeamBuildArtifact, type TeamBuildSubmissionValidation } from './teambuild.js';
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
  requireWinner?: boolean;
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
  povLines: string[];
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
  requireWinner?: true;
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

export type FrozenMatchdayRefereeErrorCode =
  | 'invalid-construction'
  | 'unknown-seat'
  | 'wrong-phase'
  | 'stale-revision'
  | 'stale-state'
  | 'duplicate-submission';

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
  let replayed: ReturnType<typeof replayTeamBuildArtifact>;
  try {
    replayed = replayTeamBuildArtifact(construction.artifact);
  } catch (cause) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      `${seat.pid} construction failed semantic replay: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const artifact = replayed.artifact;
  if (
    artifact.executionPolicy !== 'strict' ||
    artifact.task.executionPolicy !== 'strict' ||
    artifact.task.sheetPolicy !== 'open' ||
    artifact.task.format !== format ||
    artifact.showdownCommit !== revision ||
    construction.packed !== replayed.packed ||
    artifact.evidence.notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT
  ) {
    throw new FrozenMatchdayRefereeError(
      'invalid-construction',
      `${seat.pid} construction artifact is not joined to the frozen format and open-sheet policy`,
    );
  }
  return {
    pid: seat.pid,
    name: seat.name,
    packedTeam: replayed.packed,
    teamSha256: sha256(replayed.packed),
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

function foldMatchday(
  gameSeeds: readonly Seed[],
  games: readonly FrozenBattleTerminalEvidence[],
  requireWinner: boolean,
) {
  return foldSeriesGames(
    gameSeeds.map((seed) => [...seed]),
    games.map((game, index) => ({
      number: index + 1,
      seed: game.seed,
      winner_side: game.result.type === 'win' ? game.result.winner.pid : null,
    })),
    { requireWinner, label: 'frozen matchday' },
  );
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
  if (options.requireWinner !== undefined && typeof options.requireWinner !== 'boolean') {
    throw new FrozenMatchdayRefereeError('invalid-construction', 'requireWinner must be a boolean when supplied');
  }
  return {
    format: options.format,
    gameSeeds: options.gameSeeds.map(copySeed) as [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ],
    ...(options.requireWinner === true ? { requireWinner: true } : {}),
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

export class FrozenMatchdayReferee {
  readonly format: string;
  readonly gameSeeds: readonly [Seed, Seed, Seed];
  readonly requireWinner: boolean;
  readonly showdownRevision: string;
  readonly configDigest: string;

  private readonly options: FrozenMatchdayRefereeOptions;
  private readonly registrations: Record<Pid, FrozenMatchdayRegistration>;
  private phase: FrozenMatchdayPhase = 'playing';
  private revision = 0;
  private score: FrozenMatchdayScore = { p1: 0, p2: 0, ties: 0 };
  private completedGames: FrozenBattleTerminalEvidence[] = [];
  private battle: FrozenBattleReferee | null;
  private pendingPovLines: Record<Pid, string[]> = { p1: [], p2: [] };
  private ready: Partial<Record<Pid, FrozenReadyState>> = {};
  private notebooks: Record<Pid, string>;
  private privateEvidence: Record<Pid, FrozenBetweenGamePrivateRecord[]> = { p1: [], p2: [] };

  constructor(options: FrozenMatchdayRefereeOptions) {
    this.options = copiedOptions(options);
    this.format = this.options.format;
    assertFormat(this.format);
    this.gameSeeds = this.options.gameSeeds;
    this.requireWinner = this.options.requireWinner === true;
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
      ...(this.requireWinner
        ? {
            requireWinner: true,
            winnerExtension: 'foldSeriesGames-v1-deterministic-up-to-nine',
            completeGameSeedSchedule: seriesSeedSchedule(
              this.gameSeeds.map((seed) => [...seed]),
              true,
            ),
          }
        : {}),
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

  observe(pid: Pid): FrozenMatchdayObservation {
    this.requireSeat(pid);
    const povLines = [...this.pendingPovLines[pid]];
    this.pendingPovLines[pid] = [];
    return {
      protocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      pid,
      phase: this.phase,
      gameNumber: this.gameNumber(),
      score: copyScore(this.score),
      revision: this.revision,
      stateHash: this.stateHash(),
      povLines,
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
    const inner = battle.currentState();
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

  acceptedOptions(): FrozenMatchdayRefereeOptions {
    return structuredClone(this.options);
  }

  currentState(): { revision: number; stateHash: string } {
    return { revision: this.revision, stateHash: this.stateHash() };
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
      gameSeeds: this.requireWinner
        ? this.completedGames.map((game) => [...game.seed])
        : this.gameSeeds.map((seed) => [...seed]),
      ...(this.requireWinner ? { requireWinner: true as const } : {}),
      score: copyScore(this.score),
      result: resultFor(this.score, this.registrations),
      games: structuredClone(this.completedGames),
      notebookReceipts: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        intervals: this.privateEvidence[pid].map(({ notebook: _notebook, ...receipt }) => ({ ...receipt })),
      })),
    };
  }

  private newBattle(index: number): FrozenBattleReferee {
    const folded = foldMatchday(this.gameSeeds, this.completedGames, this.requireWinner);
    const seed = index < this.gameSeeds.length ? this.gameSeeds[index] : folded.nextSeed;
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
    const battle = this.requireBattle();
    for (const pid of ['p1', 'p2'] as const) {
      const observation = battle.observe(pid);
      this.pendingPovLines[pid].push(...observation.povLines);
    }
    this.completedGames.push(structuredClone(evidence));
    this.score = foldScore(this.completedGames);
    this.battle = null;
    this.ready = {};
    const folded = foldMatchday(this.gameSeeds, this.completedGames, this.requireWinner);
    if (!folded.complete && !folded.nextSeed) {
      throw new Error('single-elimination frozen matchday remained tied after the authority game limit');
    }
    this.phase = folded.complete ? 'terminal' : 'between-games';
  }

  private gameNumber(): number {
    return Math.min(this.completedGames.length + 1, this.requireWinner ? 9 : 3);
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
      activeBattleStateHash: this.battle?.currentState().stateHash ?? null,
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
