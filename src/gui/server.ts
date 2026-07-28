import { fork } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeague, buildLeagueGame, buildLeagues, buildModelProfile } from '../archive.js';
import type { AuthService, AuthSession, AuthUser } from '../auth.js';
import { AuthError } from '../auth.js';
import { describeBoardMon, listBoards, loadBoard } from '../draft.js';
import type { DraftLeagueEvent } from '../draftleague.js';
import { DRAFT_PROTOCOL_VERSION, runDraftLeague } from '../draftleague.js';
import { buildEvidence, buildTournaments } from '../evidence.js';
import { ImportError, importSeries, isImported } from '../import.js';
import { discoverModels } from '../model-catalog.js';
import { DATA_DIR, makeRunDirectory, prepareDataDirectories, RESULTS_PATH, RUNS_DIR, TEAMS_DIR } from '../paths.js';
import { PROVIDER_OPTIONS, providerOption } from '../provider-registry.js';
import type { ModelReasoningConfig, ReasoningLevel } from '../providers.js';
import {
  classifyProviderFailure,
  parseSpec,
  REASONING_LEVELS,
  reasoningLevels,
  validateReasoning,
} from '../providers.js';
import { loadRows, ratingGroups, scopeRows } from '../records.js';
import type { RecoveryPause } from '../recovery.js';
import { RecoveryGate } from '../recovery.js';
import { ROTATION_PROTOCOL_VERSION, runRotation } from '../rotation.js';
import { writeRunStatus } from '../run-status.js';
import { redactSecrets } from '../sanitize.js';
import { loadShowdown } from '../showdown.js';
import type { MonState } from '../state.js';
import { BattleState } from '../state.js';
import type { Team, TeamDraft } from '../teams.js';
import { createPool, inspectTeam, listPools, loadPool, packTeam, validateTeam } from '../teams.js';
import { parseTimerScale } from '../timer.js';
import { runTournament, TOURNAMENT_PROTOCOL_VERSION } from '../tournament.js';
import type { ExperimentMode, JsonObject, Pid, TimerScale } from '../types.js';
import { afterColon, isRecord } from '../value.js';
import type {
  AppState,
  BattleMessage,
  BattleSnapshot,
  BoardResponse,
  BracketView,
  DecisionView,
  DraftView,
  EvidenceResponse,
  FormatInfo,
  ImportRequest,
  ModelInfo,
  ModelsResponse,
  MonView,
  PoolTeamsResponse,
  RecordsResponse,
  RunPauseView,
  RunSnapshot,
  SampleTeam,
  SeriesRowView,
  ServerEvent,
  TournamentsResponse,
} from './api.js';
import { BattleLog } from './battlelog.js';
import type { RunWorkerInput, RunWorkerOutput, RunWorkerStart } from './run-worker-protocol.js';

type SeriesRow = Omit<SeriesRowView, 'turn'>;

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gui');
const RUN_WORKER_PATH = fileURLToPath(new URL('./run-worker.js', import.meta.url));
const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const LOCAL_HOSTNAMES: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true, '::1': true };
const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };
const SESSION_COOKIE = 'vgc_session';
const OAUTH_STATE_COOKIE = 'vgc_oauth_state';
const MAX_PUBLIC_SSE_CLIENTS = 32;
const MAX_FALLBACK_SSE_CLIENTS = 16;
const MAX_CONTROLLER_SSE_CLIENTS = 16;
const MAX_SSE_CLIENTS_PER_SESSION = 2;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_RATE_BUCKETS = 4096;
const DEFAULT_MAX_RUN_MS = 4 * 60 * 60 * 1000;
const SHUTDOWN_ERROR = 'run interrupted by server shutdown';
const TIMEOUT_ERROR = 'run exceeded its maximum duration';

interface GuiServerOptions {
  teamsDir?: string;
  recordsPath?: string;
  runsDir?: string;
  runner?: typeof runRotation;
  tournamentRunner?: typeof runTournament;
  draftRunner?: typeof runDraftLeague;
  host?: string;
  publicOrigin?: string;
  mutationsEnabled?: boolean;
  auth?: AuthService;
  importToken?: string;
  logger?: (entry: Record<string, unknown>) => void;
  maxRunMs?: number;
  workerPath?: string;
  workerStopGraceMs?: number;
  /** How long a stopped run's task may keep running before it is detached so new runs can start. */
  stopFallbackMs?: number;
}

function hostnameFromHost(host: string | undefined): string {
  if (!host || /[\s,@/\\]/.test(host)) return '';
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function configuredOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) {
    throw new Error('VGC_LEAGUE_PUBLIC_ORIGIN must be an exact http(s) origin without a path');
  }
  return url;
}

function requestCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return result;
}

function responseCookie(name: string, value: string, maxAge: number, cookiePath: string, secure: boolean): string {
  return `${name}=${value}; Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

interface EventViewer {
  sessionToken: string | undefined;
  publicOnly: boolean;
  backpressured: boolean;
}

interface PendingServerEvent {
  privateEvent: ServerEvent;
  publicEvent: ServerEvent;
}

interface RunConfig extends ModelReasoningConfig {
  mode: ExperimentMode;
  protocolVersion: number;
  models: string[];
  seriesPerPair: number;
  pool: string;
  concurrency: number;
  teams?: Team[];
  format?: string;
  board?: string;
  seed?: number;
  timerScale?: TimerScale;
}

function isActiveRunState(state: RunSnapshot['state']): state is 'running' | 'paused' {
  return state === 'running' || state === 'paused';
}

interface GameBattle {
  state: BattleState;
  log: BattleLog;
}

function gameParam(url: URL): number | undefined {
  const raw = url.searchParams.get('game');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function latestBattle(games: Map<number, GameBattle> | undefined): { game: number; entry: GameBattle } | null {
  if (!games?.size) return null;
  const game = Math.max(...games.keys());
  return { game, entry: games.get(game) as GameBattle };
}

class ActiveRun {
  rows: SeriesRow[] = [];
  bracket: BracketView | undefined;
  draft: DraftView | undefined;
  pause: RunPauseView | undefined;
  state: RunSnapshot['state'] = 'running';
  error = '';
  notices: string[] = [];
  seed: number | undefined;
  endTime: number | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  timeoutRemainingMs = 0;
  timeoutStartedAt: number | undefined;
  stopFallbackTimer: NodeJS.Timeout | undefined;
  timedOut = false;
  interrupted = false;
  userStopped = false;
  settling = false;
  detached = false;
  readonly battles = new Map<number, Map<number, GameBattle>>();
  readonly publicBattles = new Map<number, Map<number, GameBattle>>();
  readonly decisions = new Map<number, DecisionView[]>();
  readonly spend = new Map<number, Record<Pid, { ms: number; tokens: number }>>();
  readonly battleRevisions = new Map<number, number>();
  readonly controller = new AbortController();
  readonly recovery = new RecoveryGate();
  resumeAction: (() => void) | undefined;
  readonly runDir: string;
  readonly runId: string;
  readonly startTime = Date.now();

  constructor(
    readonly config: RunConfig,
    readonly apiKeys: Record<string, string>,
    readonly owner: AuthUser | undefined,
    runsDir?: string,
  ) {
    this.runDir = makeRunDirectory(runsDir);
    this.runId = path.basename(this.runDir);
  }

  clearApiKeys(): void {
    for (const model of Object.keys(this.apiKeys)) delete this.apiKeys[model];
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const spriteIds = new Map<string, string>();

function spriteIdFor(species: string): string {
  const cached = spriteIds.get(species);
  if (cached !== undefined) return cached;
  const { Dex } = loadShowdown();
  const resolved = Dex.mod('champions').species.get(species);
  const id = resolved.exists ? resolved.spriteid : '';
  spriteIds.set(species, id);
  return id;
}

function snapshotMon(battle: BattleState, pid: Pid, mon: MonState): MonView {
  const boosts = Object.entries(mon.boosts)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat} ${value > 0 ? '+' : ''}${value}`)
    .join(', ');
  const target = mon.lastMove?.target ? ` → ${afterColon(mon.lastMove.target)}` : '';
  const volatiles = [...mon.volatiles]
    .map((volatile) => (/^perish(\d)$/i.test(volatile) ? `Perish ${volatile.slice(-1)}` : volatile))
    .sort()
    .join(', ');
  return {
    species: mon.species,
    spriteId: spriteIdFor(mon.species),
    slot: battle.activeSlot(pid, mon)?.toUpperCase() ?? '',
    hp: mon.fainted ? 'fainted' : (mon.hp ?? ''),
    status: mon.fainted ? '' : (mon.status ?? ''),
    fainted: mon.fainted,
    boosts,
    volatiles,
    lastMove: mon.lastMove ? `${mon.lastMove.name}${target} · T${mon.lastMove.turn}` : '',
  };
}

function snapshotBattle(
  battle: BattleState,
  players: Record<Pid, string> | undefined,
  log: BattleLog,
  decisions: DecisionView[] = [],
  spend?: Record<Pid, { ms: number; tokens: number }>,
): BattleSnapshot {
  const side = (pid: Pid) => ({
    player: players?.[pid] ?? pid,
    conditions: battle.conditionLabels(pid),
    mons: battle.visibleMons(pid).map((mon) => snapshotMon(battle, pid, mon)),
  });
  const timerView = (pid: Pid) => {
    const timer = battle.timers[pid];
    if (!timer) return null;
    const drained = timer.running ? (Date.now() - timer.at) / 1000 : 0;
    const remaining = (value: number | null) => (value === null ? null : Math.max(0, Math.round(value - drained)));
    return {
      seconds: remaining(timer.seconds),
      turnSeconds: remaining(timer.turnSeconds),
      elapsedSeconds: timer.running ? Math.max(0, Math.floor(drained)) : null,
      running: timer.running,
    };
  };
  const spendView = (pid: Pid) => ({
    seconds: Math.round((spend?.[pid]?.ms ?? 0) / 1000),
    tokens: spend?.[pid]?.tokens ?? 0,
  });
  return {
    turn: battle.turn,
    weather: battle.weatherLabel(),
    fields: battle.fieldLabels(),
    sides: { p1: side('p1'), p2: side('p2') },
    timers: { p1: timerView('p1'), p2: timerView('p2') },
    spend: { p1: spendView('p1'), p2: spendView('p2') },
    log: log.entries,
    decisions,
  };
}

function championsFormats(): FormatInfo[] {
  const { Dex } = loadShowdown();
  return Dex.formats
    .all()
    .filter((format) => format.id.startsWith('gen9champions') && format.id.endsWith('bo3'))
    .map((format) => ({ id: format.id, label: format.name.replace(/^\[Gen 9 Champions\] /, '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export class GuiServer {
  readonly server: http.Server;
  private run: ActiveRun | undefined;
  private runTask: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;
  private readonly clients = new Map<http.ServerResponse, EventViewer>();
  private readonly pending = new Map<string, () => PendingServerEvent | undefined>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly options: GuiServerOptions;
  private readonly publicOrigin: URL | undefined;
  private readonly bindHost: string;
  private readonly maxRunMs: number;
  private readonly workerStopGraceMs: number;
  private readonly stopFallbackMs: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sampleTeamsCache: { pool: string; teams: SampleTeam[] } | undefined;

  constructor(options: GuiServerOptions = {}) {
    this.options = options;
    this.publicOrigin = configuredOrigin(options.publicOrigin);
    this.bindHost = options.host?.trim() || (this.publicOrigin ? '0.0.0.0' : '127.0.0.1');
    this.maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    if (!Number.isSafeInteger(this.maxRunMs) || this.maxRunMs < 1) {
      throw new Error('maxRunMs must be a positive integer');
    }
    this.workerStopGraceMs = options.workerStopGraceMs ?? 5_000;
    if (!Number.isSafeInteger(this.workerStopGraceMs) || this.workerStopGraceMs < 1) {
      throw new Error('workerStopGraceMs must be a positive integer');
    }
    this.stopFallbackMs = options.stopFallbackMs ?? 15_000;
    if (!Number.isSafeInteger(this.stopFallbackMs) || this.stopFallbackMs < 1) {
      throw new Error('stopFallbackMs must be a positive integer');
    }
    const bindHostname = hostnameFromHost(this.bindHost);
    if (!this.publicOrigin && !LOCAL_HOSTNAMES[bindHostname]) {
      throw new Error('a non-loopback host requires VGC_LEAGUE_PUBLIC_ORIGIN');
    }
    prepareDataDirectories();
    this.server = createServer((request, response) => {
      const requestId = randomUUID();
      const started = Date.now();
      response.setHeader('x-request-id', requestId);
      response.setHeader(
        'content-security-policy',
        "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      );
      response.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      if (this.publicOrigin?.protocol === 'https:') {
        response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
      }
      response.once('finish', () => {
        this.options.logger?.({
          timestamp: new Date().toISOString(),
          level: 'info',
          event: 'http_request',
          requestId,
          method: request.method ?? 'UNKNOWN',
          path: request.url?.split('?', 1)[0] ?? '/',
          status: response.statusCode,
          durationMs: Date.now() - started,
        });
      });
      void this.route(request, response).catch((error: unknown) => {
        const expected = error instanceof HttpError || error instanceof AuthError;
        const status = expected ? error.status : 500;
        const detail = redactSecrets(
          error instanceof Error ? error.message : String(error),
          Object.values(this.run?.apiKeys ?? {}),
        );
        if (!expected) {
          this.options.logger?.({
            timestamp: new Date().toISOString(),
            level: 'error',
            event: 'request_error',
            requestId,
            error: detail,
          });
        }
        const message = expected ? detail : `internal server error (${requestId})`;
        if (error instanceof HttpError && error.retryAfterSeconds !== undefined) {
          response.setHeader('retry-after', String(error.retryAfterSeconds));
        }
        if (!response.headersSent) this.json(response, status, { error: message });
        else response.end();
      });
    });
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 100;
  }

  listen(port: number): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.server.once('error', reject);
    this.server.listen(port, this.bindHost, () => {
      const address = this.server.address() as AddressInfo;
      const localHost = hostnameFromHost(this.bindHost) === '::1' ? '[::1]' : '127.0.0.1';
      resolve(this.publicOrigin ? `${this.publicOrigin.origin}/` : `http://${localHost}:${address.port}/`);
    });
    return promise;
  }

  close(): void {
    void this.shutdown(0);
  }

  shutdown(graceMs = 10_000): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shutdownTask = (async () => {
      const run = this.run;
      if (run && isActiveRunState(run.state) && !run.settling) {
        run.interrupted = true;
        run.controller.abort();
      }
      clearTimeout(this.flushTimer);
      clearInterval(this.heartbeatTimer);
      for (const client of this.clients.keys()) client.end();
      this.clients.clear();
      const closed = Promise.withResolvers<void>();
      this.server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      const settled = this.runTask
        ? Promise.allSettled([closed.promise, this.runTask]).then(() => undefined)
        : closed.promise;
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, Math.max(0, graceMs));
      await Promise.race([settled, timeout.promise]);
      clearTimeout(timer);
      if (run && isActiveRunState(run.state)) this.detachRun(run, 'failed', SHUTDOWN_ERROR);
      this.server.closeAllConnections();
    })();
    return this.shutdownTask;
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? '';
    const key = `${method} ${url.pathname}`;
    if (key === 'GET /healthz') {
      this.json(response, 200, { status: 'ok' });
      return;
    }
    if (key === 'GET /readyz') {
      this.ready(response);
      return;
    }

    const host = request.headers.host;
    const hostAllowed = this.publicOrigin
      ? host?.toLowerCase() === this.publicOrigin.host.toLowerCase()
      : Boolean(LOCAL_HOSTNAMES[hostnameFromHost(host)]);
    if (!hostAllowed) throw new HttpError(403, 'request host is not allowed');

    const cookies = requestCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE];
    const session = this.options.auth?.session(sessionToken);
    if (key === 'GET /auth/github') {
      if (!this.options.auth) throw new HttpError(404, 'GitHub login is not configured');
      this.consumeRateLimit('oauth', request.socket.remoteAddress ?? 'unknown', 20, 10 * 60_000);
      const login = this.options.auth.beginLogin();
      this.redirect(response, login.location, [
        responseCookie(
          OAUTH_STATE_COOKIE,
          login.state,
          600,
          '/auth/github/callback',
          this.publicOrigin?.protocol === 'https:',
        ),
      ]);
      return;
    }
    if (key === 'GET /auth/github/callback') {
      if (!this.options.auth) throw new HttpError(404, 'GitHub login is not configured');
      if (url.searchParams.has('error')) {
        this.redirect(response, '/?auth=denied', [
          responseCookie(OAUTH_STATE_COOKIE, '', 0, '/auth/github/callback', this.publicOrigin?.protocol === 'https:'),
        ]);
        return;
      }
      const result = await this.options.auth.completeLogin(
        url.searchParams.get('code') ?? '',
        url.searchParams.get('state') ?? '',
        cookies[OAUTH_STATE_COOKIE],
        sessionToken,
      );
      this.redirect(response, '/', [
        responseCookie(
          SESSION_COOKIE,
          result.sessionToken,
          7 * 24 * 60 * 60,
          '/',
          this.publicOrigin?.protocol === 'https:',
        ),
        responseCookie(OAUTH_STATE_COOKIE, '', 0, '/auth/github/callback', this.publicOrigin?.protocol === 'https:'),
      ]);
      return;
    }

    if (key === 'POST /api/import') {
      this.authorizeImport(request);
      this.consumeRateLimit('import', 'operator', 600, 60 * 60_000);
      this.json(response, 200, this.importBody(await this.readJson(request)));
      return;
    }

    let actor: AuthUser | undefined;
    if (MUTATING_METHODS[method]) {
      const origin = request.headers.origin;
      const expectedOrigin = this.publicOrigin?.origin ?? `http://${host}`;
      if ((this.publicOrigin && origin !== expectedOrigin) || (origin !== undefined && origin !== expectedOrigin)) {
        throw new HttpError(403, 'cross-origin requests are not allowed');
      }
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        throw new HttpError(415, 'content-type must be application/json');
      }
      if (this.options.auth) {
        const minimumRole = key === 'POST /api/logout' ? 'reader' : 'contributor';
        actor = this.options.auth.authorize(
          sessionToken,
          typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined,
          minimumRole,
        ).user;
      } else if (
        this.options.mutationsEnabled === false ||
        (this.publicOrigin && this.options.mutationsEnabled !== true)
      ) {
        throw new HttpError(503, 'mutations are disabled until deployment authentication is configured');
      }
    }
    if (MUTATING_METHODS[method] && this.publicOrigin) {
      const subject = actor ? `user:${actor.id}` : `network:${request.socket.remoteAddress ?? 'unknown'}`;
      if (key === 'POST /api/models') this.consumeRateLimit('models', subject, 30, 60_000);
      else if (key === 'POST /api/team/validate') this.consumeRateLimit('validation', subject, 60, 60_000);
      else if (key === 'POST /api/team/pokepaste') this.consumeRateLimit('pokepaste', subject, 30, 60_000);
      else if (key === 'POST /api/pool') this.consumeRateLimit('pool', subject, 10, 60 * 60_000);
      else if (key === 'POST /api/run') this.consumeRateLimit('run', subject, 6, 60 * 60_000);
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/') && this.serveStatic(url.pathname, response)) return;
    if (key === 'GET /api/state') this.json(response, 200, this.stateBody(session));
    else if (key === 'GET /api/records') this.json(response, 200, this.recordsBody(url.searchParams.get('pool')));
    else if (key === 'GET /api/evidence') this.json(response, 200, this.evidenceBody(url.searchParams.get('pool')));
    else if (key === 'GET /api/tournaments')
      this.json(response, 200, this.tournamentsBody(url.searchParams.get('pool')));
    else if (key === 'GET /api/leagues') this.json(response, 200, this.leaguesBody());
    else if (key === 'GET /api/league') this.json(response, 200, this.leagueBody(url.searchParams.get('run') ?? ''));
    else if (key === 'GET /api/league/game')
      this.json(
        response,
        200,
        this.leagueGameBody(
          url.searchParams.get('run') ?? '',
          url.searchParams.get('series') ?? '',
          url.searchParams.get('game') ?? '',
        ),
      );
    else if (key === 'GET /api/model') this.json(response, 200, this.modelBody(url.searchParams.get('id') ?? ''));
    else if (key === 'GET /api/board') {
      this.json(response, 200, this.boardBody(url.searchParams.get('id') ?? ''));
    } else if (key === 'GET /api/pool/teams') {
      this.json(response, 200, this.poolTeamsBody(url.searchParams.get('name') ?? ''));
    } else if (key === 'GET /api/reasoning') {
      this.json(response, 200, this.reasoningBody(url.searchParams.get('spec') ?? ''));
    } else if (key === 'GET /api/events/public') {
      this.openEvents(response, undefined, true);
    } else if (key === 'GET /api/events') {
      this.requireAuthenticatedViewer(session);
      this.openEvents(response, sessionToken, false);
    } else if (key === 'GET /api/battle/public') {
      this.json(response, 200, this.battleBody(Number(url.searchParams.get('index')), true, gameParam(url)));
    } else if (key === 'GET /api/battle') {
      this.requireAuthenticatedViewer(session);
      this.json(
        response,
        200,
        this.battleBody(Number(url.searchParams.get('index')), !this.canViewPrivateRun(session?.user), gameParam(url)),
      );
    } else if (key === 'POST /api/logout') {
      this.options.auth?.logout(
        sessionToken,
        typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined,
      );
      response.setHeader(
        'set-cookie',
        responseCookie(SESSION_COOKIE, '', 0, '/', this.publicOrigin?.protocol === 'https:'),
      );
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/models') {
      const body = await this.readJson(request);
      const provider = String(body.provider ?? '');
      const result = await this.modelsBody(provider, String(body.apiKey ?? ''));
      if (actor && this.options.auth) this.options.auth.recordModelDiscovery(actor, provider);
      this.json(response, 200, result);
    } else if (key === 'POST /api/run') {
      this.json(response, 200, this.startRun(await this.readJson(request), actor));
    } else if (key === 'POST /api/run/stop') {
      const run = this.run;
      if (run && isActiveRunState(run.state) && !run.settling) {
        if (actor && this.options.auth) this.options.auth.stopExperiment(actor, run.runId);
        run.userStopped = true;
        run.controller.abort();
        this.scheduleStopFallback(run);
      }
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/run/resume') {
      const run = this.run;
      if (run?.state !== 'paused' || run.settling) throw new HttpError(409, 'the run is not paused');
      if (!this.controlsCurrentRun(actor)) throw new HttpError(403, 'you cannot resume this run');
      run.resumeAction?.();
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/pool') {
      this.json(response, 200, this.makePool(await this.readJson(request), actor));
    } else if (key === 'POST /api/team/validate') {
      const body = await this.readJson(request);
      const result = this.validateDraft(body);
      if (actor && this.options.auth) this.options.auth.recordValidation(actor, String(body.format ?? ''));
      this.json(response, 200, result);
    } else if (key === 'POST /api/team/pokepaste') {
      this.json(response, 200, await this.importPokepaste(await this.readJson(request)));
    } else this.json(response, 404, { error: `no route for ${key}` });
  }

  private consumeRateLimit(scope: string, subject: string, maximum: number, windowMs: number): void {
    const now = Date.now();
    const key = `${scope}:${subject}`;
    let bucket = this.rateBuckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.rateBuckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.rateBuckets.size >= MAX_RATE_BUCKETS) {
        for (const [candidate, value] of this.rateBuckets) {
          if (value.resetAt <= now) this.rateBuckets.delete(candidate);
        }
      }
      if (this.rateBuckets.size >= MAX_RATE_BUCKETS) {
        throw new HttpError(429, 'request rate limit exceeded', 60);
      }
      this.rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (bucket.count >= maximum) {
      throw new HttpError(429, 'request rate limit exceeded', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
    }
    bucket.count += 1;
  }
  private redirect(response: http.ServerResponse, location: string, cookies: string[]): void {
    response.writeHead(302, {
      'cache-control': 'no-store',
      location,
      ...(cookies.length ? { 'set-cookie': cookies } : {}),
    });
    response.end();
  }

  private requireAuthenticatedViewer(session: AuthSession | undefined): void {
    if (this.options.auth) {
      if (!session) throw new HttpError(401, 'authentication required');
      return;
    }
    if (this.publicOrigin && this.options.mutationsEnabled !== true) {
      throw new HttpError(403, 'private run data is unavailable');
    }
  }

  private canViewPrivateRun(user: AuthUser | undefined): boolean {
    if (!this.options.auth) return !this.publicOrigin || this.options.mutationsEnabled === true;
    if (!user) return false;
    return !this.run || user.role === 'operator' || this.run.owner?.id === user.id;
  }

  private eventViewerUser(viewer: EventViewer): AuthUser | undefined {
    if (viewer.publicOnly) return undefined;
    return this.options.auth?.session(viewer.sessionToken)?.user;
  }

  private controlsCurrentRun(user: AuthUser | undefined): boolean {
    if (!this.options.auth) return !this.publicOrigin || this.options.mutationsEnabled === true;
    return Boolean(this.run && user && (user.role === 'operator' || this.run.owner?.id === user.id));
  }

  private json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(body));
  }

  private ready(response: http.ServerResponse): void {
    try {
      fs.accessSync(path.join(ASSETS_DIR, 'index.html'), fs.constants.R_OK);
      fs.accessSync(this.options.teamsDir ?? TEAMS_DIR, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(path.dirname(this.options.recordsPath ?? RESULTS_PATH), fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
      if (!listBoards().length) throw new Error('no valid draft boards are installed');
      loadShowdown();
      this.options.auth?.ready();
      this.json(response, 200, { status: 'ready' });
    } catch (error) {
      this.options.logger?.({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'readiness_check_failed',
        error: redactSecrets(error instanceof Error ? error.message : String(error), []),
      });
      this.json(response, 503, { status: 'not_ready' });
    }
  }

  private serveStatic(pathname: string, response: http.ServerResponse): boolean {
    const file = path.normalize(path.join(ASSETS_DIR, pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ASSETS_DIR + path.sep)) return false;
    const type = ASSET_TYPES[path.extname(file)];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const immutable = pathname.startsWith('/sprites/');
    response.writeHead(200, {
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-type': type,
    });
    response.end(fs.readFileSync(file));
    return true;
  }

  private async readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 2_000_000) throw new HttpError(413, 'request body too large');
      chunks.push(chunk as Buffer);
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'request body must be JSON');
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return data as Record<string, unknown>;
  }

  private defaultFormatId(): string {
    return listPools(this.options.teamsDir ?? TEAMS_DIR)[0]?.format ?? 'gen9championsvgc2026regmbbo3';
  }

  private sampleTeamsBody(pools: { name: string }[]): SampleTeam[] {
    const source = pools[0]?.name;
    if (!source) return [];
    if (this.sampleTeamsCache?.pool !== source) {
      try {
        const { Teams } = loadShowdown();
        const teams = loadPool(source, this.options.teamsDir ?? TEAMS_DIR).teams.slice(0, 2);
        this.sampleTeamsCache = {
          pool: source,
          teams: teams.map((team) => ({ name: team.id, paste: Teams.export(Teams.unpack(team.packed) ?? []) })),
        };
      } catch {
        this.sampleTeamsCache = { pool: source, teams: [] };
      }
    }
    return this.sampleTeamsCache.teams;
  }

  private modelInfo(providerId: string, model: { id: string; displayName?: string }): ModelInfo {
    return {
      id: model.id,
      label: model.displayName ?? model.id,
      reasoningLevels: reasoningLevels(parseSpec(`${providerId}:${model.id}`)),
    };
  }

  private reasoningBody(value: string): { levels: ReasoningLevel[] } {
    try {
      const spec = parseSpec(value);
      if (this.publicOrigin && spec.provider === 'compat') {
        throw new Error('OpenAI-compatible custom endpoints are disabled in hosted mode');
      }
      return { levels: reasoningLevels(spec) };
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  private stateBody(session: AuthSession | undefined): AppState {
    const pools = listPools(this.options.teamsDir ?? TEAMS_DIR);
    return {
      pools,
      reasoningLevels: [...REASONING_LEVELS],
      defaultFormat: pools[0]?.format ?? 'gen9championsvgc2026regmbbo3',
      formats: championsFormats(),
      sampleTeams: this.sampleTeamsBody(pools),
      boards: listBoards(),
      providers: PROVIDER_OPTIONS.filter((option) => !this.publicOrigin || option.id !== 'compat').map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        discovery: option.discovery,
        requiresKey: option.requiresKey,
        models: (option.models ?? []).map((model) => this.modelInfo(option.id, model)),
      })),
      auth: this.options.auth
        ? {
            mode: 'github',
            user: session
              ? {
                  login: session.user.login,
                  avatarUrl: session.user.avatarUrl,
                  role: session.user.role,
                }
              : null,
            csrfToken: session?.csrfToken ?? null,
          }
        : { mode: this.publicOrigin ? 'read-only' : 'local', user: null, csrfToken: null },
      run: this.runBody(!this.canViewPrivateRun(session?.user)),
    };
  }

  private boardBody(id: string): BoardResponse {
    if (!listBoards().some((entry) => entry.id === id)) {
      throw new HttpError(400, `unknown draft board ${JSON.stringify(id)}`);
    }
    const board = loadBoard(id);
    return {
      id: board.id,
      format: board.format,
      budget: board.budget,
      picks: board.picks,
      mons: board.mons.map((mon) => describeBoardMon(mon, undefined, board.format)),
    };
  }

  private poolTeamsBody(name: string): PoolTeamsResponse {
    const teamsDir = this.options.teamsDir ?? TEAMS_DIR;
    if (!listPools(teamsDir).some((entry) => entry.name === name)) {
      throw new HttpError(400, `unknown team pool ${JSON.stringify(name)}`);
    }
    const { Teams } = loadShowdown();
    const pool = loadPool(name, teamsDir);
    return {
      name: pool.id,
      format: pool.format,
      teams: pool.teams.map((team) => {
        const unpacked = Teams.unpack(team.packed);
        if (!unpacked) throw new Error(`stored team ${JSON.stringify(team.id)} is invalid`);
        return { name: team.id, paste: Teams.export(unpacked) };
      }),
    };
  }

  private recordsBody(poolParam: string | null): RecordsResponse {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const pool = poolParam?.trim() || null;
    const rows = scopeRows(all, pool ?? undefined);
    const rated = rows.filter((row) => (row.mode ?? 'rotation') === 'rotation');
    const pools = [...new Set(all.map((row) => (typeof row.pool === 'string' ? row.pool : '')))].filter(Boolean).sort();
    const groups = ratingGroups(rated);
    return { count: rows.length, pool, pools, groups, imported: rows.filter(isImported).length };
  }

  private authorizeImport(request: http.IncomingMessage): void {
    const configured = this.options.importToken;
    if (!configured) throw new HttpError(404, 'this deployment does not accept imports');
    const header = request.headers.authorization ?? '';
    const offered = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const expected = createHash('sha256').update(configured).digest();
    const received = createHash('sha256').update(offered).digest();
    if (!offered || !timingSafeEqual(expected, received)) throw new HttpError(401, 'invalid import token');
  }

  private importBody(body: Record<string, unknown>): JsonObject {
    try {
      const result = importSeries(body as unknown as ImportRequest, {
        recordsPath: this.options.recordsPath ?? RESULTS_PATH,
        runsDir: this.options.runsDir ?? RUNS_DIR,
        teamsDir: this.options.teamsDir ?? TEAMS_DIR,
      });
      this.options.logger?.({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'series_imported',
        run: result.runId,
        series: result.seriesId,
        imported: result.imported,
      });
      return result as unknown as JsonObject;
    } catch (error) {
      if (error instanceof ImportError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  private evidenceBody(poolParam: string | null): EvidenceResponse {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const pool = poolParam?.trim() || null;
    return buildEvidence(all, this.options.runsDir ?? RUNS_DIR, pool);
  }

  private tournamentsBody(poolParam: string | null): TournamentsResponse {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const pool = poolParam?.trim() || null;
    return buildTournaments(all, this.options.runsDir ?? RUNS_DIR, pool);
  }

  private leaguesBody(): JsonObject {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    return buildLeagues(all, this.options.runsDir ?? RUNS_DIR) as unknown as JsonObject;
  }

  private leagueBody(run: string): JsonObject {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const league = buildLeague(all, this.options.runsDir ?? RUNS_DIR, run.trim());
    if (!league) throw new HttpError(404, `no stored draft league ${JSON.stringify(run)}`);
    return league as unknown as JsonObject;
  }

  private leagueGameBody(run: string, series: string, game: string): JsonObject {
    const seriesIndex = Number(series);
    const gameNumber = Number(game);
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || !Number.isInteger(gameNumber) || gameNumber < 1) {
      throw new HttpError(400, 'series and game must be non-negative integers');
    }
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const view = buildLeagueGame(all, this.options.runsDir ?? RUNS_DIR, run.trim(), seriesIndex, gameNumber);
    if (!view) throw new HttpError(404, `no stored game ${game} for series ${series} of ${JSON.stringify(run)}`);
    return view as unknown as JsonObject;
  }

  private modelBody(id: string): JsonObject {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const profile = buildModelProfile(all, this.options.runsDir ?? RUNS_DIR, id.trim());
    if (!profile) throw new HttpError(404, `no recorded series for model ${JSON.stringify(id)}`);
    return profile as unknown as JsonObject;
  }

  private runBody(publicView = false): RunSnapshot | null {
    const run = this.run;
    if (!run) return null;
    const battles = publicView ? run.publicBattles : run.battles;
    return {
      mode: run.config.mode,
      protocolVersion: run.config.protocolVersion,
      runId: run.runId,
      state: run.state,
      error: publicView && run.error ? 'run failed' : run.error,
      pause: run.pause ?? null,
      notices: publicView ? [] : run.notices.slice(-3),
      seed: run.seed ?? null,
      pool: run.config.pool,
      models: run.config.models,
      startTime: run.startTime,
      owner: run.owner?.login ?? null,
      endTime: run.endTime ?? null,
      canControl: !publicView && !run.settling,
      rows: run.rows.map((row, index) => ({
        ...row,
        turn: latestBattle(battles.get(index))?.entry.state.turn ?? 0,
      })),
      bracket: run.bracket ?? null,
      draft: run.draft ?? null,
      board: run.config.board ?? null,
    };
  }

  private battleBody(index: number, publicView = false, game?: number): BattleMessage {
    const games = (publicView ? this.run?.publicBattles : this.run?.battles)?.get(index);
    const latest = latestBattle(games);
    if (!games || !latest) return { index, game: 0, games: [], revision: 0, snapshot: null };
    const shown = game !== undefined && games.has(game) ? game : latest.game;
    const entry = games.get(shown) as GameBattle;
    const decisions = publicView
      ? []
      : (this.run?.decisions.get(index) ?? []).filter((decision) => decision.game === shown);
    return {
      index,
      game: shown,
      games: [...games.keys()].sort((a, b) => a - b),
      revision: this.run?.battleRevisions.get(index) ?? 0,
      snapshot: snapshotBattle(
        entry.state,
        this.run?.rows[index]?.players,
        entry.log,
        decisions,
        this.run?.spend.get(index),
      ),
    };
  }

  private async modelsBody(providerId: string, apiKey: string): Promise<ModelsResponse> {
    const option = providerOption(providerId);
    if (!option || (this.publicOrigin && option.id === 'compat')) {
      throw new HttpError(400, `unknown provider ${JSON.stringify(providerId)}`);
    }
    try {
      const models = await discoverModels(option, apiKey.trim() || undefined, {
        signal: AbortSignal.timeout(20_000),
      });
      return { models: models.map((model) => this.modelInfo(option.id, model)) };
    } catch (error) {
      throw new HttpError(400, redactSecrets(error instanceof Error ? error.message : String(error), [apiKey]));
    }
  }

  private startRun(body: Record<string, unknown>, owner: AuthUser | undefined): JsonObject {
    if (this.run && isActiveRunState(this.run.state)) throw new HttpError(409, 'a run is already in progress');
    const mode = (
      body.mode === undefined || body.mode === 'rotation'
        ? 'rotation'
        : body.mode === 'tournament' || body.mode === 'draft'
          ? body.mode
          : undefined
    ) as ExperimentMode | undefined;
    if (!mode) throw new HttpError(400, 'unknown run mode');
    const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : [];
    const maximumModels = this.publicOrigin && mode === 'rotation' ? 4 : 8;
    if (models.length < 2) throw new HttpError(400, 'a run needs at least two model specs');
    if (models.length > maximumModels) {
      throw new HttpError(400, `a run supports at most ${maximumModels} model specs`);
    }
    const reasoning = body.reasoning ? (String(body.reasoning) as ReasoningLevel) : undefined;
    if (reasoning && !REASONING_LEVELS.includes(reasoning)) {
      throw new HttpError(400, `reasoning must be one of: ${REASONING_LEVELS.join(', ')}`);
    }
    if (body.reasoningByModel !== undefined && !isRecord(body.reasoningByModel)) {
      throw new HttpError(400, 'reasoningByModel must be an object');
    }
    const reasoningByModel: Record<string, ReasoningLevel> = {};
    for (const [model, value] of Object.entries(isRecord(body.reasoningByModel) ? body.reasoningByModel : {})) {
      const level = String(value) as ReasoningLevel;
      if (!models.includes(model)) throw new HttpError(400, `reasoning configured for unselected model ${model}`);
      if (model === 'random') throw new HttpError(400, 'random does not support configurable reasoning');
      if (!REASONING_LEVELS.includes(level)) {
        throw new HttpError(400, `reasoning for ${model} must be one of: ${REASONING_LEVELS.join(', ')}`);
      }
      reasoningByModel[model] = level;
    }
    if (reasoning && Object.keys(reasoningByModel).length) {
      throw new HttpError(400, 'choose either shared reasoning or per-model reasoning, not both');
    }
    const suppliedKeys = isRecord(body.apiKeys) ? body.apiKeys : {};
    const apiKeys: Record<string, string> = {};
    const missing: string[] = [];
    for (const model of models) {
      if (model === 'random') continue;
      try {
        const spec = parseSpec(model);
        if (this.publicOrigin && spec.provider === 'compat') {
          throw new Error('OpenAI-compatible custom endpoints are disabled in hosted mode');
        }
        validateReasoning(spec, reasoningByModel[model] ?? reasoning);
        const apiKey = typeof suppliedKeys[model] === 'string' ? suppliedKeys[model].trim() : '';
        const option = providerOption(spec.provider);
        if (!apiKey && (option?.requiresKey ?? spec.provider !== 'compat')) {
          missing.push(`${option?.label ?? spec.provider} (${model})`);
        } else {
          apiKeys[model] = apiKey || 'none';
        }
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    }
    if (missing.length) throw new HttpError(400, `API key required for: ${missing.join(', ')}`);
    const inlinePastes = mode === 'tournament' && Array.isArray(body.teams) ? body.teams.map(String) : undefined;
    let pool = '';
    let teams: Team[] | undefined;
    let format: string | undefined;
    let board: string | undefined;
    if (mode === 'draft') {
      const boards = listBoards();
      board = String(body.board ?? '') || boards[0]?.id || '';
      const info = boards.find((entry) => entry.id === board);
      if (!info) throw new HttpError(400, `unknown draft board ${JSON.stringify(board)}`);
      if (models.length > info.maxEntrants) {
        throw new HttpError(400, `board ${JSON.stringify(board)} supports at most ${info.maxEntrants} models`);
      }
    } else if (inlinePastes) {
      if (inlinePastes.length !== models.length) {
        throw new HttpError(400, 'provide exactly one team paste per model');
      }
      format = String(body.format ?? '').trim() || this.defaultFormatId();
      if (!championsFormats().some((info) => info.id === format)) {
        throw new HttpError(400, `unknown format ${JSON.stringify(format)}`);
      }
      teams = inlinePastes.map((paste, index) => {
        if (!paste.trim() || paste.length > 20_000) {
          throw new HttpError(400, `team ${index + 1} must be a non-empty paste under 20k characters`);
        }
        try {
          const packed = packTeam(paste);
          validateTeam(packed, format!);
          return { id: `paste-${index + 1}`, packed };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new HttpError(400, `team ${index + 1} is not legal in ${format}: ${detail}`);
        }
      });
    } else {
      pool = String(body.pool ?? '');
      const info = listPools(this.options.teamsDir ?? TEAMS_DIR).find((entry) => entry.name === pool);
      if (!info) throw new HttpError(400, `unknown team pool ${JSON.stringify(pool)}`);
      if (mode === 'tournament' && info.teamCount < models.length) {
        throw new HttpError(
          400,
          `pool ${JSON.stringify(pool)} has ${info.teamCount} teams for ${models.length} entrants`,
        );
      }
    }
    const seed = body.seed === undefined || body.seed === null || body.seed === '' ? undefined : Number(body.seed);
    if (seed !== undefined && !Number.isSafeInteger(seed)) throw new HttpError(400, 'seed must be an integer');
    let timerScale: TimerScale | undefined;
    try {
      timerScale = parseTimerScale(body.timerScale);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    const maximumSeriesPerPair = this.publicOrigin ? 4 : 20;
    const maximumConcurrency = this.publicOrigin ? 2 : 8;
    const config: RunConfig = {
      mode,
      protocolVersion:
        mode === 'tournament'
          ? TOURNAMENT_PROTOCOL_VERSION
          : mode === 'draft'
            ? DRAFT_PROTOCOL_VERSION
            : ROTATION_PROTOCOL_VERSION,
      models,
      seriesPerPair: mode === 'rotation' ? clampInt(body.seriesPerPair, 1, maximumSeriesPerPair, 2) : 1,
      pool,
      concurrency: clampInt(body.concurrency, 1, maximumConcurrency, 2),
      ...(teams === undefined ? {} : { teams }),
      ...(format === undefined ? {} : { format }),
      ...(board === undefined ? {} : { board }),
      ...(seed === undefined ? {} : { seed }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(Object.keys(reasoningByModel).length ? { reasoningByModel } : {}),
      ...(timerScale === undefined ? {} : { timerScale }),
    };
    const run = new ActiveRun(config, apiKeys, owner, this.options.runsDir);
    if (owner && this.options.auth) {
      try {
        this.options.auth.startExperiment(owner, run.runId, pool, config);
      } catch (error) {
        run.clearApiKeys();
        fs.rmSync(run.runDir, { recursive: true, force: true });
        throw error;
      }
    }
    this.run = run;
    writeRunStatus(run.runDir, {
      state: 'running',
      error: null,
      notices: [],
      start_time: new Date(run.startTime).toISOString(),
      end_time: null,
      pid: process.pid,
    });
    run.timeoutRemainingMs = this.maxRunMs;
    this.armRunTimeout(run);
    this.runTask = this.launch(run);
    this.queueRun();
    return { ok: true, runId: run.runId };
  }

  private armRunTimeout(run: ActiveRun): void {
    clearTimeout(run.timeoutTimer);
    run.timeoutStartedAt = Date.now();
    run.timeoutTimer = setTimeout(() => {
      if (run !== this.run || run.state !== 'running' || run.settling) return;
      run.timedOut = true;
      run.notices.push('run stopped after reaching its maximum duration');
      run.controller.abort();
      this.scheduleStopFallback(run);
      this.queueRun();
    }, run.timeoutRemainingMs);
    run.timeoutTimer.unref();
  }

  private setRecoveryState(run: ActiveRun, pause: RecoveryPause | undefined): void {
    if (run !== this.run || run.settling || !isActiveRunState(run.state)) return;
    if (pause) {
      if (run.state === 'running') {
        clearTimeout(run.timeoutTimer);
        if (run.timeoutStartedAt !== undefined) {
          run.timeoutRemainingMs = Math.max(1, run.timeoutRemainingMs - (Date.now() - run.timeoutStartedAt));
        }
      }
      run.state = 'paused';
      run.pause = pause;
    } else if (run.state === 'paused') {
      run.state = 'running';
      run.pause = undefined;
      this.armRunTimeout(run);
    }
    this.queueRun();
  }

  private settleRun(run: ActiveRun, failed: boolean, error?: unknown): void {
    if (run.timedOut) {
      run.state = 'failed';
      run.error = TIMEOUT_ERROR;
    } else if (run.interrupted) {
      run.state = 'failed';
      run.error = SHUTDOWN_ERROR;
    } else if (run.userStopped) {
      run.state = 'stopped';
    } else if (failed) {
      run.state = 'failed';
      run.error = redactSecrets(error instanceof Error ? error.message : String(error), Object.values(run.apiKeys));
    } else {
      run.state = 'done';
    }
  }

  private async launch(run: ActiveRun): Promise<void> {
    const injected =
      run.config.mode === 'tournament'
        ? this.options.tournamentRunner
        : run.config.mode === 'draft'
          ? this.options.draftRunner
          : this.options.runner;
    const removeRecoveryListener = run.recovery.onChange((pause) => this.setRecoveryState(run, pause));
    run.resumeAction = () => {
      run.recovery.resume();
    };
    const commonOptions = {
      concurrency: run.config.concurrency,
      recordsPath: this.options.recordsPath ?? RESULTS_PATH,
      apiKeys: run.apiKeys,
      signal: run.controller.signal,
      ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
      ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
      ...(run.config.reasoningByModel === undefined ? {} : { reasoningByModel: run.config.reasoningByModel }),
      ...(run.config.timerScale === undefined ? {} : { timerScale: run.config.timerScale }),
      recovery: run.recovery,
      ...(run.owner
        ? {
            contributor: {
              provider: 'github' as const,
              subject: run.owner.providerSubject,
              login: run.owner.login,
            },
          }
        : {}),
      onEvent: (event: DraftLeagueEvent) => this.onEvent(run, event),
    };
    try {
      if (this.publicOrigin && !injected) {
        await this.launchWorker(run);
      } else if (run.config.mode === 'draft') {
        await (this.options.draftRunner ?? runDraftLeague)(run.config.models, run.runDir, {
          ...commonOptions,
          ...(run.config.board === undefined ? {} : { board: run.config.board }),
        });
      } else if (run.config.mode === 'tournament') {
        await (this.options.tournamentRunner ?? runTournament)(run.config.models, run.runDir, {
          ...commonOptions,
          ...(run.config.pool ? { pool: run.config.pool } : {}),
          ...(run.config.teams === undefined ? {} : { teams: run.config.teams }),
          ...(run.config.format === undefined ? {} : { format: run.config.format }),
        });
      } else {
        await (this.options.runner ?? runRotation)(run.config.models, run.config.seriesPerPair, run.runDir, {
          ...commonOptions,
          pool: run.config.pool,
          onNotice: (message) => run.notices.push(message),
        });
      }
      this.settleRun(run, false);
    } catch (error) {
      this.settleRun(run, true, error);
    } finally {
      clearTimeout(run.timeoutTimer);
      clearTimeout(run.stopFallbackTimer);
      if (run.detached) {
        run.clearApiKeys();
        this.options.logger?.({
          timestamp: new Date().toISOString(),
          level: 'info',
          event: 'detached_run_settled',
          runId: run.runId,
        });
      } else {
        const persistedState = isActiveRunState(run.state) ? 'failed' : run.state;
        if (this.options.auth && run.owner) {
          try {
            this.options.auth.finishExperiment(run.runId, persistedState);
          } catch (error) {
            run.state = 'failed';
            run.error = redactSecrets(
              error instanceof Error ? error.message : String(error),
              Object.values(run.apiKeys),
            );
            this.options.logger?.({
              timestamp: new Date().toISOString(),
              level: 'error',
              event: 'experiment_persistence_error',
              runId: run.runId,
              error: run.error,
            });
          }
        }
        run.clearApiKeys();
        run.endTime = Date.now();
        this.persistStatus(run);
        this.options.logger?.({
          timestamp: new Date().toISOString(),
          level: run.state === 'failed' ? 'error' : 'info',
          event: 'run_finished',
          runId: run.runId,
          state: run.state,
          durationMs: run.endTime - run.startTime,
        });
        this.queueRun();
      }
      removeRecoveryListener();
      run.resumeAction = undefined;
    }
  }

  private detachRun(run: ActiveRun, state: 'stopped' | 'failed', error: string): void {
    run.detached = true;
    run.state = state;
    run.error = error;
    run.clearApiKeys();
    if (this.options.auth && run.owner) {
      try {
        this.options.auth.finishExperiment(run.runId, state);
      } catch (caught) {
        this.options.logger?.({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'experiment_persistence_error',
          runId: run.runId,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
    this.persistStatus(run);
    this.options.logger?.({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'run_detached',
      runId: run.runId,
      state,
    });
    this.queueRun();
  }

  private persistStatus(run: ActiveRun): void {
    run.endTime ??= Date.now();
    writeRunStatus(run.runDir, {
      state: run.state,
      error: run.error || null,
      notices: run.notices,
      start_time: new Date(run.startTime).toISOString(),
      end_time: new Date(run.endTime ?? Date.now()).toISOString(),
    });
  }

  /**
   * A stop or timeout only aborts the run task; if the task ignores the abort
   * (a wedged provider or simulator), detach it after a grace period so the
   * server never stays locked in a permanently "running" run.
   */
  private scheduleStopFallback(run: ActiveRun): void {
    if (run.stopFallbackTimer) return;
    run.stopFallbackTimer = setTimeout(() => {
      if (!isActiveRunState(run.state) || run.settling) return;
      run.notices.push('the run task did not shut down cleanly and was detached');
      this.detachRun(run, run.timedOut ? 'failed' : 'stopped', run.timedOut ? TIMEOUT_ERROR : '');
    }, this.stopFallbackMs);
    run.stopFallbackTimer.unref();
  }

  private launchWorker(run: ActiveRun): Promise<void> {
    const child = fork(this.options.workerPath ?? RUN_WORKER_PATH, [], {
      env: workerEnvironment(),
      execArgv: ['--max-old-space-size=768'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.stderr?.resume();
    const completion = Promise.withResolvers<void>();
    let terminal: Extract<RunWorkerOutput, { type: 'done' | 'failed' }> | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const resolve = () => {
      if (settled) return;
      settled = true;
      completion.resolve();
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      completion.reject(error);
    };
    const scheduleKill = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => child.kill('SIGKILL'), this.workerStopGraceMs);
      killTimer.unref();
    };
    const markTerminal = (message: NonNullable<typeof terminal>) => {
      if (terminal) return;
      terminal = message;
      run.settling = true;
      this.queueRun();
      scheduleKill();
    };
    child.on('message', (value: unknown) => {
      const message = value as Partial<RunWorkerOutput> | null;
      try {
        if (message?.type === 'event') {
          if (!isRecord(message.event) || typeof message.event.type !== 'string') {
            throw new Error('run worker sent an invalid event');
          }
          this.onEvent(run, message.event as DraftLeagueEvent);
        } else if (message?.type === 'notice') {
          if (typeof message.message !== 'string') throw new Error('run worker sent an invalid notice');
          run.notices.push(message.message.slice(0, 2000));
        } else if (message?.type === 'done') {
          markTerminal(message as Extract<RunWorkerOutput, { type: 'done' }>);
        } else if (message?.type === 'failed') {
          if (typeof message.error !== 'string') throw new Error('run worker sent an invalid failure');
          markTerminal(message as Extract<RunWorkerOutput, { type: 'failed' }>);
        } else if (message?.type === 'paused') {
          if (!isRecord(message.pause) || typeof message.pause.message !== 'string') {
            throw new Error('run worker sent an invalid pause');
          }
          this.setRecoveryState(run, message.pause as unknown as RecoveryPause);
        } else if (message?.type === 'resumed') {
          this.setRecoveryState(run, undefined);
        }
      } catch (error) {
        child.kill();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once('error', (error) => {
      child.kill();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (terminal?.type === 'done' && code === 0) resolve();
      else if (terminal?.type === 'failed') reject(new Error(terminal.error));
      else reject(new Error(`run worker exited unexpectedly (${signal ?? code ?? 'unknown'})`));
    });
    const abort = () => {
      if (child.connected) child.send({ type: 'abort' } satisfies RunWorkerInput);
      scheduleKill();
    };
    run.controller.signal.addEventListener('abort', abort, { once: true });
    run.resumeAction = () => {
      if (child.connected) child.send({ type: 'resume' } satisfies RunWorkerInput);
    };
    const message: RunWorkerStart = {
      type: 'start',
      mode: run.config.mode === 'tournament' || run.config.mode === 'draft' ? run.config.mode : 'rotation',
      models: run.config.models,
      seriesPerPair: run.config.seriesPerPair,
      runDir: run.runDir,
      pool: run.config.pool,
      concurrency: run.config.concurrency,
      recordsPath: this.options.recordsPath ?? RESULTS_PATH,
      apiKeys: run.apiKeys,
      ...(run.config.teams === undefined ? {} : { teams: run.config.teams }),
      ...(run.config.format === undefined ? {} : { format: run.config.format }),
      ...(run.config.board === undefined ? {} : { board: run.config.board }),
      ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
      ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
      ...(run.config.reasoningByModel === undefined ? {} : { reasoningByModel: run.config.reasoningByModel }),
      ...(run.config.timerScale === undefined ? {} : { timerScale: run.config.timerScale }),
      ...(run.owner
        ? {
            contributor: {
              provider: 'github',
              subject: run.owner.providerSubject,
              login: run.owner.login,
            },
          }
        : {}),
    };
    child.send(message satisfies RunWorkerInput, (error) => {
      run.clearApiKeys();
      if (error) {
        child.kill();
        reject(error);
      }
    });
    return completion.promise.finally(() => {
      clearTimeout(killTimer);
      run.controller.signal.removeEventListener('abort', abort);
      run.resumeAction = undefined;
    });
  }

  private onEvent(run: ActiveRun, event: DraftLeagueEvent): void {
    if (run !== this.run) return;
    if (event.type === 'draft') {
      run.draft = event.draft;
    } else if (event.type === 'bracket') {
      run.bracket = event.bracket;
    } else if (event.type === 'series-players') {
      const row = run.rows[event.index];
      if (row) row.players = event.players;
    } else if (event.type === 'plans') {
      run.seed = event.seed;
      run.rows = event.plans.map((plan) => ({
        players: plan.players,
        status: 'queued' as const,
        score: { p1: 0, p2: 0 } as Record<Pid, number>,
        game: 0,
        turns: 0,
        winner: null,
      }));
    } else if (event.type === 'series-start') {
      const row = run.rows[event.index];
      if (row) {
        row.status = 'running';
        row.game = 1;
      }
    } else if (event.type === 'game-update') {
      if (!run.rows[event.index]) return;
      for (const [store, lines] of [
        [run.battles, event.lines],
        [run.publicBattles, event.publicLines],
      ] as const) {
        let games = store.get(event.index);
        if (!games) {
          games = new Map();
          store.set(event.index, games);
        }
        let entry = games.get(event.game);
        if (!entry) {
          entry = { state: new BattleState('p1'), log: new BattleLog() };
          games.set(event.game, entry);
        }
        entry.state.feed(lines);
        entry.log.feed(lines);
      }
      const row = run.rows[event.index];
      if (row && row.status === 'running') row.game = event.game;
      run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
      this.queueBattle(event.index);
    } else if (event.type === 'decision') {
      if (!run.rows[event.index]) return;
      const row = event.row;
      const rawError = typeof row.error === 'string' ? row.error : '';
      let error = typeof row.error_summary === 'string' ? row.error_summary.slice(0, 500) : '';
      if (!error && rawError) {
        error =
          row.fallback === true && row.action !== 'abandoned'
            ? 'The model returned no usable decision; a legal fallback was selected.'
            : classifyProviderFailure(rawError, run.rows[event.index]!.players[event.pid]).summary;
      }
      if (row.kind === 'decision' || row.kind === 'game_reflection') {
        const totals = run.spend.get(event.index) ?? { p1: { ms: 0, tokens: 0 }, p2: { ms: 0, tokens: 0 } };
        if (row.kind === 'decision') totals[event.pid].ms += Number(row.latency_ms) || 0;
        totals[event.pid].tokens += Number(row.total_tokens) || 0;
        run.spend.set(event.index, totals);
        if (row.kind === 'game_reflection') {
          run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
          this.queueBattle(event.index);
        }
      }
      if (row.kind === 'decision') {
        const list = run.decisions.get(event.index) ?? [];
        list.push({
          game: Number(row.game_number) || 0,
          turn: Number(row.turn) || 0,
          pid: event.pid,
          phase: typeof row.phase === 'string' ? row.phase.slice(0, 100) : '',
          selection: Array.isArray(row.selection)
            ? row.selection.slice(0, 16).map((value) => String(value).slice(0, 500))
            : [],
          rationale: typeof row.rationale === 'string' ? row.rationale.slice(0, 20_000) : '',
          error,
          automatic: row.automatic === true,
          fallback: row.fallback === true,
          substituted: typeof row.substitution_reason === 'string',
        });
        if (list.length > 400) list.splice(0, list.length - 400);
        run.decisions.set(event.index, list);
        run.battleRevisions.set(event.index, (run.battleRevisions.get(event.index) ?? 0) + 1);
        this.queueBattle(event.index);
      }
      return;
    } else if (event.type === 'game-end') {
      const row = run.rows[event.index];
      if (row) {
        row.score = event.score;
        row.game = event.game + 1;
        row.turns += event.turns;
      }
    } else if (event.type === 'series-end') {
      const row = run.rows[event.index];
      if (row) {
        row.status = 'done';
        row.winner = typeof event.record.winner === 'string' ? event.record.winner : null;
        row.score = event.record.score as Record<Pid, number>;
        row.turns = Number(event.record.turns ?? row.turns);
      }
    }
    this.queueRun();
  }

  private queueBattle(index: number): void {
    this.queue(
      `battle:${index}`,
      () => ({ type: 'battle', ...this.battleBody(index) }),
      () => ({ type: 'battle', ...this.battleBody(index, true) }),
    );
  }

  private queueRun(): void {
    this.queue(
      'run',
      () => ({ type: 'run', run: this.runBody() }),
      () => ({ type: 'run', run: this.runBody(true) }),
    );
  }

  private queue(key: string, makePrivate: () => ServerEvent, makePublic: () => ServerEvent = makePrivate): void {
    this.pending.set(key, () => ({ privateEvent: makePrivate(), publicEvent: makePublic() }));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flush();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.pending.size) this.scheduleFlush();
    }, 150);
  }

  private flush(): void {
    const makes = [...this.pending.values()];
    this.pending.clear();
    for (const item of makes) {
      const message = item();
      if (message) this.broadcast(message);
    }
  }

  private broadcast(message: PendingServerEvent): void {
    const privateData = `data: ${JSON.stringify(message.privateEvent)}\n\n`;
    const publicData = `data: ${JSON.stringify(message.publicEvent)}\n\n`;
    for (const [client, viewer] of this.clients) {
      const data =
        !viewer.publicOnly && this.canViewPrivateRun(this.eventViewerUser(viewer)) ? privateData : publicData;
      this.writeEvent(client, data);
    }
  }

  private openEvents(response: http.ServerResponse, sessionToken: string | undefined, publicOnly: boolean): void {
    const viewers = [...this.clients.values()];
    if (publicOnly) {
      if (viewers.filter((viewer) => viewer.publicOnly).length >= MAX_PUBLIC_SSE_CLIENTS) {
        throw new HttpError(503, 'too many public event stream clients');
      }
    } else {
      const controllers = viewers.filter(
        (viewer) => !viewer.publicOnly && this.controlsCurrentRun(this.eventViewerUser(viewer)),
      ).length;
      const user = this.options.auth?.session(sessionToken)?.user;
      if (this.controlsCurrentRun(user)) {
        if (controllers >= MAX_CONTROLLER_SSE_CLIENTS) {
          throw new HttpError(503, 'too many controller event stream clients');
        }
      } else if (viewers.filter((viewer) => !viewer.publicOnly).length - controllers >= MAX_FALLBACK_SSE_CLIENTS) {
        throw new HttpError(503, 'too many authenticated spectator event stream clients');
      }
      if (
        sessionToken &&
        viewers.filter((viewer) => !viewer.publicOnly && viewer.sessionToken === sessionToken).length >=
          MAX_SSE_CLIENTS_PER_SESSION
      ) {
        throw new HttpError(429, 'too many event streams for this session');
      }
    }
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const viewer: EventViewer = { sessionToken, publicOnly, backpressured: false };
    const publicView = publicOnly || !this.canViewPrivateRun(this.eventViewerUser(viewer));
    this.clients.set(response, viewer);
    if (!this.writeEvent(response, `data: ${JSON.stringify({ type: 'run', run: this.runBody(publicView) })}\n\n`)) {
      return;
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const client of this.clients.keys()) this.writeEvent(client, ': heartbeat\n\n');
      }, SSE_HEARTBEAT_MS);
      this.heartbeatTimer.unref();
    }
    response.on('close', () => this.removeEventClient(response, false));
  }

  private writeEvent(response: http.ServerResponse, data: string): boolean {
    const viewer = this.clients.get(response);
    if (!viewer) return false;
    if (viewer.backpressured) {
      this.removeEventClient(response, true);
      return false;
    }
    if (response.write(data)) return true;
    viewer.backpressured = true;
    response.once('drain', () => {
      if (this.clients.get(response) === viewer) viewer.backpressured = false;
    });
    return true;
  }

  private removeEventClient(response: http.ServerResponse, destroy: boolean): void {
    this.clients.delete(response);
    if (destroy) response.destroy();
    if (this.clients.size === 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private makePool(body: Record<string, unknown>, owner: AuthUser | undefined): JsonObject {
    const format = String(body.format ?? '');
    if (!championsFormats().some((option) => option.id === format)) {
      throw new HttpError(400, `unsupported Champions BO3 format ${JSON.stringify(format)}`);
    }
    const entries = Array.isArray(body.teams) ? body.teams : [];
    if (entries.length > 32) throw new HttpError(400, 'a pool supports at most 32 teams');
    const drafts: TeamDraft[] = entries.map((entry) => {
      const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      const paste = String(record.paste ?? '');
      if (paste.length > 64_000) throw new HttpError(400, 'a team paste must be at most 64 KB');
      return { id: String(record.id ?? ''), paste };
    });
    const name = String(body.name ?? '');
    const teamsDir = this.options.teamsDir ?? TEAMS_DIR;
    const candidateDir = path.resolve(teamsDir, name);
    const canCleanCandidate =
      candidateDir.startsWith(path.resolve(teamsDir) + path.sep) && !fs.existsSync(candidateDir);
    let dir: string;
    try {
      dir = createPool(name, format, drafts, teamsDir);
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') {
        if (canCleanCandidate) fs.rmSync(candidateDir, { recursive: true, force: true });
        throw error;
      }
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    if (owner && this.options.auth) {
      try {
        this.options.auth.recordPool(owner, path.basename(dir), format);
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    return { ok: true, name: path.basename(dir), pools: listPools(this.options.teamsDir ?? TEAMS_DIR) };
  }

  /** The fixed upstream host prevents SSRF. */
  private async importPokepaste(body: Record<string, unknown>): Promise<JsonObject> {
    const raw = String(body.url ?? '').trim();
    const id = /^(?:https?:\/\/pokepast\.es\/)?([0-9a-f]{8,16})(?:\/(?:raw\/?)?)?$/i.exec(raw)?.[1];
    if (!id) {
      throw new HttpError(400, 'provide a pokepast.es link such as https://pokepast.es/0123456789abcdef');
    }
    let upstream: Response;
    try {
      upstream = await fetch(`https://pokepast.es/${id.toLowerCase()}/raw`, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch (error) {
      throw new HttpError(
        502,
        `could not reach pokepast.es: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!upstream.ok) throw new HttpError(502, `pokepast.es returned ${upstream.status} for paste ${id}`);
    if (Number(upstream.headers.get('content-length')) > 64_000) throw new HttpError(400, 'the paste exceeds 64 KB');
    const paste = await upstream.text();
    if (paste.length > 64_000) throw new HttpError(400, 'the paste exceeds 64 KB');
    if (!paste.trim()) throw new HttpError(502, `paste ${id} is empty`);
    return { paste };
  }

  private validateDraft(body: Record<string, unknown>): JsonObject {
    const format = String(body.format ?? '');
    if (!format) throw new HttpError(400, 'format is required');
    const paste = String(body.paste ?? '');
    if (paste.length > 64_000) throw new HttpError(400, 'a team paste must be at most 64 KB');
    return inspectTeam(paste, format) as unknown as JsonObject;
  }
}

function clampInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
  for (const name of ['LANG', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'VGC_LEAGUE_DATA_DIR', 'VGC_LEAGUE_PS']) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
