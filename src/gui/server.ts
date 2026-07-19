import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthService, AuthSession, AuthUser } from '../auth.js';
import { AuthError } from '../auth.js';
import { listBoards } from '../draft.js';
import type { DraftLeagueEvent } from '../draftleague.js';
import { DRAFT_PROTOCOL_VERSION, runDraftLeague } from '../draftleague.js';
import { discoverModels, PROVIDER_OPTIONS, providerOption } from '../model-catalog.js';
import { DATA_DIR, prepareDataDirectories, RESULTS_PATH, TEAMS_DIR } from '../paths.js';
import type { ReasoningLevel } from '../providers.js';
import { parseSpec, REASONING_LEVELS, validateReasoning } from '../providers.js';
import { h2h, loadRows, scopeRows, standings } from '../records.js';
import { makeRunDirectory, ROTATION_PROTOCOL_VERSION, runRotation } from '../rotation.js';
import { redactSecrets } from '../sanitize.js';
import { loadShowdown } from '../showdown.js';
import type { MonState } from '../state.js';
import { BattleState } from '../state.js';
import type { Team, TeamDraft } from '../teams.js';
import { createPool, inspectTeam, listPools, loadPool, packTeam, validateTeam } from '../teams.js';
import { runTournament, TOURNAMENT_PROTOCOL_VERSION } from '../tournament.js';
import type { ExperimentMode, JsonObject, Pid } from '../types.js';
import { afterColon, isRecord } from '../value.js';
import type {
  AppState,
  BattleMessage,
  BattleSnapshot,
  BracketView,
  DraftView,
  FormatInfo,
  ModelsResponse,
  MonView,
  RecordsResponse,
  RunSnapshot,
  SampleTeam,
  SeriesRowView,
  ServerEvent,
} from './api.js';
import type { RunWorkerInput, RunWorkerOutput, RunWorkerStart } from './run-worker-protocol.js';

type SeriesRow = Omit<SeriesRowView, 'turn'>;

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gui');
const RUN_WORKER_PATH = fileURLToPath(new URL('./run-worker.js', import.meta.url));
const ASSET_TYPES: Record<string, string> = {
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

interface GuiServerOptions {
  teamsDir?: string;
  recordsPath?: string;
  runner?: typeof runRotation;
  tournamentRunner?: typeof runTournament;
  draftRunner?: typeof runDraftLeague;
  host?: string;
  publicOrigin?: string;
  mutationsEnabled?: boolean;
  auth?: AuthService;
  logger?: (entry: Record<string, unknown>) => void;
  maxRunMs?: number;
  workerPath?: string;
  workerStopGraceMs?: number;
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

interface RunConfig {
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
  reasoning?: ReasoningLevel;
}

class ActiveRun {
  rows: SeriesRow[] = [];
  bracket: BracketView | undefined;
  draft: DraftView | undefined;
  state: 'running' | 'done' | 'failed' = 'running';
  error = '';
  notices: string[] = [];
  seed: number | undefined;
  endTime: number | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  timedOut = false;
  interrupted = false;
  readonly battles = new Map<number, { game: number; state: BattleState }>();
  readonly publicBattles = new Map<number, { game: number; state: BattleState }>();
  readonly controller = new AbortController();
  readonly runDir = makeRunDirectory();
  readonly runId = path.basename(this.runDir);
  readonly startTime = Date.now();

  constructor(
    readonly config: RunConfig,
    readonly apiKeys: Record<string, string>,
    readonly owner: AuthUser | undefined,
  ) {}

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

function snapshotMon(battle: BattleState, pid: Pid, mon: MonState): MonView {
  const boosts = Object.entries(mon.boosts)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat} ${value > 0 ? '+' : ''}${value}`)
    .join(', ');
  const target = mon.lastMove?.target ? ` → ${afterColon(mon.lastMove.target)}` : '';
  return {
    species: mon.species,
    slot: battle.activeSlot(pid, mon)?.toUpperCase() ?? '',
    hp: mon.fainted ? 'fainted' : (mon.hp ?? ''),
    status: mon.fainted ? '' : (mon.status ?? ''),
    fainted: mon.fainted,
    boosts,
    lastMove: mon.lastMove ? `${mon.lastMove.name}${target} · T${mon.lastMove.turn}` : '',
  };
}

function snapshotBattle(battle: BattleState, players: Record<Pid, string> | undefined): BattleSnapshot {
  const side = (pid: Pid) => ({
    player: players?.[pid] ?? pid,
    conditions: battle.conditionLabels(pid),
    mons: battle.visibleMons(pid).map((mon) => snapshotMon(battle, pid, mon)),
  });
  return {
    turn: battle.turn,
    weather: battle.weatherLabel(),
    fields: battle.fieldLabels(),
    sides: { p1: side('p1'), p2: side('p2') },
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
      if (this.run?.state === 'running') this.run.interrupted = true;
      this.run?.controller.abort();
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

    let actor: AuthUser | undefined;
    if (MUTATING_METHODS[method]) {
      const origin = request.headers.origin;
      const expectedOrigin = this.publicOrigin?.origin ?? `http://${host}`;
      if ((this.publicOrigin && origin !== expectedOrigin) || (origin !== undefined && origin !== expectedOrigin)) {
        throw new HttpError(403, 'cross-origin requests are not allowed');
      }
      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
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
      else if (key === 'POST /api/pool') this.consumeRateLimit('pool', subject, 10, 60 * 60_000);
      else if (key === 'POST /api/run') this.consumeRateLimit('run', subject, 6, 60 * 60_000);
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/') && this.serveStatic(url.pathname, response)) return;
    if (key === 'GET /api/state') this.json(response, 200, this.stateBody(session));
    else if (key === 'GET /api/records') this.json(response, 200, this.recordsBody(url.searchParams.get('pool')));
    else if (key === 'GET /api/events/public') {
      this.openEvents(response, undefined, true);
    } else if (key === 'GET /api/events') {
      this.requireAuthenticatedViewer(session);
      this.openEvents(response, sessionToken, false);
    } else if (key === 'GET /api/battle/public') {
      this.json(response, 200, this.battleBody(Number(url.searchParams.get('index')), true));
    } else if (key === 'GET /api/battle') {
      this.requireAuthenticatedViewer(session);
      this.json(
        response,
        200,
        this.battleBody(Number(url.searchParams.get('index')), !this.canViewPrivateRun(session?.user)),
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
      if (actor && this.run && this.options.auth) this.options.auth.stopExperiment(actor, this.run.runId);
      this.run?.controller.abort();
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/pool') {
      this.json(response, 200, this.makePool(await this.readJson(request), actor));
    } else if (key === 'POST /api/team/validate') {
      const body = await this.readJson(request);
      const result = this.validateDraft(body);
      if (actor && this.options.auth) this.options.auth.recordValidation(actor, String(body.format ?? ''));
      this.json(response, 200, result);
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
    if (this.options.auth && !session) throw new HttpError(401, 'authentication required');
  }

  private canViewPrivateRun(user: AuthUser | undefined): boolean {
    if (!this.options.auth) return true;
    if (!user) return false;
    return !this.run || user.role === 'operator' || this.run.owner?.id === user.id;
  }

  private eventViewerUser(viewer: EventViewer): AuthUser | undefined {
    if (viewer.publicOnly) return undefined;
    return this.options.auth?.session(viewer.sessionToken)?.user;
  }

  private controlsCurrentRun(user: AuthUser | undefined): boolean {
    if (!this.options.auth) return true;
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
    response.writeHead(200, { 'cache-control': 'no-cache', 'content-type': type });
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
        models: (option.models ?? []).map((model) => ({ id: model.id, label: model.displayName ?? model.id })),
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

  private recordsBody(poolParam: string | null): RecordsResponse {
    const all = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    const pool = poolParam?.trim() || null;
    const rows = scopeRows(all, pool ?? undefined);
    // Only rotation rows rate the ladder, even inside an explicitly selected pool.
    const rated = rows.filter((row) => (row.mode ?? 'rotation') === 'rotation');
    const pools = [...new Set(all.map((row) => (typeof row.pool === 'string' ? row.pool : '')))].filter(Boolean).sort();
    return { count: rows.length, pool, pools, standings: standings(rated), h2h: h2h(rated), records: rows };
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
      notices: publicView ? [] : run.notices.slice(-3),
      seed: run.seed ?? null,
      pool: run.config.pool,
      models: run.config.models,
      startTime: run.startTime,
      owner: run.owner?.login ?? null,
      endTime: run.endTime ?? null,
      canControl: !publicView,
      rows: run.rows.map((row, index) => ({ ...row, turn: battles.get(index)?.state.turn ?? 0 })),
      bracket: run.bracket ?? null,
      draft: run.draft ?? null,
      board: run.config.board ?? null,
    };
  }

  private battleBody(index: number, publicView = false): BattleMessage {
    const entry = (publicView ? this.run?.publicBattles : this.run?.battles)?.get(index);
    if (!entry) return { index, game: 0, snapshot: null };
    return { index, game: entry.game, snapshot: snapshotBattle(entry.state, this.run?.rows[index]?.players) };
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
      return { models: models.map((model) => ({ id: model.id, label: model.displayName ?? model.id })) };
    } catch (error) {
      throw new HttpError(400, redactSecrets(error instanceof Error ? error.message : String(error), [apiKey]));
    }
  }

  private startRun(body: Record<string, unknown>, owner: AuthUser | undefined): JsonObject {
    if (this.run?.state === 'running') throw new HttpError(409, 'a run is already in progress');
    const mode = (
      body.mode === undefined || body.mode === 'rotation'
        ? 'rotation'
        : body.mode === 'tournament' || body.mode === 'draft'
          ? body.mode
          : undefined
    ) as ExperimentMode | undefined;
    if (!mode) throw new HttpError(400, 'unknown run mode');
    const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : [];
    // A tournament plays only n-1 series, so hosted mode can afford a fuller bracket.
    const maximumModels = this.publicOrigin && mode === 'rotation' ? 4 : 8;
    if (models.length < 2) throw new HttpError(400, 'a run needs at least two model specs');
    if (models.length > maximumModels) {
      throw new HttpError(400, `a run supports at most ${maximumModels} model specs`);
    }
    const reasoning = body.reasoning ? (String(body.reasoning) as ReasoningLevel) : undefined;
    if (reasoning && !REASONING_LEVELS.includes(reasoning))
      throw new HttpError(400, `reasoning must be one of: ${REASONING_LEVELS.join(', ')}`);
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
        validateReasoning(spec, reasoning);
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
    if (missing.length) throw new HttpError(400, `bring an API key for: ${missing.join(', ')}`);
    const inlinePastes = mode === 'tournament' && Array.isArray(body.teams) ? body.teams.map(String) : undefined;
    let pool = '';
    let teams: Team[] | undefined;
    let format: string | undefined;
    let board: string | undefined;
    if (mode === 'draft') {
      board = String(body.board ?? '') || listBoards()[0]?.id || '';
      const info = listBoards().find((entry) => entry.id === board);
      if (!info) throw new HttpError(400, `unknown draft board ${JSON.stringify(board)}`);
      if (models.length > info.maxEntrants) {
        throw new HttpError(400, `board ${JSON.stringify(board)} supports at most ${info.maxEntrants} models`);
      }
    } else if (inlinePastes) {
      if (inlinePastes.length !== models.length) {
        throw new HttpError(400, 'bring exactly one team paste per model');
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
    };
    const run = new ActiveRun(config, apiKeys, owner);
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
    run.timeoutTimer = setTimeout(() => {
      if (run !== this.run || run.state !== 'running') return;
      run.timedOut = true;
      run.notices.push('run stopped after reaching its maximum duration');
      run.controller.abort();
      this.queueRun();
    }, this.maxRunMs);
    run.timeoutTimer.unref();
    this.runTask = this.launch(run);
    this.queueRun();
    return { ok: true, runId: run.runId };
  }

  private async launch(run: ActiveRun): Promise<void> {
    const injected =
      run.config.mode === 'tournament'
        ? this.options.tournamentRunner
        : run.config.mode === 'draft'
          ? this.options.draftRunner
          : this.options.runner;
    try {
      if (this.publicOrigin && !injected) {
        await this.launchWorker(run);
      } else if (run.config.mode === 'draft') {
        await (this.options.draftRunner ?? runDraftLeague)(run.config.models, run.runDir, {
          concurrency: run.config.concurrency,
          recordsPath: this.options.recordsPath ?? RESULTS_PATH,
          apiKeys: run.apiKeys,
          signal: run.controller.signal,
          ...(run.config.board === undefined ? {} : { board: run.config.board }),
          ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
          ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
          ...(run.owner
            ? {
                contributor: {
                  provider: 'github',
                  subject: run.owner.providerSubject,
                  login: run.owner.login,
                },
              }
            : {}),
          onEvent: (event) => this.onEvent(run, event),
          onNotice: (message) => run.notices.push(message),
        });
      } else if (run.config.mode === 'tournament') {
        await (this.options.tournamentRunner ?? runTournament)(run.config.models, run.runDir, {
          concurrency: run.config.concurrency,
          recordsPath: this.options.recordsPath ?? RESULTS_PATH,
          apiKeys: run.apiKeys,
          signal: run.controller.signal,
          ...(run.config.pool ? { pool: run.config.pool } : {}),
          ...(run.config.teams === undefined ? {} : { teams: run.config.teams }),
          ...(run.config.format === undefined ? {} : { format: run.config.format }),
          ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
          ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
          ...(run.owner
            ? {
                contributor: {
                  provider: 'github',
                  subject: run.owner.providerSubject,
                  login: run.owner.login,
                },
              }
            : {}),
          onEvent: (event) => this.onEvent(run, event),
          onNotice: (message) => run.notices.push(message),
        });
      } else {
        await (this.options.runner ?? runRotation)(run.config.models, run.config.seriesPerPair, run.runDir, {
          pool: run.config.pool,
          concurrency: run.config.concurrency,
          recordsPath: this.options.recordsPath ?? RESULTS_PATH,
          apiKeys: run.apiKeys,
          signal: run.controller.signal,
          ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
          ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
          ...(run.owner
            ? {
                contributor: {
                  provider: 'github',
                  subject: run.owner.providerSubject,
                  login: run.owner.login,
                },
              }
            : {}),
          onEvent: (event) => this.onEvent(run, event),
          onNotice: (message) => run.notices.push(message),
        });
      }
      if (run.timedOut) {
        run.state = 'failed';
        run.error = 'run exceeded its maximum duration';
      } else if (run.interrupted) {
        run.state = 'failed';
        run.error = 'run interrupted by server shutdown';
      } else {
        run.state = 'done';
      }
    } catch (error) {
      if (run.timedOut) {
        run.state = 'failed';
        run.error = 'run exceeded its maximum duration';
      } else if (run.interrupted) {
        run.state = 'failed';
        run.error = 'run interrupted by server shutdown';
      } else if (run.controller.signal.aborted) {
        run.state = 'done';
      } else {
        run.state = 'failed';
        run.error = redactSecrets(error instanceof Error ? error.message : String(error), Object.values(run.apiKeys));
      }
    } finally {
      clearTimeout(run.timeoutTimer);
      if (this.options.auth && run.owner) {
        try {
          this.options.auth.finishExperiment(run.runId, run.state === 'failed' ? 'failed' : 'done');
        } catch (error) {
          run.state = 'failed';
          run.error = redactSecrets(error instanceof Error ? error.message : String(error), Object.values(run.apiKeys));
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
    child.on('message', (value: unknown) => {
      const message = value as RunWorkerOutput;
      if (message?.type === 'event') this.onEvent(run, message.event);
      else if (message?.type === 'notice') run.notices.push(message.message.slice(0, 2000));
      else if (message?.type === 'done' || message?.type === 'failed') terminal = message;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (terminal?.type === 'done' && code === 0) resolve();
      else if (terminal?.type === 'failed') reject(new Error(terminal.error));
      else reject(new Error(`run worker exited unexpectedly (${signal ?? code ?? 'unknown'})`));
    });
    const abort = () => {
      if (child.connected) child.send({ type: 'abort' } satisfies RunWorkerInput);
      killTimer = setTimeout(() => child.kill('SIGKILL'), this.workerStopGraceMs);
      killTimer.unref();
    };
    run.controller.signal.addEventListener('abort', abort, { once: true });
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
      let entry = run.battles.get(event.index);
      if (!entry || entry.game !== event.game) {
        entry = { game: event.game, state: new BattleState('p1') };
        run.battles.set(event.index, entry);
      }
      entry.state.feed(event.lines);
      let publicEntry = run.publicBattles.get(event.index);
      if (!publicEntry || publicEntry.game !== event.game) {
        publicEntry = { game: event.game, state: new BattleState('p1') };
        run.publicBattles.set(event.index, publicEntry);
      }
      publicEntry.state.feed(event.publicLines);
      const row = run.rows[event.index];
      if (row && row.status === 'running') row.game = event.game;
      this.queue(
        `battle:${event.index}`,
        () => ({ type: 'battle', ...this.battleBody(event.index) }),
        () => ({ type: 'battle', ...this.battleBody(event.index, true) }),
      );
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
    let dir: string;
    try {
      dir = createPool(String(body.name ?? ''), format, drafts, this.options.teamsDir);
    } catch (error) {
      if (error instanceof HttpError) throw error;
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
  for (const name of [
    'LANG',
    'TZ',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'VGC_LEAGUE_DATA_DIR',
    'VGC_LEAGUE_PS_DIR',
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
