import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeague, buildLeagueGame, buildLeagues, findLiveCliRun } from '../archive.js';
import { describeBoardMon, listBoards, loadBoard } from '../draft.js';
import type { runDraftLeague } from '../draftleague.js';
import { buildTournamentGame, buildTournaments } from '../evidence.js';
import { discoverModels } from '../model-catalog.js';
import { DATA_DIR, defaultPsDir, prepareDataDirectories, RESULTS_PATH, RUNS_DIR, TEAMS_DIR } from '../paths.js';
import type { DiscoveredModel } from '../provider-registry.js';
import { PROVIDER_OPTIONS, providerOption } from '../provider-registry.js';
import { loadSeriesRecords } from '../records.js';
import type { runRotation } from '../rotation.js';
import { redactSecrets } from '../sanitize.js';
import { loadShowdown } from '../showdown.js';
import type { TeamDraft } from '../teams.js';
import { createPool, exportTeam, inspectTeam, listPools, loadPool, packTeam, validateTeam } from '../teams.js';
import type { runTournament } from '../tournament.js';
import type { JsonObject } from '../types.js';
import { isRecord } from '../value.js';
import type {
  AppState,
  BoardResponse,
  FormatInfo,
  ModelInfo,
  ModelsResponse,
  PoolTeamsResponse,
  SampleTeam,
  ServerEvent,
} from './api.js';
import { parseRunRequest, RunRequestError } from './run-request.js';
import { RunSupervisor } from './run-supervisor.js';
import { loadSelectedTrace } from './selected-trace.js';

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gui');
const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const LOCAL_HOSTNAMES: Record<string, true> = { '127.0.0.1': true, localhost: true, '[::1]': true, '::1': true };
const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };
const MAX_SSE_CLIENTS = 16;
const SSE_HEARTBEAT_MS = 25_000;
const DEFAULT_MAX_RUN_MS = 4 * 60 * 60 * 1000;

interface GuiServerOptions {
  teamsDir?: string;
  recordsPath?: string;
  runsDir?: string;
  runner?: typeof runRotation;
  tournamentRunner?: typeof runTournament;
  draftRunner?: typeof runDraftLeague;
  host?: string;
  logger?: (entry: Record<string, unknown>) => void;
  maxRunMs?: number;
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

interface EventViewer {
  backpressured: boolean;
}

function gameParam(url: URL): number | undefined {
  const raw = url.searchParams.get('game');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
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
  private readonly runs: RunSupervisor;
  private shutdownTask: Promise<void> | undefined;
  private readonly clients = new Map<http.ServerResponse, EventViewer>();
  private readonly pending = new Map<string, () => ServerEvent | undefined>();
  private readonly options: GuiServerOptions;
  private readonly bindHost: string;
  private readonly maxRunMs: number;
  private readonly stopFallbackMs: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sampleTeamsCache: { pool: string; teams: SampleTeam[] } | undefined;
  private readonly selectedTrace = loadSelectedTrace();

  constructor(options: GuiServerOptions = {}) {
    this.options = options;
    this.bindHost = options.host?.trim() || '127.0.0.1';
    this.maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    if (!Number.isSafeInteger(this.maxRunMs) || this.maxRunMs < 1) {
      throw new Error('maxRunMs must be a positive integer');
    }
    this.stopFallbackMs = options.stopFallbackMs ?? 15_000;
    if (!Number.isSafeInteger(this.stopFallbackMs) || this.stopFallbackMs < 1) {
      throw new Error('stopFallbackMs must be a positive integer');
    }
    if (!LOCAL_HOSTNAMES[hostnameFromHost(this.bindHost)]) {
      throw new Error('the GUI server binds loopback only; front it with a local proxy for remote access');
    }
    this.runs = new RunSupervisor({
      maxRunMs: this.maxRunMs,
      stopFallbackMs: this.stopFallbackMs,
      onRunChange: () => this.queueRun(),
      onBattleChange: (index) => this.queueBattle(index),
      ...(options.recordsPath === undefined ? {} : { recordsPath: options.recordsPath }),
      ...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.tournamentRunner === undefined ? {} : { tournamentRunner: options.tournamentRunner }),
      ...(options.draftRunner === undefined ? {} : { draftRunner: options.draftRunner }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
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
        const expected = error instanceof HttpError;
        const status = expected ? error.status : 500;
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), this.runs.apiKeySecrets());
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
      resolve(`http://${localHost}:${address.port}/`);
    });
    return promise;
  }

  close(): void {
    void this.shutdown(0);
  }

  shutdown(graceMs = 10_000): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shutdownTask = (async () => {
      const runShutdown = this.runs.beginShutdown();
      clearTimeout(this.flushTimer);
      clearInterval(this.heartbeatTimer);
      for (const client of this.clients.keys()) client.end();
      this.clients.clear();
      const closed = Promise.withResolvers<void>();
      this.server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      const settled = runShutdown.task
        ? Promise.allSettled([closed.promise, runShutdown.task]).then(() => undefined)
        : closed.promise;
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, Math.max(0, graceMs));
      await Promise.race([settled, timeout.promise]);
      clearTimeout(timer);
      runShutdown.detach();
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
    if (!LOCAL_HOSTNAMES[hostnameFromHost(host)]) throw new HttpError(403, 'request host is not allowed');

    if (MUTATING_METHODS[method]) {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        throw new HttpError(403, 'cross-origin requests are not allowed');
      }
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase();
      if (contentType !== 'application/json') {
        throw new HttpError(415, 'content-type must be application/json');
      }
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/') && this.serveStatic(url.pathname, response)) return;
    if (key === 'GET /api/state') this.json(response, 200, this.stateBody());
    else if (key === 'GET /api/selected-trace') this.json(response, 200, this.selectedTrace.view);
    else if (key === 'GET /api/selected-trace/full.json') {
      response.writeHead(200, {
        'cache-control': 'public, max-age=3600',
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(this.selectedTrace.fullJson);
    } else if (key === 'GET /api/tournaments')
      this.json(response, 200, this.tournamentsBody(url.searchParams.get('pool')));
    else if (key === 'GET /api/leagues') this.json(response, 200, this.leaguesBody());
    else if (key === 'GET /api/league') this.json(response, 200, this.leagueBody(url.searchParams.get('run') ?? ''));
    else if (key === 'GET /api/tournament/game')
      this.json(
        response,
        200,
        this.tournamentGameBody(
          url.searchParams.get('run') ?? '',
          url.searchParams.get('series') ?? '',
          url.searchParams.get('game') ?? '',
        ),
      );
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
    else if (key === 'GET /api/board') {
      const board = this.boardBody(url.searchParams.get('id') ?? '');
      response.setHeader('cache-control', 'public, max-age=3600');
      this.json(response, 200, board);
    } else if (key === 'GET /api/pool/teams') {
      this.json(response, 200, this.poolTeamsBody(url.searchParams.get('name') ?? ''));
    } else if (key === 'GET /api/events') {
      this.openEvents(response);
    } else if (key === 'GET /api/battle') {
      this.json(response, 200, this.battleBody(Number(url.searchParams.get('index')), gameParam(url)));
    } else if (key === 'POST /api/models') {
      const body = await this.readJson(request);
      this.json(response, 200, await this.modelsBody(String(body.provider ?? ''), String(body.apiKey ?? '')));
    } else if (key === 'POST /api/run') {
      this.json(response, 200, this.startRun(await this.readJson(request)));
    } else if (key === 'POST /api/run/stop') {
      this.runs.stop();
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/run/resume') {
      if (!this.runs.resume()) throw new HttpError(409, 'the run is not paused');
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/pool') {
      this.json(response, 200, this.makePool(await this.readJson(request)));
    } else if (key === 'POST /api/team/validate') {
      this.json(response, 200, this.validateDraft(await this.readJson(request)));
    } else if (key === 'POST /api/team/pokepaste') {
      this.json(response, 200, await this.importPokepaste(await this.readJson(request)));
    } else this.json(response, 404, { error: `no route for ${key}` });
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

  private sampleTeamsBody(pools: { name: string }[]): SampleTeam[] {
    const source = pools[0]?.name;
    if (!source) return [];
    if (this.sampleTeamsCache?.pool !== source) {
      try {
        const pool = loadPool(source, this.options.teamsDir ?? TEAMS_DIR);
        this.sampleTeamsCache = {
          pool: source,
          teams: pool.teams.slice(0, 2).map((team) => ({
            name: team.id,
            paste: exportTeam(team.packed, pool.format),
          })),
        };
      } catch {
        this.sampleTeamsCache = { pool: source, teams: [] };
      }
    }
    return this.sampleTeamsCache.teams;
  }

  private modelInfo(model: DiscoveredModel): ModelInfo {
    return {
      id: model.id,
      label: model.displayName ?? model.id,
      reasoningLevels: model.supportsReasoning ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : [],
    };
  }

  private stateBody(): AppState {
    const pools = listPools(this.options.teamsDir ?? TEAMS_DIR);
    return {
      pools,
      defaultFormat: pools[0]?.format ?? 'gen9championsvgc2026regmbbo3',
      formats: championsFormats(),
      boards: listBoards(),
      providers: PROVIDER_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        discovery: option.discovery,
        requiresKey: option.requiresKey,
      })),
      sampleTeams: this.sampleTeamsBody(pools),
      run: this.runs.snapshot(),
      externalRun: this.externalRunBody(),
    };
  }

  private externalRunBody(): AppState['externalRun'] {
    if (this.runs.hasActiveRun()) return null;
    return findLiveCliRun(this.options.runsDir ?? RUNS_DIR);
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
    const pool = loadPool(name, teamsDir);
    return {
      name: pool.id,
      format: pool.format,
      teams: pool.teams.map((team) => ({ name: team.id, paste: exportTeam(team.packed, pool.format) })),
    };
  }

  private tournamentsBody(poolParam: string | null): JsonObject {
    const all = loadSeriesRecords(this.options.recordsPath ?? RESULTS_PATH);
    const pool = poolParam?.trim() || null;
    const view = buildTournaments(all, this.options.runsDir ?? RUNS_DIR, pool, this.options.teamsDir ?? TEAMS_DIR);
    const matches = view.tournaments.reduce(
      (total, archive) =>
        total + archive.rounds.flat().filter((match) => match.seriesIndex !== null && match.score !== null).length,
      0,
    );
    return {
      ...view,
      summary: {
        tournaments: view.tournaments.filter((archive) => archive.rounds.flat().some((match) => match.score)).length,
        matches,
      },
    } as unknown as JsonObject;
  }

  private leaguesBody(): JsonObject {
    return buildLeagues(
      loadSeriesRecords(this.options.recordsPath ?? RESULTS_PATH),
      this.options.runsDir ?? RUNS_DIR,
    ) as unknown as JsonObject;
  }

  private leagueBody(run: string): JsonObject {
    const runId = run.trim();
    const league = buildLeague(
      loadSeriesRecords(this.options.recordsPath ?? RESULTS_PATH),
      this.options.runsDir ?? RUNS_DIR,
      runId,
    );
    if (!league) throw new HttpError(404, `no stored draft league ${JSON.stringify(run)}`);
    return league as unknown as JsonObject;
  }

  private leagueGameBody(run: string, series: string, game: string): JsonObject {
    const seriesIndex = Number(series);
    const gameNumber = Number(game);
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || !Number.isInteger(gameNumber) || gameNumber < 1) {
      throw new HttpError(400, 'series and game must be non-negative integers');
    }
    const view = buildLeagueGame(
      loadSeriesRecords(this.options.recordsPath ?? RESULTS_PATH),
      this.options.runsDir ?? RUNS_DIR,
      run.trim(),
      seriesIndex,
      gameNumber,
    );
    if (!view) throw new HttpError(404, `no stored game ${game} for series ${series} of ${JSON.stringify(run)}`);
    return view as unknown as JsonObject;
  }

  private tournamentGameBody(run: string, series: string, game: string): JsonObject {
    const seriesIndex = Number(series);
    const gameNumber = Number(game);
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || !Number.isInteger(gameNumber) || gameNumber < 1) {
      throw new HttpError(400, 'series and game must be non-negative integers');
    }
    const view = buildTournamentGame(
      loadSeriesRecords(this.options.recordsPath ?? RESULTS_PATH),
      this.options.runsDir ?? RUNS_DIR,
      run.trim(),
      seriesIndex,
      gameNumber,
      this.options.teamsDir ?? TEAMS_DIR,
    );
    if (!view) throw new HttpError(404, `no stored game ${game} for series ${series} of ${JSON.stringify(run)}`);
    return view as unknown as JsonObject;
  }

  private runBody() {
    return this.runs.snapshot();
  }

  private battleBody(index: number, game?: number) {
    return this.runs.battle(index, game);
  }

  private async modelsBody(providerId: string, apiKey: string): Promise<ModelsResponse> {
    const option = providerOption(providerId);
    if (!option) throw new HttpError(400, `unknown provider ${JSON.stringify(providerId)}`);
    try {
      const models = await discoverModels(option, apiKey.trim() || undefined, {
        signal: AbortSignal.timeout(20_000),
      });
      return { models: models.map((model) => this.modelInfo(model)) };
    } catch (error) {
      throw new HttpError(400, redactSecrets(error instanceof Error ? error.message : String(error), [apiKey]));
    }
  }

  private startRun(body: Record<string, unknown>): JsonObject {
    if (!this.runs.canStart()) throw new HttpError(409, 'a run is already in progress');
    const teamsDir = this.options.teamsDir ?? TEAMS_DIR;
    try {
      const request = parseRunRequest(body, {
        get boards() {
          return listBoards();
        },
        get pools() {
          return listPools(teamsDir);
        },
        get formats() {
          return championsFormats();
        },
        get defaultFormatId() {
          return listPools(teamsDir)[0]?.format ?? 'gen9championsvgc2026regmbbo3';
        },
        packAndValidateTeam(paste, format) {
          const packed = packTeam(paste, defaultPsDir(), format);
          validateTeam(packed, format);
          return packed;
        },
      });
      return this.runs.start(request);
    } catch (error) {
      if (error instanceof RunRequestError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  private queueBattle(index: number): void {
    this.pending.set(`battle:${index}`, () => ({ type: 'battle', ...this.battleBody(index) }));
    this.scheduleFlush();
  }

  private queueRun(): void {
    this.pending.set('run', () => ({ type: 'run', run: this.runBody() }));
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

  private broadcast(message: ServerEvent): void {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.clients.keys()) this.writeEvent(client, data);
  }

  private openEvents(response: http.ServerResponse): void {
    if (this.clients.size >= MAX_SSE_CLIENTS) throw new HttpError(503, 'too many event stream clients');
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.clients.set(response, { backpressured: false });
    if (!this.writeEvent(response, `data: ${JSON.stringify({ type: 'run', run: this.runBody() })}\n\n`)) return;
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

  private makePool(body: Record<string, unknown>): JsonObject {
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
      dir = createPool(name, format, { teams: drafts }, teamsDir);
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') {
        if (canCleanCandidate) fs.rmSync(candidateDir, { recursive: true, force: true });
        throw error;
      }
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
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
