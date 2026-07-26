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
  /** Showdown sprite id of the forme this entry becomes in battle. */
  spriteId: string;
  cost: number;
  types: string[];
  /** Mega Stone this entry is locked to; empty for non-Mega entries. */
  item: string;
  abilities: string[];
  baseStats: Record<string, number>;
  /** "wdl" for a Wolfey board price, "regmb" for a Reg M-B addition. */
  origin: string;
  /** Why a Reg M-B addition costs what it does; empty for Wolfey entries. */
  anchor: string;
  /** Reg M-B ladder usage behind a re-priced entry; empty when unchanged. */
  usage: string;
  /** The pre-adjustment price, present only when usage moved it. */
  listed: number | null;
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

export interface TeambuildSetView {
  species: string;
  /** Showdown sprite id of the forme this set becomes in battle. */
  spriteId: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  evs: Record<string, number>;
  /** True when the validator rejected the model's set and it was repaired. */
  repaired: boolean;
  repairs: string[];
}

export interface TeambuildView {
  seriesIndex: number;
  entrant: number;
  opponent: number;
  /** Board ids the model brought, a subset of its roster. */
  brought: string[];
  sets: TeambuildSetView[];
  rationale: string;
  attempts: number;
}

export interface DraftView {
  boardId: string;
  budget: number;
  picksPerEntrant: number;
  entrants: string[];
  /** Franchise names the models chose during the draft. */
  teamNames: string[];
  picks: DraftPickView[];
  rosters: string[][];
  budgets: number[];
  /** Round-robin table, present once battles begin; sorted by rank. */
  table: DraftTableRow[] | null;
  /** One entry per completed teambuild, newest last. */
  teambuilds: TeambuildView[];
  /** Round-robin week now playing, 1-based; 0 before the schedule starts. */
  week: number;
  weeks: number;
  phase: 'draft' | 'roundrobin' | 'playoffs' | 'done';
}

export interface BracketEntrantView {
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

export interface BoardResponse {
  id: string;
  format: string;
  budget: number;
  picks: number;
  source: string;
  mons: DraftBoardMonView[];
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
  /** Showdown sprite id, resolved server-side; renders as /sprites/<id>.png. */
  spriteId: string;
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
  imported: number;
}

export interface LatencyPoint {
  ms: number;
  tokens?: number;
  seriesId: string;
  game: number;
  turn: number;
  phase: string;
}

export interface ModelEvidence {
  spec: string;
  providers: string[];
  series: number;
  decisions: number;
  reflections: number;
  latency: { median: number; p25: number; p75: number; max: number } | null;
  tokens: { median: number; p25: number; p75: number; max: number } | null;
  points: LatencyPoint[];
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
  luck: Record<Pid, number>;
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
}

export interface ArchivedMatchView {
  slots: [number | null, number | null];
  winner: number | null;
  score: [number, number] | null;
  turns: number | null;
}

export interface TournamentArchiveView {
  runId: string;
  when: string;
  pool: string | null;
  entrants: BracketEntrantView[];
  rounds: ArchivedMatchView[][];
  champion: number | null;
  complete: boolean;
}

export interface TournamentsResponse {
  pool: string | null;
  pools: string[];
  summary: TournamentSummary;
  tournaments: TournamentArchiveView[];
}

export interface ImportRequest {
  row: Record<string, unknown>;
  logs?: Partial<Record<Pid, string>>;
  runConfig?: Record<string, unknown>;
  pool?: { name: string; format: string; teams: Array<{ id: string; paste: string }> };
}

export interface ImportResponse {
  imported: boolean;
  duplicate?: boolean;
  runId: string;
  seriesId: string;
  logs: Pid[];
  pool: 'created' | 'present' | null;
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
