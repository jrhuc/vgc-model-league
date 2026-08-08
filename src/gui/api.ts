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
  maxEntrants: number;
}

export interface DraftBoardMonView {
  id: string;
  name: string;
  spriteId: string;
  cost: number;
  types: string[];
  item: string;
  abilities: string[];
  baseStats: Record<string, number>;
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
  spriteId: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  evs: Record<string, number>;
  note?: string;
  repaired: boolean;
  repairs: string[];
}

export interface TeambuildView {
  seriesIndex: number;
  entrant: number;
  opponent: number;
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
  teamNames: string[];
  picks: DraftPickView[];
  rosters: string[][];
  budgets: number[];
  table: DraftTableRow[] | null;
  teambuilds: TeambuildView[];
  week: number;
  weeks: number;
  phase: 'draft' | 'roundrobin' | 'window' | 'playoffs' | 'done';
}

export interface BracketEntrantView {
  model: string;
  team: string;
  seed?: number | null;
  placement?: number | null;
  player?: string;
  paste?: string;
  teamSheet?: TeambuildSetView[];
}

interface BracketMatchView {
  seriesIndex: number | null;
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
  externalRun: { runId: string; mode: 'draft' | 'tournament' } | null;
}

export interface MonView {
  species: string;
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

export interface TournamentSummary {
  tournaments: number;
  matches: number;
}

export interface ArchivedMatchView {
  seriesIndex: number | null;
  slots: [number | null, number | null];
  winner: number | null;
  score: [number, number] | null;
  turns: number | null;
}

export interface TournamentEventView {
  name: string;
  game: string;
  regulation: string;
  location: string;
  dates: string;
  players: number | null;
  structure: string;
  url: string;
  reconstructedSpreads: boolean;
}

export interface TournamentLiveSeriesView {
  seriesId: string;
  seriesIndex: number | null;
  round: number | null;
  slots: [number | null, number | null];
  game: number;
  turn: number;
  decisions: number;
}

export interface TournamentArchiveView {
  runId: string;
  when: string;
  pool: string | null;
  entrants: BracketEntrantView[];
  rounds: ArchivedMatchView[][];
  champion: number | null;
  complete: boolean;
  live: boolean;
  liveSeries: TournamentLiveSeriesView[];
  event: TournamentEventView | null;
  provenance: 'disclosed' | 'blind' | null;
}

export interface TournamentsResponse {
  pool: string | null;
  pools: string[];
  summary: TournamentSummary;
  tournaments: TournamentArchiveView[];
}

export interface LeagueChampionView {
  entrant: number;
  model: string;
  team: string;
}

export type LeaguePhase = 'drafting' | 'building' | 'roundrobin' | 'window' | 'playoffs' | 'complete';

export interface LeagueCardView {
  runId: string;
  when: string;
  board: string | null;
  format: string | null;
  entrants: string[];
  teamNames: string[];
  weeks: number | null;
  seriesCount: number;
  phase: LeaguePhase;
  week: number;
  champion: LeagueChampionView | null;
  tradeWindowAfterWeek: number | null;
  draftOnly: boolean;
  live: boolean;
  picks: number | null;
}

export interface LeaguesResponse {
  leagues: LeagueCardView[];
}

export interface LeagueRosterSlotView {
  id: string;
  name: string;
  cost: number;
  pick: number | null;
  rationale: string;
  fallback: boolean;
  acquired: 'draft' | 'window';
}

export interface LeagueRecordView {
  w: number;
  l: number;
  gw: number;
  gl: number;
}

export interface LeagueFranchiseStatsView {
  decisions: number;
  latency: QuartileView | null;
  reasoningTokens: number | null;
  cost: number | null;
  toolLookups: number;
  parseFailures: number;
  fallbacks: number;
  moveSelections: number;
  switchSelections: number;
  protectSelections: number;
  consecutiveProtects: number;
  spreadSelections: number;
  megaSelections: number;
  buildAttempts: number;
  leadChanges: number;
  bringChanges: number;
}

export interface LeagueFranchiseView {
  entrant: number;
  model: string;
  teamName: string;
  spent: number;
  budgetLeft: number;
  overallRecord: LeagueRecordView;
  roundRobinRecord: LeagueRecordView;
  finish: string;
  roster: LeagueRosterSlotView[];
  draftRoster: LeagueRosterSlotView[];
  stats: LeagueFranchiseStatsView;
}

export interface LeagueGameView {
  winner: number | null;
  turns: number;
}

export interface LeagueSeriesView {
  seriesIndex: number;
  seriesId: string;
  stage: 'roundrobin' | 'playoff';
  round: number;
  timestamp: string;
  sides: [number, number];
  score: [number, number];
  winner: number | null;
  turns: number;
  games: LeagueGameView[];
}

export interface LeagueTeambuildView {
  seriesIndex: number;
  entrant: number;
  opponent: number;
  brought: string[];
  sets: TeambuildSetView[];
  rationale: string;
  attempts: number;
}

export interface LeagueSpendView {
  decisions: number;
  tokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
}

/** One drafted Pokémon's season impact, from teambuilds plus replayed game logs. */
export interface LeagueUsageView {
  entrant: number;
  id: string;
  name: string;
  cost: number;
  pick: number | null;
  builds: number;
  seriesWins: number;
  seriesLosses: number;
  gamesFielded: number;
  gameWins: number;
  gameLosses: number;
  faints: number;
}

export interface LeagueDistributionView {
  speciesDrafted: number;
  speciesBuilt: number;
  speciesFielded: number;
  itemsUsed: number;
  topItems: Array<{ item: string; count: number }>;
}

export interface LeagueGameDecisionView {
  side: 0 | 1;
  turn: number;
  phase: string;
  selection: string[];
  action: string;
  rationale: string;
  notebook: string;
  fallback: boolean;
  automatic: boolean;
  latencyMs: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

export interface LeagueGameReflectionView {
  side: 0 | 1;
  result: 'won' | 'lost';
  summary: string;
  adjustment: string;
  notebook: string;
  fallback: boolean;
  seriesOver: boolean;
}

export interface LeagueGameResponse {
  runId: string;
  seriesIndex: number;
  seriesId: string;
  stage: 'roundrobin' | 'playoff';
  round: number;
  game: number;
  /** Game numbers with a stored log or logged decisions for this series, ascending. */
  games: number[];
  /** Winning entrant per entry of `games`, null while that game is unresolved. */
  gameWinners: Array<number | null>;
  sides: [number, number];
  teamNames: [string, string];
  winner: number | null;
  live: boolean;
  /** Battlefield state for a game still in progress; null once the game has a result. */
  snapshot: BattleSnapshot | null;
  log: BattleLogEntryView[];
  decisions: LeagueGameDecisionView[];
  reflections: LeagueGameReflectionView[];
}

export interface LeagueLiveSeriesView {
  seriesId: string;
  seriesIndex: number | null;
  stage: 'roundrobin' | 'playoff' | null;
  round: number | null;
  game: number;
  turn: number;
  decisions: number;
  sides: [number, number] | null;
}

export interface LeagueTradeWindowDecisionView {
  entrant: number;
  swaps: Array<{ drop: string; add: string }>;
  reasoning: string;
  fallback: boolean;
}

export interface LeagueTradeOfferView {
  from: number;
  to: number | null;
  give: string | null;
  get: string | null;
  message: string | null;
  accepted: boolean | null;
  offerReasoning: string;
  responseReasoning: string;
}

export interface LeagueTradeWindowView {
  afterWeek: number;
  complete: boolean;
  offers: LeagueTradeOfferView[];
  decisions: LeagueTradeWindowDecisionView[];
}

export interface LeagueSeasonReviewView {
  entrant: number;
  outcome: string;
  summary: string;
  didWell: string;
  didPoorly: string;
  wouldChange: string;
  fallback: boolean;
}

export interface LeagueResponse {
  runId: string;
  when: string;
  lastPlayed: string | null;
  board: string | null;
  format: string | null;
  budget: number | null;
  picksPerEntrant: number | null;
  weeks: number | null;
  playoffRounds: number;
  phase: LeaguePhase;
  week: number;
  champion: LeagueChampionView | null;
  draftOnly: boolean;
  live: boolean;
  liveSeries: LeagueLiveSeriesView[];
  tradeWindow: LeagueTradeWindowView | null;
  seasonReviews: LeagueSeasonReviewView[];
  franchises: LeagueFranchiseView[];
  series: LeagueSeriesView[];
  teambuilds: LeagueTeambuildView[];
  spend: LeagueSpendView;
  usage: LeagueUsageView[];
  distribution: LeagueDistributionView;
}

export interface QuartileView {
  median: number;
  p25: number;
  p75: number;
  max: number;
}

export interface ModeRecordView {
  mode: string;
  series: number;
  runs: Array<{ runId: string; when: string }>;
}

export interface LegacyObservationIndexResponse {
  id: string;
  providers: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  series: number;
  games: number;
  decisions: number;
  reflections: number;
  modes: ModeRecordView[];
}

export interface ImportRequest {
  row: Record<string, unknown>;
  logs?: Partial<Record<Pid, string>>;
  games?: Record<string, string>;
  runConfig?: Record<string, unknown>;
  pool?: {
    name: string;
    format: string;
    event?: Record<string, unknown>;
    spreads?: Record<string, unknown>;
    teams: Array<{ id: string; paste: string; seed?: number; source?: Record<string, unknown> }>;
  };
  league?: LeagueAssets;
}

export interface LeagueAssets {
  rosters?: unknown[];
  draft?: string;
  teambuild?: string;
  window?: Record<string, unknown>;
  season?: string;
}

export interface ImportResponse {
  imported: boolean;
  duplicate?: boolean;
  runId: string;
  seriesId: string;
  logs: Pid[];
  games?: string[];
  pool: 'created' | 'present' | null;
  league: string[];
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

export interface ResearchValidationView {
  status: 'valid' | 'invalid';
  scope: 'public-artifacts-only';
  errors: string[];
}

export interface ResearchTaskActionView {
  number: number;
  canonicalAction: string;
  label: string;
}

export interface ResearchTaskView {
  taskId: string;
  format: string;
  split: 'pilot' | 'train' | 'eval';
  phase: 'team_preview' | 'forced_switch' | 'turn';
  turn: number;
  prompt: string;
  promptTruncated: boolean;
  actionCount: number;
  actions: ResearchTaskActionView[];
}

export interface ResearchProtocolsView {
  schemaVersion: number;
  action: Record<string, unknown>;
  task: Record<string, unknown>;
  counterfactual: Record<string, unknown>;
  exhaustivePanels: Record<string, unknown>;
  canonicalJson: Record<string, unknown>;
  nearDuplicates: Record<string, unknown> | null;
  eligibilityMetricsVersion: number;
}

export interface ResearchRuntimeView {
  node: string;
  platform: string;
  arch: string;
}

export interface ResearchProvenanceView {
  sourceSetId: string;
  calibrationSourceSetId: string | null;
  manifestSha256: string;
  upstreamPilotManifestSha256: string | null;
  upstreamCalibrationManifestSha256: string | null;
  evaluatorDigest: string;
  splitterDigest: string | null;
  showdownCommit: string;
  seedNamespace: string;
  policyId: string | null;
  runtime: ResearchRuntimeView;
}

export interface ResearchCountsView {
  input: number;
  eligible: number | null;
  excluded: number | null;
  train: number | null;
  eval: number | null;
  sourceGroups: number | null;
  duplicateClusters: number | null;
  nearDuplicatePairs: number | null;
}

export interface ResearchSplitBalanceStratumView {
  total: number;
  eval: number;
  evalFraction: number;
  deviation: number;
}

export interface ResearchSplitBalanceView {
  evalFraction: number;
  evalFractionDeviation: number;
  strata: Record<string, ResearchSplitBalanceStratumView>;
  maxStratumDeviation: number;
}

export interface ResearchArtifactView {
  kind: 'pilot' | 'frozen';
  schemaVersion: number | null;
  releaseReady: boolean | null;
  status: string;
  validation: ResearchValidationView;
  protocols: ResearchProtocolsView | null;
  provenance: ResearchProvenanceView | null;
  releaseGates: string[];
  counts: ResearchCountsView | null;
  splitBalance: ResearchSplitBalanceView | null;
  taskPreviewAvailability: 'available' | 'withheld' | 'unavailable';
  taskPreviewReason: string | null;
  taskTotal: number;
  taskPreviewCount: number;
  tasks: ResearchTaskView[];
}

export interface ResearchLimitsView {
  taskPreviews: number;
  promptCharacters: number;
  actionsPerTask: number;
  actionLabelCharacters: number;
  artifactRows: number;
  manifestBytes: number;
  taskBytes: number;
}

export interface ResearchProgramView {
  positions: {
    target: 'vgc-positions-v1';
    stage: 'not-generated' | 'pilot' | 'candidate' | 'invalid';
  };
  draftCircuit: {
    target: 'vgc-draft-circuit-v1';
    stage: 'design';
  };
}

export interface ResearchLegacyPositionsView {
  present: boolean;
  rows: number;
  manifestBound: false;
  displayPolicy: 'inventory-only';
}

export interface ResearchResponse {
  schemaVersion: 1;
  status: 'empty' | 'ready' | 'degraded';
  program: ResearchProgramView;
  legacyPositions: ResearchLegacyPositionsView;
  artifacts: ResearchArtifactView[];
  errors: string[];
  warnings: string[];
  limits: ResearchLimitsView;
}
