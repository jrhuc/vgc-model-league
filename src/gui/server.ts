import fs from 'node:fs';
import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverModels, PROVIDER_OPTIONS, providerOption } from '../model-catalog.js';
import { RESULTS_PATH, TEAMS_DIR } from '../paths.js';
import type { ReasoningLevel } from '../providers.js';
import { parseSpec, REASONING_LEVELS, validateReasoning } from '../providers.js';
import { h2h, loadRows, standings } from '../records.js';
import type { RotationEvent } from '../rotation.js';
import { makeRunDirectory, ROTATION_PROTOCOL_VERSION, runRotation } from '../rotation.js';
import { loadShowdown } from '../showdown.js';
import type { MonState } from '../state.js';
import { BattleState } from '../state.js';
import type { TeamDraft } from '../teams.js';
import { createPool, inspectTeam, listPools } from '../teams.js';
import type { ExperimentMode, JsonObject, Pid } from '../types.js';
import { afterColon, isRecord } from '../value.js';
import type {
  AppState,
  BattleMessage,
  BattleSnapshot,
  FormatInfo,
  ModelsResponse,
  MonView,
  RecordsResponse,
  RunSnapshot,
  SeriesRowView,
  ServerEvent,
} from './api.js';

type SeriesRow = Omit<SeriesRowView, 'turn'>;

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gui');
const ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
  return LOCAL_HOSTNAMES.has(hostname);
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

interface RunConfig {
  mode: ExperimentMode;
  protocolVersion: number;
  models: string[];
  seriesPerPair: number;
  pool: string;
  concurrency: number;
  seed?: number;
  reasoning?: ReasoningLevel;
}

class ActiveRun {
  rows: SeriesRow[] = [];
  state: 'running' | 'done' | 'failed' = 'running';
  error = '';
  notices: string[] = [];
  seed: number | undefined;
  endTime: number | undefined;
  readonly battles = new Map<number, { game: number; state: BattleState }>();
  readonly controller = new AbortController();
  readonly runDir = makeRunDirectory();
  readonly runId = path.basename(this.runDir);
  readonly startTime = Date.now();

  constructor(
    readonly config: RunConfig,
    readonly apiKeys: Record<string, string>,
  ) {}

  clearApiKeys(): void {
    for (const model of Object.keys(this.apiKeys)) delete this.apiKeys[model];
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
  private readonly clients = new Set<http.ServerResponse>();
  private readonly pending = new Map<string, () => ServerEvent | undefined>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: { teamsDir?: string; recordsPath?: string; runner?: typeof runRotation } = {}) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) this.json(response, status, { error: message });
        else response.end();
      });
    });
  }

  listen(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}/`);
      });
    });
  }

  close(): void {
    this.run?.controller.abort();
    clearTimeout(this.flushTimer);
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!isLocalHost(request.headers.host)) throw new HttpError(403, 'requests must target 127.0.0.1 or localhost');
    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin !== undefined && !isLocalOrigin(origin)) {
        throw new HttpError(403, 'cross-origin requests are not allowed');
      }
      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new HttpError(415, 'content-type must be application/json');
      }
    }
    const key = `${request.method} ${url.pathname}`;
    if (request.method === 'GET' && !url.pathname.startsWith('/api/') && this.serveStatic(url.pathname, response)) {
      return;
    }
    if (key === 'GET /api/state') this.json(response, 200, this.stateBody());
    else if (key === 'GET /api/records') this.json(response, 200, this.recordsBody());
    else if (key === 'GET /api/events') this.openEvents(response);
    else if (key === 'GET /api/battle')
      this.json(response, 200, this.battleBody(Number(url.searchParams.get('index'))));
    else if (key === 'POST /api/models') {
      const body = await this.readJson(request);
      this.json(response, 200, await this.modelsBody(String(body.provider ?? ''), String(body.apiKey ?? '')));
    } else if (key === 'POST /api/run') this.json(response, 200, this.startRun(await this.readJson(request)));
    else if (key === 'POST /api/run/stop') {
      this.run?.controller.abort();
      this.json(response, 200, { ok: true });
    } else if (key === 'POST /api/pool') this.json(response, 200, this.makePool(await this.readJson(request)));
    else if (key === 'POST /api/team/validate')
      this.json(response, 200, this.validateDraft(await this.readJson(request)));
    else this.json(response, 404, { error: `no route for ${key}` });
  }

  private json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }

  private serveStatic(pathname: string, response: http.ServerResponse): boolean {
    const file = path.normalize(path.join(ASSETS_DIR, pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ASSETS_DIR + path.sep)) return false;
    const type = ASSET_TYPES[path.extname(file)];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    response.writeHead(200, { 'content-type': type });
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

  private stateBody(): AppState {
    const pools = listPools(this.options.teamsDir ?? TEAMS_DIR);
    return {
      pools,
      reasoningLevels: [...REASONING_LEVELS],
      defaultFormat: pools[0]?.format ?? 'gen9championsvgc2026regmbbo3',
      formats: championsFormats(),
      providers: PROVIDER_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        discovery: option.discovery,
        requiresKey: option.requiresKey,
        models: (option.models ?? []).map((model) => ({ id: model.id, label: model.displayName ?? model.id })),
      })),
      run: this.runBody(),
    };
  }

  private recordsBody(): RecordsResponse {
    const rows = loadRows(this.options.recordsPath ?? RESULTS_PATH);
    return { count: rows.length, standings: standings(rows), h2h: h2h(rows), records: rows };
  }

  private runBody(): RunSnapshot | null {
    const run = this.run;
    if (!run) return null;
    return {
      mode: run.config.mode,
      protocolVersion: run.config.protocolVersion,
      runId: run.runId,
      state: run.state,
      error: run.error,
      notices: run.notices.slice(-3),
      seed: run.seed ?? null,
      pool: run.config.pool,
      models: run.config.models,
      startTime: run.startTime,
      endTime: run.endTime ?? null,
      rows: run.rows.map((row, index) => ({ ...row, turn: run.battles.get(index)?.state.turn ?? 0 })),
    };
  }

  private battleBody(index: number): BattleMessage {
    const entry = this.run?.battles.get(index);
    if (!entry) return { index, game: 0, snapshot: null };
    return { index, game: entry.game, snapshot: snapshotBattle(entry.state, this.run?.rows[index]?.players) };
  }

  private async modelsBody(providerId: string, apiKey: string): Promise<ModelsResponse> {
    const option = providerOption(providerId);
    if (!option) throw new HttpError(400, `unknown provider ${JSON.stringify(providerId)}`);
    try {
      const models = await discoverModels(option, apiKey.trim() || undefined);
      return { models: models.map((model) => ({ id: model.id, label: model.displayName ?? model.id })) };
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  private startRun(body: Record<string, unknown>): JsonObject {
    if (this.run?.state === 'running') throw new HttpError(409, 'a run is already in progress');
    const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : [];
    if (models.length < 2) throw new HttpError(400, 'a run needs at least two model specs');
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
    const pool = String(body.pool ?? '');
    if (!listPools(this.options.teamsDir ?? TEAMS_DIR).some((info) => info.name === pool))
      throw new HttpError(400, `unknown team pool ${JSON.stringify(pool)}`);
    const seed = body.seed === undefined || body.seed === null || body.seed === '' ? undefined : Number(body.seed);
    if (seed !== undefined && !Number.isSafeInteger(seed)) throw new HttpError(400, 'seed must be an integer');
    const config: RunConfig = {
      mode: 'rotation',
      protocolVersion: ROTATION_PROTOCOL_VERSION,
      models,
      seriesPerPair: clampInt(body.seriesPerPair, 1, 20, 2),
      pool,
      concurrency: clampInt(body.concurrency, 1, 8, 2),
      ...(seed === undefined ? {} : { seed }),
      ...(reasoning === undefined ? {} : { reasoning }),
    };
    const run = new ActiveRun(config, apiKeys);
    this.run = run;
    void this.launch(run);
    this.queueRun();
    return { ok: true, runId: run.runId };
  }

  private async launch(run: ActiveRun): Promise<void> {
    try {
      await (this.options.runner ?? runRotation)(run.config.models, run.config.seriesPerPair, run.runDir, {
        pool: run.config.pool,
        concurrency: run.config.concurrency,
        recordsPath: this.options.recordsPath ?? RESULTS_PATH,
        apiKeys: run.apiKeys,
        signal: run.controller.signal,
        ...(run.config.seed === undefined ? {} : { seed: run.config.seed }),
        ...(run.config.reasoning === undefined ? {} : { reasoning: run.config.reasoning }),
        onEvent: (event) => this.onEvent(run, event),
        onNotice: (message) => run.notices.push(message),
      });
      run.state = 'done';
    } catch (error) {
      if (run.controller.signal.aborted) run.state = 'done';
      else {
        run.state = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      run.clearApiKeys();
      run.endTime = Date.now();
      this.queueRun();
    }
  }

  private onEvent(run: ActiveRun, event: RotationEvent): void {
    if (run !== this.run) return;
    if (event.type === 'plans') {
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
      const row = run.rows[event.index];
      if (row && row.status === 'running') row.game = event.game;
      this.queue(`battle:${event.index}`, () => ({ type: 'battle', ...this.battleBody(event.index) }));
    } else if (event.type === 'game-end') {
      const row = run.rows[event.index];
      if (row) {
        row.score = event.score;
        row.game = event.game + 1;
        row.turns += event.turns;
      }
    } else {
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
    this.queue('run', () => ({ type: 'run', run: this.runBody() }));
  }

  private queue(key: string, make: () => ServerEvent | undefined): void {
    this.pending.set(key, make);
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
    for (const client of this.clients) client.write(data);
  }

  private openEvents(response: http.ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({ type: 'run', run: this.runBody() })}\n\n`);
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  private makePool(body: Record<string, unknown>): JsonObject {
    const format = String(body.format ?? '');
    if (!championsFormats().some((option) => option.id === format)) {
      throw new HttpError(400, `unsupported Champions BO3 format ${JSON.stringify(format)}`);
    }
    const drafts: TeamDraft[] = (Array.isArray(body.teams) ? body.teams : []).map((entry) => {
      const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      return { id: String(record.id ?? ''), paste: String(record.paste ?? '') };
    });
    try {
      const dir = createPool(String(body.name ?? ''), format, drafts, this.options.teamsDir);
      return { ok: true, dir, pools: listPools(this.options.teamsDir ?? TEAMS_DIR) };
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  private validateDraft(body: Record<string, unknown>): JsonObject {
    const format = String(body.format ?? '');
    if (!format) throw new HttpError(400, 'format is required');
    return inspectTeam(String(body.paste ?? ''), format) as unknown as JsonObject;
  }
}

function clampInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
