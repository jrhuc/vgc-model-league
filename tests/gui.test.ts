import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { BattleLog } from '../src/gui/battlelog.js';
import { GuiServer } from '../src/gui/server.js';
import { REPO_ROOT, TEAMS_DIR } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-runs-'));
after(() => fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true }));

const FORMAT = 'gen9championsvgc2026regmbbo3';

function pasteFromPool(file: string): string {
  const { Teams } = loadShowdown();
  const packed = fs.readFileSync(path.join(TEAMS_DIR, 'test', file), 'utf8').trim();
  const team = Teams.unpack(packed);
  assert.ok(team, `test pool team ${file} should unpack`);
  return Teams.export(team);
}

async function apiJson(url: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers ?? {},
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

test('battle log turns protocol lines into a compact spectator feed', () => {
  const log = new BattleLog();
  log.feed([
    '|turn|1',
    '|move|p1a: Garchomp|Earthquake|p2a: Tornadus',
    '|-damage|p2a: Tornadus|150/250',
    '|switch|p2a: Incineroar|Incineroar, L50|100/100',
    '|faint|p2a: Incineroar',
    '|-vgctimeout|p1|autodefault',
    '|win|p1-Alpha',
  ]);
  assert.deepEqual(
    log.entries.map((entry) => [entry.kind, entry.text]),
    [
      ['turn', 'Turn 1'],
      ['move', 'Garchomp used Earthquake → Tornadus'],
      ['detail', 'Tornadus → 60%'],
      ['switch', 'P2 sent out Incineroar'],
      ['faint', 'Incineroar fainted'],
      ['timer', 'P1 ran out of time. Default action used'],
      ['win', 'Alpha (P1) won the game'],
    ],
  );
  assert.ok(!log.entries.some((entry) => entry.text.includes('—')));
});

test('gui serves the built app shell and setup state', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  try {
    const pageResponse = await fetch(base);
    const page = await pageResponse.text();
    assert.match(pageResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(pageResponse.headers.get('x-content-type-options'), 'nosniff');
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    assert.ok(asset, 'shell should reference the built client bundle with a portable relative path');
    const bundle = await fetch(new URL(asset, base));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /text\/javascript/);
    const { status, data } = await apiJson(`${base}api/state`);
    assert.equal(status, 200);
    const pools = data.pools as Array<{ name: string; teamCount: number }>;
    assert.ok(pools.some((pool) => pool.name === 'test' && pool.teamCount >= 2));
    assert.equal('reasoningLevels' in data, false);
    const providers = data.providers as Array<Record<string, unknown>>;
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ['openrouter', 'prime', 'gateway', 'random'],
    );
    assert.ok(providers.every((provider) => !('envKey' in provider) && !('keyPresent' in provider)));
    assert.ok(providers.every((provider) => !('models' in provider)));
    const formats = data.formats as Array<{ id: string; label: string }>;
    assert.ok(formats.some((format) => format.id === FORMAT));
    assert.ok(formats.every((format) => format.id.startsWith('gen9champions') && format.id.endsWith('bo3')));
    assert.equal('auth' in data, false);
    assert.equal(data.run, null);
    assert.equal(data.externalRun, null);
    assert.equal((await fetch(`${base}healthz`)).status, 200);
    assert.equal((await fetch(`${base}readyz`)).status, 200);
    const missing = await fetch(`${base}api/nothing`);
    assert.equal(missing.status, 404);
    const catalogGet = await fetch(`${base}api/models?provider=openrouter`);
    assert.equal(catalogGet.status, 404);
    const manualPrime = await apiJson(`${base}api/models`, { provider: 'prime', apiKey: 'browser-key' });
    assert.equal(manualPrime.status, 400);
    assert.match(String(manualPrime.data.error), /manual model IDs/);
    const removedProvider = await apiJson(`${base}api/models`, { provider: 'anthropic', apiKey: 'browser-key' });
    assert.equal(removedProvider.status, 400);
    assert.match(String(removedProvider.data.error), /unknown provider/);
  } finally {
    gui.close();
  }
});

test('live run identifies an external CLI tournament instead of labeling every run as a draft league', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-external-run-'));
  const draftId = '20260806T200000.000000Z-draft000';
  const tournamentId = '20260806T210000.000000Z-cup00000';
  for (const [runId, mode] of [
    [draftId, 'draft'],
    [tournamentId, 'tournament'],
  ] as const) {
    const runDir = path.join(runsDir, runId);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify({ mode })}\n`, 'utf8');
    fs.writeFileSync(
      path.join(runDir, 'status.json'),
      `${JSON.stringify({ state: 'running', pid: process.pid, start_time: new Date().toISOString() })}\n`,
      'utf8',
    );
  }
  const gui = new GuiServer({ runsDir });
  const base = await gui.listen(0);
  try {
    const { data } = await apiJson(`${base}api/state`);
    assert.deepEqual(data.externalRun, { runId: tournamentId, mode: 'tournament' });
  } finally {
    gui.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('gui rejects spoofed hosts, cross-origin posts, and non-json posts', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const port = Number(new URL(base).port);
  try {
    assert.equal(await rawRequest(port, { path: '/api/state', headers: { host: 'evil.example' } }), 403);
    assert.equal(
      await rawRequest(port, {
        method: 'POST',
        path: '/api/run/stop',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      }),
      403,
    );
    assert.equal(
      await rawRequest(port, {
        method: 'POST',
        path: '/api/run/stop',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }),
      415,
    );
    assert.equal(
      await rawRequest(port, {
        method: 'POST',
        path: '/api/run/stop',
        headers: { 'content-type': 'application/json', origin: base.slice(0, -1) },
        body: '{}',
      }),
      200,
    );
    assert.equal(await rawRequest(port, { path: '/assets/../package.json' }), 404);
  } finally {
    gui.close();
  }
});

test('gui validates teambuilder pastes and creates immutable pools', async () => {
  const teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-gui-pools-'));
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    teamsDir,
  });
  const base = await gui.listen(0);
  try {
    const pasteA = pasteFromPool('jpnats-mega-swampert.team');
    const pasteAWithTera = pasteA.replace(/\nAbility:/g, '\nTera Type: Fire\nAbility:');
    const pasteB = pasteFromPool('wolfe-mega-raichu-y.team');

    const legal = await apiJson(`${base}api/team/validate`, { paste: pasteAWithTera, format: FORMAT });
    assert.equal(legal.status, 200);
    assert.deepEqual(legal.data.problems, []);
    assert.equal((legal.data.species as string[]).length, 6);
    const members = legal.data.members as Array<{
      species: string;
      item: string;
      ability: string;
      moves: string[];
    }>;
    assert.equal(members.length, 6);
    assert.deepEqual(
      members.map((member) => member.species),
      legal.data.species,
    );
    for (const member of members) {
      assert.ok(member.species);
      assert.ok(member.item);
      assert.ok(member.ability);
      assert.ok(member.moves.length);
      assert.equal('teraType' in member, false);
    }

    const illegal = await apiJson(`${base}api/team/validate`, {
      paste: 'Mewtwo @ Leftovers\nAbility: Pressure\n- Psystrike',
      format: FORMAT,
    });
    assert.ok((illegal.data.problems as string[]).length > 0);
    assert.equal((illegal.data.members as unknown[]).length, 1);

    const unparseable = await apiJson(`${base}api/team/validate`, { paste: '', format: FORMAT });
    assert.ok((unparseable.data.problems as string[]).length > 0);
    assert.deepEqual(unparseable.data.members, []);

    const created = await apiJson(`${base}api/pool`, {
      name: 'gui-pool',
      format: FORMAT,
      teams: [
        { id: 'team-a', paste: pasteAWithTera },
        { id: 'team-b', paste: pasteB },
      ],
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const unsupported = await apiJson(`${base}api/pool`, {
      name: 'unsupported-pool',
      format: 'gen9doublescustomgamebo3',
      teams: [
        { id: 'team-a', paste: pasteA },
        { id: 'team-b', paste: pasteB },
      ],
    });
    assert.equal(unsupported.status, 400);
    assert.match(String(unsupported.data.error), /unsupported Champions BO3 format/);
    const pool = loadPool('gui-pool', teamsDir);
    assert.equal(pool.format, FORMAT);
    assert.equal(pool.teams.length, 2);
    const servedPool = await apiJson(`${base}api/pool/teams?name=gui-pool`);
    assert.equal(servedPool.status, 200);
    assert.doesNotMatch(JSON.stringify(servedPool.data), /Tera Type|teraType/i);
    const state = await apiJson(`${base}api/state`);
    assert.equal(state.status, 200);
    assert.doesNotMatch(JSON.stringify(state.data.sampleTeams), /Tera Type|teraType/i);

    const duplicateName = await apiJson(`${base}api/pool`, {
      name: 'gui-pool',
      format: FORMAT,
      teams: [
        { id: 'team-a', paste: pasteA },
        { id: 'team-b', paste: pasteB },
      ],
    });
    assert.equal(duplicateName.status, 400);
    assert.match(String(duplicateName.data.error), /already exists/);

    const duplicateTeam = await apiJson(`${base}api/pool`, {
      name: 'gui-pool-2',
      format: FORMAT,
      teams: [
        { id: 'team-a', paste: pasteA },
        { id: 'team-a-again', paste: pasteA },
      ],
    });
    assert.equal(duplicateTeam.status, 400);
    assert.match(String(duplicateTeam.data.error), /byte-for-byte the same team/);

    const respread = await apiJson(`${base}api/pool`, {
      name: 'gui-pool-3',
      format: FORMAT,
      teams: [
        { id: 'team-a', paste: pasteA },
        { id: 'team-a-respread', paste: pasteA.replace(/^EVs: .*$/m, 'EVs: 1 HP') },
      ],
    });
    assert.equal(respread.status, 200, JSON.stringify(respread.data));
    assert.equal(loadPool('gui-pool-3', teamsDir).teams.length, 2);
  } finally {
    gui.close();
    fs.rmSync(teamsDir, { recursive: true, force: true });
  }
});

test('gui exposes OpenRouter reasoning controls only from catalog capability data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === 'https://openrouter.ai/api/v1/models') {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'vendor/reasoning', supported_parameters: ['reasoning'] },
            { id: 'vendor/default-only', supported_parameters: ['tools'] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  try {
    const response = await apiJson(`${base}api/models`, { provider: 'openrouter', apiKey: 'browser-key' });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(response.data.models, [
      { id: 'vendor/default-only', label: 'vendor/default-only', reasoningLevels: [] },
      {
        id: 'vendor/reasoning',
        label: 'vendor/reasoning',
        reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      },
    ]);
  } finally {
    gui.close();
    globalThis.fetch = originalFetch;
  }
});

test('gui requires browser credentials and never exposes server keys', async () => {
  const previous = process.env.PRIME_API_KEY;
  process.env.PRIME_API_KEY = 'server-secret-must-not-be-used';
  let receivedKeys: Record<string, string> | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      receivedKeys = { ...options.apiKeys };
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const removed = await apiJson(`${base}api/run`, {
      models: ['anthropic:test-model', 'random'],
      pool: 'test',
      apiKeys: { 'anthropic:test-model': 'browser-run-secret' },
    });
    assert.equal(removed.status, 400);
    assert.match(String(removed.data.error), /openrouter:<model-id>, prime:<model-id>, gateway:<model-id>, or random/);

    const missing = await apiJson(`${base}api/run`, {
      models: ['prime:test-model', 'random'],
      pool: 'test',
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.data.error), /API key required for/);
    assert.doesNotMatch(JSON.stringify(missing.data), /server-secret/);

    const started = await apiJson(`${base}api/run`, {
      models: ['prime:test-model', 'random'],
      pool: 'test',
      apiKeys: { 'prime:test-model': 'browser-run-secret' },
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.deepEqual(receivedKeys, { 'prime:test-model': 'browser-run-secret' });
    const state = await apiJson(`${base}api/state`);
    assert.doesNotMatch(JSON.stringify(state.data), /browser-run-secret|server-secret/);
  } finally {
    gui.close();
    if (previous === undefined) delete process.env.PRIME_API_KEY;
    else process.env.PRIME_API_KEY = previous;
  }
});

test('gui Nitro launch maps raw model credentials and reasoning to the effective spec', async () => {
  let receivedModels: readonly string[] | undefined;
  let receivedKeys: Readonly<Record<string, string>> | undefined;
  let receivedReasoning: Readonly<Record<string, string>> | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (models, _seriesPerPair, _runDir, options = {}) => {
      receivedModels = [...models];
      receivedKeys = { ...options.apiKeys };
      receivedReasoning = options.reasoningByModel ? { ...options.reasoningByModel } : undefined;
      return [];
    },
  });
  const base = await gui.listen(0);
  const raw = 'openrouter:vendor/test-model';
  const effective = `${raw}:nitro`;
  try {
    const started = await apiJson(`${base}api/run`, {
      models: [raw, 'random'],
      apiKeys: { [raw]: 'browser-nitro-key' },
      reasoningByModel: { [raw]: 'high' },
      nitro: true,
      pool: 'test',
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.deepEqual(receivedModels, [effective, 'random']);
    assert.deepEqual(receivedKeys, { [effective]: 'browser-nitro-key' });
    assert.deepEqual(receivedReasoning, { [effective]: 'high' });
  } finally {
    gui.close();
  }
});

test('local GUI accepts only registered, well-formed provider specs', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  try {
    for (const model of ['unknown:model', 'openrouter:', 'prime:', 'random:extra']) {
      const rejected = await apiJson(`${base}api/run`, { models: [model, 'random'], pool: 'test' });
      assert.equal(rejected.status, 400);
    }
  } finally {
    gui.close();
  }
});

test('gui accepts only explicit OpenRouter reasoning levels', async () => {
  let received: Record<string, string> | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      received = options.reasoningByModel ? { ...options.reasoningByModel } : undefined;
      return [];
    },
  });
  const base = await gui.listen(0);
  const models = ['openrouter:vendor/model-a', 'openrouter:vendor/model-b'];
  const apiKeys = Object.fromEntries(models.map((model) => [model, 'browser-key']));
  try {
    assert.equal((await fetch(`${base}api/reasoning?spec=openrouter%3Avendor%2Fmodel-a`)).status, 404);

    const removedOff = await apiJson(`${base}api/run`, {
      models,
      apiKeys,
      pool: 'test',
      reasoning: 'off',
    });
    assert.equal(removedOff.status, 400);
    assert.match(String(removedOff.data.error), /reasoning must be one of/);

    const primeUnknown = await apiJson(`${base}api/run`, {
      models: ['prime:model-a', 'random'],
      apiKeys: { 'prime:model-a': 'browser-key' },
      pool: 'test',
      reasoning: 'low',
    });
    assert.equal(primeUnknown.status, 400);
    assert.match(String(primeUnknown.data.error), /no advertised configurable reasoning/);

    const ambiguous = await apiJson(`${base}api/run`, {
      models,
      apiKeys,
      pool: 'test',
      reasoning: 'low',
      reasoningByModel: { 'openrouter:vendor/model-b': 'minimal' },
    });
    assert.equal(ambiguous.status, 400);
    assert.match(String(ambiguous.data.error), /either shared reasoning or per-model reasoning/);

    const started = await apiJson(`${base}api/run`, {
      models,
      apiKeys,
      pool: 'test',
      reasoningByModel: {
        'openrouter:vendor/model-a': 'high',
        'openrouter:vendor/model-b': 'minimal',
      },
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.deepEqual(received, {
      'openrouter:vendor/model-a': 'high',
      'openrouter:vendor/model-b': 'minimal',
    });
  } finally {
    gui.close();
  }
});

test('gui validates the timer scale and forwards it to the runner', async () => {
  let received: unknown = 'unset';
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      received = options.timerScale;
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const invalid = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test', timerScale: 9 });
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.data.error), /timer scale must be/);

    const scaled = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test', timerScale: 1.5 });
    assert.equal(scaled.status, 200, JSON.stringify(scaled.data));
    assert.equal(received, 1.5);
    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    for (let attempt = 0; attempt < 40 && run.state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    }

    const untimed = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test', timerScale: 'off' });
    assert.equal(untimed.status, 200, JSON.stringify(untimed.data));
    assert.equal(received, 'off');
  } finally {
    gui.close();
  }
});

test('gui rejects a second run while one is active and stops on request', async () => {
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: (_models, _seriesPerPair, _runDir, options = {}) =>
      new Promise((resolve) => {
        options.onEvent?.({
          mode: 'rotation',
          protocolVersion: 1,
          type: 'plans',
          plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
          pool: 'test',
          seed: 7,
        });
        options.signal?.addEventListener('abort', () => resolve([]));
      }),
  });
  const base = await gui.listen(0);
  try {
    const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(started.status, 200, JSON.stringify(started.data));

    const rejected = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(rejected.status, 409);

    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    assert.equal(run.state, 'running');
    assert.equal(run.seed, 7);
    assert.equal(run.mode, 'rotation');
    assert.equal(run.protocolVersion, 1);
    assert.equal((run.rows as unknown[]).length, 1);

    await apiJson(`${base}api/run/stop`, {});
    for (let attempt = 0; attempt < 40 && run.state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    }
    assert.equal(run.state, 'stopped');
  } finally {
    gui.close();
  }
});

test('recoverable provider failures pause and resume the same run', async () => {
  const paused = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      options.onEvent?.({
        mode: 'rotation',
        protocolVersion: 1,
        type: 'plans',
        plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
        pool: 'test',
        seed: 11,
      });
      const waiting = options.recovery!.pause(
        'prime:test-model',
        { kind: 'quota', summary: 'Prime Inference API quota is exhausted.' },
        options.signal,
      );
      paused.resolve();
      await waiting;
      resumed.resolve();
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    await paused.promise;

    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    assert.equal(run.state, 'paused');
    const pause = run.pause as Record<string, unknown>;
    assert.equal(pause.model, 'prime:test-model');
    assert.equal(pause.kind, 'quota');
    assert.equal(pause.message, 'Prime Inference API quota is exhausted.');
    assert.equal(typeof pause.since, 'number');

    const rejected = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(rejected.status, 409);
    assert.equal((await apiJson(`${base}api/run/resume`, {})).status, 200);
    await resumed.promise;
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;

    run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    assert.equal(run.state, 'done');
    assert.equal(run.pause, null);
  } finally {
    gui.close();
  }
});

test('a run whose task ignores the stop abort is detached so new runs can start', async () => {
  let launches = 0;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    stopFallbackMs: 100,
    runner: (_models, _seriesPerPair, _runDir, options = {}) => {
      launches += 1;
      if (launches > 1) return Promise.resolve([]);
      options.onEvent?.({
        mode: 'rotation',
        protocolVersion: 1,
        type: 'plans',
        plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
        pool: 'test',
        seed: 7,
      });
      return new Promise(() => {});
    },
  });
  const base = await gui.listen(0);
  try {
    const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const firstRunId = String(started.data.runId);

    await apiJson(`${base}api/run/stop`, {});
    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    assert.equal(run.state, 'running');
    for (let attempt = 0; attempt < 40 && run.state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    }
    assert.equal(run.state, 'stopped');
    const status = JSON.parse(fs.readFileSync(path.join(RUNS_SCRATCH, firstRunId, 'status.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(status.state, 'stopped');

    const second = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.notEqual(second.data.runId, firstRunId);
  } finally {
    gui.close();
  }
});

test('pokepaste import fetches the raw paste and rejects non-pokepaste links', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://pokepast.es/')) return realFetch(input, init);
    requested.push(url);
    return new Response('Gengar @ Gengarite\nAbility: Cursed Body\n', { status: 200 });
  }) as typeof fetch;
  try {
    const imported = await apiJson(`${base}api/team/pokepaste`, { url: 'https://pokepast.es/af47b5292e00a94d' });
    assert.equal(imported.status, 200);
    assert.match(String(imported.data.paste), /Gengar @ Gengarite/);
    assert.deepEqual(requested, ['https://pokepast.es/af47b5292e00a94d/raw']);

    const bare = await apiJson(`${base}api/team/pokepaste`, { url: 'af47b5292e00a94d' });
    assert.equal(bare.status, 200);

    const rejected = await apiJson(`${base}api/team/pokepaste`, { url: 'https://evil.example/af47b5292e00a94d' });
    assert.equal(rejected.status, 400);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    gui.close();
  }
});

test('shutdown labels a wedged run before the process exits', async () => {
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: () => new Promise(() => {}),
  });
  const base = await gui.listen(0);
  const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  await gui.shutdown(50);
  const status = JSON.parse(
    fs.readFileSync(path.join(RUNS_SCRATCH, String(started.data.runId), 'status.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'run interrupted by server shutdown');
});

test('gui aborts runs that exceed the configured duration', async () => {
  const timedOut = Promise.withResolvers<void>();
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    maxRunMs: 1,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      const aborted = Promise.withResolvers<void>();
      options.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      timedOut.resolve();
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    await timedOut.promise;
    await new Promise(setImmediate);
    const run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    assert.equal(run.state, 'failed');
    assert.equal(run.error, 'run exceeded its maximum duration');
  } finally {
    gui.close();
  }
});

test('server shutdown marks an active run as failed', async () => {
  const settled = Promise.withResolvers<Record<string, unknown>>();
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      const aborted = Promise.withResolvers<void>();
      options.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      return [];
    },
    logger: (entry) => {
      if (entry.event === 'run_finished') settled.resolve(entry);
    },
  });
  const base = await gui.listen(0);
  const started = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'test' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  await gui.shutdown(1_000);
  assert.equal((await settled.promise).state, 'failed');
});

test('gui runs a random-vs-random series and streams live battle state', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-gui-run-'));
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    recordsPath: path.join(scratch, 'results.jsonl'),
  });
  const base = await gui.listen(0);
  const sse = new AbortController();
  let stream = '';
  try {
    const events = await fetch(`${base}api/events`, { signal: sse.signal });
    const pump = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of events.body!) stream += decoder.decode(chunk as Uint8Array, { stream: true });
    })().catch(() => {});

    const badSpec = await apiJson(`${base}api/run`, { models: ['random', 'not-a-spec'], pool: 'test' });
    assert.equal(badSpec.status, 400);

    const badPool = await apiJson(`${base}api/run`, { models: ['random', 'random'], pool: 'no-such-pool' });
    assert.equal(badPool.status, 400);

    const started = await apiJson(`${base}api/run`, {
      models: ['random', 'random'],
      pool: 'test',
      seriesPerPair: 1,
      concurrency: 1,
      seed: 1,
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));

    let run: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const { data } = await apiJson(`${base}api/state`);
      run = data.run as Record<string, unknown> | null;
      if (run && run.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(run, 'run should be reported');
    assert.equal(run.state, 'done', String(run.error ?? ''));
    assert.equal(run.mode, 'rotation');
    assert.equal(run.protocolVersion, 1);
    assert.match((run.notices as string[]).join('\n'), /odd .*unmirrored/);
    const rows = run.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'done');
    assert.ok(Number(rows[0]!.turns) > 0);

    const battle = await apiJson(`${base}api/battle?index=0`);
    const snapshot = battle.data.snapshot as Record<string, unknown>;
    assert.ok(snapshot, 'final battle snapshot should be retained');
    assert.ok(Number(snapshot.turn) >= 1);
    const sides = snapshot.sides as Record<string, { player: string; mons: Array<Record<string, unknown>> }>;
    assert.equal(sides.p1!.player, 'random');
    assert.ok(sides.p1!.mons.length > 0);
    for (const mon of sides.p1!.mons) {
      assert.match(
        String(mon.spriteId),
        /^[a-z0-9-]+$/,
        `the server resolves a sprite id for ${String(mon.species)} so the arena is not text-only`,
      );
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, 'src', 'gui', 'client', 'public', 'sprites', `${String(mon.spriteId)}.png`)),
        `sprite for ${String(mon.species)} must be vendored`,
      );
    }
    const games = battle.data.games as number[];
    assert.ok(games.length >= 2, 'a finished bo3 should retain each game');
    assert.equal(battle.data.game, games[games.length - 1], 'the default view is the latest game');
    const first = await apiJson(`${base}api/battle?index=0&game=1`);
    assert.equal(first.data.game, 1);
    const firstSnapshot = first.data.snapshot as Record<string, unknown>;
    assert.ok(firstSnapshot, 'game 1 stays viewable after the series ends');
    assert.ok(Number(firstSnapshot.turn) >= 1);

    const records = await apiJson(`${base}api/records?pool=test`);
    assert.equal(records.status, 404, 'the unused aggregate records endpoint stays unavailable');
    const evidence = await apiJson(`${base}api/evidence?pool=test`);
    assert.equal(evidence.status, 404, 'the unused aggregate evidence endpoint stays unavailable');

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (/"type":"battle"/.test(stream) && /"type":"run"/.test(stream)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    sse.abort();
    await pump;
    assert.match(stream, /"type":"run"/);
    assert.match(stream, /"type":"battle"/);
  } finally {
    sse.abort();
    gui.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('gui starts tournament runs and mirrors bracket state', async () => {
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    tournamentRunner: async (_models, _runDir, options = {}) => {
      options.onEvent?.({
        type: 'plans',
        mode: 'tournament',
        protocolVersion: 1,
        plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
        pool: 'test',
        seed: 9,
      });
      options.onEvent?.({
        type: 'bracket',
        bracket: {
          entrants: [
            { model: 'random', team: 'team-a' },
            { model: 'random', team: 'team-b' },
          ],
          rounds: [[{ seriesIndex: 0, slots: [0, 1], winner: 0 }]],
          champion: 0,
        },
      });
      options.onEvent?.({ type: 'series-start', index: 0 });
      options.onEvent?.({
        type: 'game-update',
        index: 0,
        game: 1,
        lines: ['|turn|7', '|-vgcdeciding|p2'],
        publicLines: ['|turn|7', '|-vgcdeciding|p2'],
      });
      options.onEvent?.({
        type: 'decision',
        index: 0,
        pid: 'p1',
        row: {
          kind: 'decision',
          game_number: 1,
          turn: 7,
          phase: 'turn',
          selection: [],
          rationale: 'No decision was submitted; the battle timer decides.',
          automatic: false,
          fallback: true,
          error_summary: 'Google API quota is exhausted (429).',
          error: 'raw upstream response',
          latency_ms: 12_400,
          total_tokens: 45_000,
        },
      });
      options.onEvent?.({
        type: 'decision',
        index: 0,
        pid: 'p1',
        row: { kind: 'game_reflection', game_number: 1, total_tokens: 5_000 },
      });
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const started = await apiJson(`${base}api/run`, { mode: 'tournament', models: ['random', 'random'], pool: 'test' });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    for (let attempt = 0; attempt < 40 && run.state !== 'done'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    }
    assert.equal(run.state, 'done', String(run.error ?? ''));
    assert.equal(run.mode, 'tournament');
    assert.equal((run.rows as unknown[]).length, 1);
    const bracket = run.bracket as Record<string, unknown>;
    assert.equal(bracket.champion, 0);
    assert.equal((bracket.entrants as unknown[]).length, 2);
    const battle = await apiJson(`${base}api/battle?index=0`);
    const snapshot = battle.data.snapshot as Record<string, unknown>;
    const decisions = snapshot.decisions as Array<Record<string, unknown>>;
    assert.equal(decisions[0]!.error, 'Google API quota is exhausted (429).');
    const spend = snapshot.spend as Record<string, { seconds: number; tokens: number }>;
    assert.deepEqual(spend.p1, { seconds: 12, tokens: 50_000 }, 'decision and reflection spend accumulate');
    assert.deepEqual(spend.p2, { seconds: 0, tokens: 0 });
    const timers = snapshot.timers as Record<string, Record<string, unknown> | null>;
    assert.equal(timers.p2?.running, true, 'the deciding marker starts an untimed clock');
    assert.equal(timers.p2?.seconds, null);
    assert.equal(typeof timers.p2?.elapsedSeconds, 'number');
  } finally {
    gui.close();
  }
});

test('gui validates inline match teams and hands packed teams to the tournament', async () => {
  let received: { teams?: Array<{ id: string; packed: string }>; format?: string; pool?: string } | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    tournamentRunner: async (_models, _runDir, options = {}) => {
      received = {
        ...(options.teams ? { teams: options.teams } : {}),
        ...(options.format ? { format: options.format } : {}),
        ...(options.pool ? { pool: options.pool } : {}),
      };
      return [];
    },
  });
  const base = await gui.listen(0);
  const pasteA = pasteFromPool('wolfe-mega-raichu-y.team');
  const pasteB = pasteFromPool('rios-mega-raichu-x-venusaur.team');
  try {
    const state = await apiJson(`${base}api/state`);
    const sampleTeams = state.data.sampleTeams as Array<{ name: string; paste: string }>;
    assert.equal(sampleTeams.length, 2, 'the default pool provides two sample teams');
    assert.ok(sampleTeams.every((team) => team.name && team.paste.trim().length > 0));

    const mismatch = await apiJson(`${base}api/run`, {
      mode: 'tournament',
      models: ['random', 'random'],
      teams: [pasteA],
    });
    assert.equal(mismatch.status, 400);
    assert.match(String(mismatch.data.error), /one team paste per model/);

    const illegal = await apiJson(`${base}api/run`, {
      mode: 'tournament',
      models: ['random', 'random'],
      teams: [pasteA, 'Pikachu'],
      format: FORMAT,
    });
    assert.equal(illegal.status, 400);
    assert.match(String(illegal.data.error), /team 2 is not legal/);

    const started = await apiJson(`${base}api/run`, {
      mode: 'tournament',
      models: ['random', 'random'],
      teams: [pasteA, pasteB],
      format: FORMAT,
      concurrency: 1,
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    for (let attempt = 0; attempt < 40 && received === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(received, 'the tournament runner receives the run');
    assert.equal(received.pool, undefined, 'inline teams replace the pool');
    assert.equal(received.format, FORMAT);
    assert.deepEqual(
      received.teams?.map((team) => team.id),
      ['paste-1', 'paste-2'],
    );
    assert.ok(received.teams?.every((team) => team.packed.includes('|')));
  } finally {
    gui.close();
  }
});

test('gui starts draft runs, validates the board, and mirrors draft state', async () => {
  let received:
    | {
        board?: string;
        closedSheets?: boolean;
        sequentialWeeks?: boolean;
        tradeWindow?: { afterWeek: number; tradesAllowed: number } | null;
      }
    | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    draftRunner: async (_models, _runDir, options = {}) => {
      received = {
        ...(options.board ? { board: options.board } : {}),
        ...(options.closedSheets === true ? { closedSheets: true } : {}),
        ...(options.sequentialWeeks === true ? { sequentialWeeks: true } : {}),
        ...(options.tradeWindow === undefined ? {} : { tradeWindow: options.tradeWindow }),
      };
      options.onEvent?.({
        type: 'draft',
        draft: {
          boardId: options.board ?? '',
          budget: 100,
          picksPerEntrant: 10,
          entrants: ['random', 'random'],
          teamNames: ['Test Tauros', 'Rival Rotoms'],
          teambuilds: [],
          week: 1,
          weeks: 1,
          picks: [{ pick: 1, entrant: 0, mon: 'garchomp', rationale: 'strong pick', fallback: false }],
          rosters: [['garchomp'], []],
          budgets: [50, 70],
          table: null,
          phase: 'draft',
        },
      });
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const state = await apiJson(`${base}api/state`);
    const boards = state.data.boards as Array<Record<string, unknown>>;
    assert.ok(boards.length >= 1, 'the bundled draft board is advertised');
    assert.equal(boards[0]!.id, 'regmb-202607');

    const unknown = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: ['random', 'random'],
      board: 'nope',
    });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.data.error), /unknown draft board/);

    const unknownBoard = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: ['random', 'random'],
      board: 'not-a-board',
    });
    assert.equal(unknownBoard.status, 400);
    assert.match(String(unknownBoard.data.error), /unknown draft board/);

    const tooMany = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: Array.from({ length: 9 }, () => 'random'),
      board: 'regmb-202607',
    });
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.data.error), /supports at most/);
    const invalidWindow = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: ['random', 'random'],
      board: 'regmb-202607',
      tradeWindow: { afterWeek: 2 },
    });
    assert.equal(invalidWindow.status, 400);
    assert.match(String(invalidWindow.data.error), /between 1 and 1/);
    const invalidOfferCap = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: ['random', 'random'],
      board: 'regmb-202607',
      tradeWindow: { afterWeek: 1, tradesAllowed: 4 },
    });
    assert.equal(invalidOfferCap.status, 400);
    assert.match(String(invalidOfferCap.data.error), /between 0 and 3/);

    const started = await apiJson(`${base}api/run`, {
      mode: 'draft',
      models: ['random', 'random'],
      board: 'regmb-202607',
      closedSheets: true,
      sequentialWeeks: true,
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    let run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    for (let attempt = 0; attempt < 40 && run.state !== 'done'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await apiJson(`${base}api/state`)).data.run as Record<string, unknown>;
    }
    assert.equal(run.state, 'done', String(run.error ?? ''));
    assert.equal(run.mode, 'draft');
    assert.equal(run.board, 'regmb-202607');
    assert.equal(received?.board, 'regmb-202607');
    assert.equal(received?.closedSheets, true, 'closed team sheets reach the draft runner');
    assert.equal(received?.sequentialWeeks, true, 'sequential weeks reach the draft runner');
    assert.deepEqual(
      received?.tradeWindow,
      { afterWeek: 1, tradesAllowed: 1 },
      'free agency defaults to the final week in a short league',
    );
    const draft = run.draft as Record<string, unknown>;
    assert.equal(draft.phase, 'draft');
    const picks = draft.picks as Array<Record<string, unknown>>;
    assert.equal(picks[0]!.rationale, 'strong pick');
  } finally {
    gui.close();
  }
});
