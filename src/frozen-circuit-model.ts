import type { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION } from './frozen-battle-referee.js';
import type {
  FROZEN_MATCHDAY_FORMAT,
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  FrozenMatchdayObservation,
  FrozenMatchdayTerminalEvidence,
} from './frozen-matchday-referee.js';
import type { TeamBuildSubmissionValidation } from './teambuild.js';
import type { BracketMatch } from './tournament.js';
import type { TradeSwap, TradeWindowState } from './trade-window.js';
import type { Pid } from './types.js';

export const FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION = 2 as const;
export const FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION = 2 as const;
export const FROZEN_CIRCUIT_SCENARIOS = ['victory-road-top8-v1', 'draft-league-v1'] as const;
export const FROZEN_CIRCUIT_SEAT_IDS = [
  'seat-1',
  'seat-2',
  'seat-3',
  'seat-4',
  'seat-5',
  'seat-6',
  'seat-7',
  'seat-8',
] as const;
export const FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS = 2;
export const FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS = 2;
export const FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS = 2;
export const FROZEN_CIRCUIT_MAX_PROMPT_BYTES = 2 * 1024 * 1024;

export type FrozenCircuitScenarioId = (typeof FROZEN_CIRCUIT_SCENARIOS)[number];
export type FrozenCircuitSeatId = (typeof FROZEN_CIRCUIT_SEAT_IDS)[number];
export type FrozenCircuitTurnKind =
  | 'draft'
  | 'construction'
  | 'action'
  | 'notebook'
  | 'trade_offer'
  | 'trade_response'
  | 'free_agency';
export type FrozenCircuitPhase = 'draft' | 'construction' | 'tournament' | 'trade' | 'terminal';
export type FrozenCircuitSeriesStage = 'top-cut' | 'roundrobin' | 'playoff';

export type AcceptedConstruction = Extract<TeamBuildSubmissionValidation, { status: 'accepted' }>;
export type Seed = [number, number, number, number];

export interface FrozenCircuitPendingTurn {
  turnId: string;
  seatId: FrozenCircuitSeatId;
  kind: FrozenCircuitTurnKind;
  prompt: string;
  attempt: number;
}

export interface FrozenCircuitSubmissionResult {
  accepted: boolean;
  advanced: boolean;
  defaulted: boolean;
  diagnostic: string | null;
  problems?: string[];
  phase: FrozenCircuitPhase;
  revision: number;
  stateHash: string;
  terminal: boolean;
}

export interface FrozenCircuitObservation {
  protocolVersion: typeof FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION;
  promptProtocolVersion: typeof FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION;
  scenarioId: FrozenCircuitScenarioId;
  seatId: FrozenCircuitSeatId;
  phase: FrozenCircuitPhase;
  revision: number;
  stateHash: string;
  pendingTurns: FrozenCircuitPendingTurn[];
  bracket: BracketMatch[][] | null;
  private: {
    roster: Array<{ id: string; name: string; cost: number }>;
    budget: number | null;
    notebook: string;
    activeSeries: {
      seriesIndex: number;
      stage: FrozenCircuitSeriesStage;
      week: number | null;
      opponentSeatId: FrozenCircuitSeatId;
      pid: Pid;
    } | null;
    matchday: FrozenMatchdayObservation | null;
  };
  terminal: boolean;
}

export interface CircuitSeat {
  seatId: FrozenCircuitSeatId;
  name: string;
  fixedConstruction: AcceptedConstruction | null;
}

export interface CircuitSeriesPlan {
  index: number;
  stage: FrozenCircuitSeriesStage;
  week: number | null;
  entrants: [number, number] | null;
  gameSeeds: [Seed, Seed, Seed];
}

export interface PendingInternal extends FrozenCircuitPendingTurn {
  pid?: Pid;
  seriesIndex?: number;
  taskKey?: string;
  observation?: FrozenMatchdayObservation;
  legalCommands?: string[];
  problems?: string[];
  tradeEntrant?: number;
}

export interface TurnReceipt {
  turnId: string;
  seatId: FrozenCircuitSeatId;
  kind: FrozenCircuitTurnKind;
  attempt: number;
  responseSha256: string;
  accepted: boolean;
  advanced: boolean;
  defaulted: boolean;
  diagnostic: string | null;
}

export interface DomainDefault {
  turnId: string;
  seatId: FrozenCircuitSeatId;
  kind: 'draft' | 'construction' | 'action' | 'trade_offer' | 'trade_response' | 'free_agency';
  seriesIndex: number | null;
  selectedDigest: string;
  diagnostic: string;
}

export interface SeriesSummary {
  seriesIndex: number;
  stage: FrozenCircuitSeriesStage;
  week: number | null;
  bracketRound: number | null;
  seats: { p1: FrozenCircuitSeatId; p2: FrozenCircuitSeatId };
  winnerSeatId: FrozenCircuitSeatId | null;
  tiebreak: 'none' | 'deterministic-extra-games';
  score: { p1: number; p2: number; ties: number };
  gameCount: number;
  games: Array<{
    gameNumber: number;
    result: { type: 'win'; winnerSeatId: FrozenCircuitSeatId } | { type: 'tie'; winnerSeatId: null };
    turns: number;
  }>;
  matchdayConfigDigest: string;
  acceptedJoins: Array<{
    seatId: FrozenCircuitSeatId;
    pid: Pid;
    teamSha256: string;
    constructionSha256: string;
  }>;
}

export interface PrivateSeriesEvidence {
  seriesIndex: number;
  evidence: FrozenMatchdayTerminalEvidence;
}

export interface Wdl {
  wins: number;
  draws: number;
  losses: number;
}

export interface SeatSplit {
  series: Wdl;
  games: Wdl;
}

export interface TransactionSummary {
  afterWeek: number;
  tradesAllowed: number;
  maxFreeAgencySwaps: number;
  order: FrozenCircuitSeatId[];
  offers: Array<{
    from: FrozenCircuitSeatId;
    to: FrozenCircuitSeatId | null;
    give: string | null;
    get: string | null;
    accepted: boolean | null;
    proposerDefaulted: boolean;
    responderDefaulted: boolean | null;
  }>;
  freeAgency: Array<{
    seatId: FrozenCircuitSeatId;
    swaps: TradeSwap[];
    defaulted: boolean;
  }>;
  finalRosterDigests: Array<{ seatId: FrozenCircuitSeatId; rosterDigest: string }>;
}

export interface FrozenCircuitTerminalSummary {
  protocolVersion: typeof FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION;
  promptProtocolVersion: typeof FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION;
  matchdayProtocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  battleProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  showdownRevision: string;
  scenarioId: FrozenCircuitScenarioId;
  format: typeof FROZEN_MATCHDAY_FORMAT;
  configDigest: string;
  promptRevision: string;
  fixtureDigests: { board: string | null; victoryRoadPool: string | null };
  scenario: {
    seats: 8;
    source: string;
    scope: string;
    claims: string[];
    doesNotClaim: string[];
  };
  championSeatId: FrozenCircuitSeatId;
  finalStandings: Array<{
    rank: number;
    seatId: FrozenCircuitSeatId;
    series: Wdl;
    gameWins: number;
    gameDraws: number;
    gameLosses: number;
  }> | null;
  bracket: BracketMatch[][];
  series: SeriesSummary[];
  perSeat: Array<{
    seatId: FrozenCircuitSeatId;
    name: string;
    total: SeatSplit;
    roundRobinPreWindow: SeatSplit;
    roundRobinPostWindow: SeatSplit;
    playoffs: SeatSplit;
    topCut: SeatSplit;
    reward: {
      name: 'draft_league_series_return_v1' | 'tournament_series_return_v1';
      value: number;
    };
    defaults: Record<DomainDefault['kind'], number>;
  }>;
  transactions: TransactionSummary | null;
  defaults: DomainDefault[];
  turnReceipts: TurnReceipt[];
}

export interface FrozenCircuitTerminalEvidence {
  summary: FrozenCircuitTerminalSummary;
  privateEvidence: {
    series: PrivateSeriesEvidence[];
    seats: Array<{
      seatId: FrozenCircuitSeatId;
      notebook: string;
      constructions: Array<{ seriesIndex: number; construction: AcceptedConstruction }>;
    }>;
    transactionState: TradeWindowState | null;
    turnReceipts: Array<TurnReceipt & { response: string }>;
    derived: {
      seed: number;
      seatPermutation: number[];
      seriesSeeds: Seed[][];
    };
  };
}

export type FrozenCircuitRefereeErrorCode =
  | 'invalid-construction'
  | 'unknown-scenario'
  | 'unknown-seat'
  | 'unknown-turn'
  | 'wrong-seat'
  | 'wrong-phase';

export class FrozenCircuitRefereeError extends Error {
  constructor(
    readonly code: FrozenCircuitRefereeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FrozenCircuitRefereeError';
  }
}
