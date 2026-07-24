import type { ExperimentMode, Pid } from '../types.js';

export interface ModelInfo {
  id: string;
  label: string;
  reasoningLevels: string[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  discovery: 'list' | 'manual' | 'none';
  requiresKey: boolean;
  models: ModelInfo[];
}

export interface PoolInfo {
  name: string;
  id: string;
  format: string;
  teamCount: number;
}

interface SessionUserView {
  login: string;
  avatarUrl: string;
  role: 'reader' | 'contributor' | 'operator';
}

export interface AuthView {
  mode: 'local' | 'github' | 'read-only';
  user: SessionUserView | null;
  csrfToken: string | null;
}

export interface FormatInfo {
  id: string;
  label: string;
}

export interface SeriesRowView {
  players: Record<Pid, string>;
  status: 'queued' | 'running' | 'done';
  score: Record<Pid, number>;
  game: number;
  turn: number;
  turns: number;
  winner: string | null;
}

export interface BoardInfo {
  id: string;
  format: string;
  monCount: number;
  budget: number;
  picks: number;
  /** Largest entrant count the board can support with one spare roster of slack. */
  maxEntrants: number;
}

export interface DraftBoardMonView {
  id: string;
  name: string;
  tier: string;
  cost: number;
  item: string;
  ability: string;
  moves: string[];
  teraType: string;
}

export interface DraftPickView {
  pick: number;
  entrant: number;
  mon: string;
  rationale: string;
  fallback: boolean;
}

export interface DraftTableRow {
  entrant: number;
  w: number;
  l: number;
  gw: number;
  gl: number;
}

export interface DraftView {
  boardId: string;
  budget: number;
  picksPerEntrant: number;
  entrants: string[];
  board: DraftBoardMonView[];
  picks: DraftPickView[];
  rosters: string[][];
  budgets: number[];
  /** Round-robin table, present once battles begin; sorted by rank. */
  table: DraftTableRow[] | null;
  phase: 'draft' | 'roundrobin' | 'playoffs' | 'done';
}

interface BracketEntrantView {
  model: string;
  team: string;
}

interface BracketMatchView {
  /** Index into RunSnapshot.rows; null for byes, which play no series. */
  seriesIndex: number | null;
  /** Entrant indices; null until the feeding match resolves. */
  slots: [number | null, number | null];
  winner: number | null;
}

export interface BracketView {
  entrants: BracketEntrantView[];
  rounds: BracketMatchView[][];
  champion: number | null;
}

export interface RunPauseView {
  model: string;
  kind: string;
  message: string;
  since: number;
}

export interface RunSnapshot {
  runId: string;
  mode: ExperimentMode;
  protocolVersion: number;
  state: 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  error: string;
  pause: RunPauseView | null;
  notices: string[];
  seed: number | null;
  pool: string;
  models: string[];
  startTime: number;
  owner: string | null;
  endTime: number | null;
  canControl: boolean;
  rows: SeriesRowView[];
  bracket: BracketView | null;
  draft: DraftView | null;
  board: string | null;
}

export interface SampleTeam {
  name: string;
  paste: string;
}

export interface PoolTeamsResponse {
  name: string;
  format: string;
  teams: SampleTeam[];
}

export interface AppState {
  pools: PoolInfo[];
  reasoningLevels: string[];
  defaultFormat: string;
  formats: FormatInfo[];
  providers: ProviderInfo[];
  sampleTeams: SampleTeam[];
  boards: BoardInfo[];
  auth: AuthView;
  run: RunSnapshot | null;
}

export interface MonView {
  species: string;
  slot: string;
  hp: string;
  status: string;
  fainted: boolean;
  boosts: string;
  volatiles: string;
  lastMove: string;
}

export interface SideView {
  player: string;
  conditions: string[];
  mons: MonView[];
}

export interface BattleLogEntryView {
  turn: number;
  kind: string;
  text: string;
}

export interface SideTimerView {
  /** Remaining time bank in seconds as of snapshot generation; null in untimed play. */
  seconds: number | null;
  turnSeconds: number | null;
  /** Seconds spent on the decision in progress; null when idle. Clients count up from the snapshot time. */
  elapsedSeconds: number | null;
  /** True while the player is deciding; clients may count down from the snapshot time. */
  running: boolean;
}

/** Cumulative series spend for one side: decision wall-clock plus all model tokens, reflections included. */
export interface SpendView {
  seconds: number;
  tokens: number;
}

export interface DecisionView {
  game: number;
  turn: number;
  pid: Pid;
  phase: string;
  selection: string[];
  rationale: string;
  error: string;
  automatic: boolean;
  fallback: boolean;
  substituted: boolean;
}

export interface BattleSnapshot {
  turn: number;
  weather: string;
  fields: string[];
  sides: Record<Pid, SideView>;
  timers: Record<Pid, SideTimerView | null>;
  spend: Record<Pid, SpendView>;
  log: BattleLogEntryView[];
  decisions: DecisionView[];
}

export interface BattleMessage {
  index: number;
  game: number;
  /** Game numbers with a retained log, ascending; pass ?game= to fetch one. */
  games: number[];
  revision: number;
  snapshot: BattleSnapshot | null;
}

export type ServerEvent = { type: 'run'; run: RunSnapshot | null } | ({ type: 'battle' } & BattleMessage);

export interface StandingView {
  spec: string;
  series: number;
  w: number;
  l: number;
  t: number;
  winrate: number;
  elo: number;
}

export interface TrajectoryPointView {
  series: number;
  spec: string;
  elo: number;
}

interface SpeedGroupView {
  scale: number | 'off';
  label: string;
  count: number;
  standings: StandingView[];
  h2h: Record<string, Record<string, [number, number, number]>>;
  trajectory: TrajectoryPointView[];
}

export interface RecordsResponse {
  count: number;
  /** Applied pool filter; null is the overall view, which excludes the test pool. */
  pool: string | null;
  pools: string[];
  /** Rated rotation rows split by battle speed; untimed first, then ascending clock scales. */
  groups: SpeedGroupView[];
  records: unknown[];
}

export interface LatencyPoint {
  ms: number;
  /** Absent when the provider reports no usage (CLI-subprocess engines). */
  tokens?: number;
  seriesId: string;
  game: number;
  turn: number;
  phase: string;
}

export interface ModelEvidence {
  /** Normalized model key; matches standings specs. */
  spec: string;
  /** Raw provider specs merged into this key. */
  providers: string[];
  series: number;
  decisions: number;
  reflections: number;
  latency: { median: number; p25: number; p75: number; max: number } | null;
  /** Output-token quantiles for decisions with reported usage; null when the provider reports none. */
  tokens: { median: number; p25: number; p75: number; max: number } | null;
  points: LatencyPoint[];
  /**
   * fallback, parseFailure, providerRetry, toolLookups are per decision; switch and protect are shares of
   * action selections; threatConversion is threat hits over threat turns.
   */
  rates: {
    fallback: number;
    parseFailure: number;
    providerRetry: number;
    switch: number;
    protect: number;
    toolLookups: number;
    threatConversion: number | null;
    reflectionFallback: number | null;
  };
}

export interface SeriesLuckEntry {
  seriesId: string;
  runId: string;
  timestamp: string;
  p1: string;
  p2: string;
  winner: string | null;
  score: [number, number];
  games: number;
  turns: number;
  /** Adverse luck events suffered per side: misses, crits taken, flinched turns, full paralysis. */
  luck: Record<Pid, number>;
  /** Luck suffered by the winner minus the loser; positive means the winner overcame worse luck. Null for ties. */
  winnerLuckDelta: number | null;
}

export interface TournamentStanding {
  spec: string;
  entered: number;
  titles: number;
  runnerUp: number;
  semis: number;
  earlier: number;
  matchWins: number;
  matchLosses: number;
}

export interface TournamentSummary {
  tournaments: number;
  matches: number;
  standings: TournamentStanding[];
}

export interface EvidenceResponse {
  pool: string | null;
  count: number;
  decisions: number;
  models: ModelEvidence[];
  series: SeriesLuckEntry[];
  tournaments: TournamentSummary;
}

export interface ModelsResponse {
  models: ModelInfo[];
}

export interface ReasoningLevelsResponse {
  levels: string[];
}

export interface TeamMemberView {
  species: string;
  item: string;
  ability: string;
  moves: string[];
  teraType: string;
}

export interface ValidateResponse {
  species: string[];
  members: TeamMemberView[];
  problems: string[];
}

export interface PokepasteResponse {
  paste: string;
}

export interface CreatePoolResponse {
  ok: boolean;
  name: string;
  pools: PoolInfo[];
}
