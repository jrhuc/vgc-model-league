import type { ExperimentMode, Pid } from '../types.js';

export interface ModelInfo {
  id: string;
  label: string;
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

export interface SessionUserView {
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

export interface BracketEntrantView {
  model: string;
  team: string;
}

export interface BracketMatchView {
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

export interface RunSnapshot {
  runId: string;
  mode: ExperimentMode;
  protocolVersion: number;
  state: 'running' | 'done' | 'failed';
  error: string;
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
}

export interface SampleTeam {
  name: string;
  paste: string;
}

export interface AppState {
  pools: PoolInfo[];
  reasoningLevels: string[];
  defaultFormat: string;
  formats: FormatInfo[];
  providers: ProviderInfo[];
  /** Ready-to-play pastes from the default pool that prefill the exhibition match form. */
  sampleTeams: SampleTeam[];
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
  lastMove: string;
}

export interface SideView {
  player: string;
  conditions: string[];
  mons: MonView[];
}

export interface BattleSnapshot {
  turn: number;
  weather: string;
  fields: string[];
  sides: Record<Pid, SideView>;
}

export interface BattleMessage {
  index: number;
  game: number;
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

export interface RecordsResponse {
  count: number;
  /** Applied pool filter; null is the overall view, which excludes the test pool. */
  pool: string | null;
  /** Every pool present in the records file, including the test pool. */
  pools: string[];
  standings: StandingView[];
  h2h: Record<string, Record<string, [number, number, number]>>;
  records: unknown[];
}

export interface ModelsResponse {
  models: ModelInfo[];
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

export interface CreatePoolResponse {
  ok: boolean;
  name: string;
  pools: PoolInfo[];
}

export interface RunRequest {
  mode?: 'rotation' | 'tournament';
  models: string[];
  apiKeys: Record<string, string>;
  /** Required unless inline teams are supplied. */
  pool?: string;
  /** Inline team pastes, one per model in order; tournament mode only. */
  teams?: string[];
  /** Showdown format for inline teams; defaults to the server's default format. */
  format?: string;
  seriesPerPair?: number;
  concurrency: number;
  seed: string;
  reasoning?: string;
}
