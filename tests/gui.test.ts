import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GuiServer } from '../src/gui/server.js';
import { TEAMS_DIR } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';

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

test('gui serves the built app shell and setup state', async () => {
  const gui = new GuiServer();
  const base = await gui.listen(0);
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /VGC Model League — Match control/);
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    assert.ok(asset, 'shell should reference the built client bundle with a portable relative path');
    const bundle = await fetch(new URL(asset, base));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /text\/javascript/);
    const { status, data } = await apiJson(`${base}api/state`);
    assert.equal(status, 200);
    const pools = data.pools as Array<{ name: string; teamCount: number }>;
    assert.ok(pools.some((pool) => pool.name === 'test' && pool.teamCount >= 2));
    assert.equal((data.reasoningLevels as string[]).length, 7);
    const providers = data.providers as Array<Record<string, unknown>>;
    assert.ok(providers.some((provider) => provider.id === 'anthropic'));
    assert.ok(providers.every((provider) => !('envKey' in provider) && !('keyPresent' in provider)));
    const meta = providers.find((provider) => provider.id === 'meta');
    assert.deepEqual(meta?.models, [{ id: 'muse-spark-1.1', label: 'Muse Spark 1.1' }]);
    const formats = data.formats as Array<{ id: string; label: string }>;
    assert.ok(formats.some((format) => format.id === FORMAT));
    assert.ok(formats.every((format) => format.id.startsWith('gen9champions') && format.id.endsWith('bo3')));
    assert.equal(data.run, null);
    const missing = await fetch(`${base}api/nothing`);
    assert.equal(missing.status, 404);
    const serverKeyCatalog = await fetch(`${base}api/models?provider=anthropic`);
    assert.equal(serverKeyCatalog.status, 404);
    const browserKeyRequired = await apiJson(`${base}api/models`, { provider: 'anthropic', apiKey: '' });
    assert.equal(browserKeyRequired.status, 400);
  } finally {
    gui.close();
  }
});

test('gui rejects spoofed hosts, cross-origin posts, and non-json posts', async () => {
  const gui = new GuiServer();
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
  const gui = new GuiServer({ teamsDir });
  const base = await gui.listen(0);
  try {
    const pasteA = pasteFromPool('jpnats-mega-swampert.team');
    const pasteB = pasteFromPool('wolfe-mega-raichu-y.team');

    const legal = await apiJson(`${base}api/team/validate`, { paste: pasteA, format: FORMAT });
    assert.equal(legal.status, 200);
    assert.deepEqual(legal.data.problems, []);
    assert.equal((legal.data.species as string[]).length, 6);
    const members = legal.data.members as Array<{
      species: string;
      item: string;
      ability: string;
      moves: string[];
      teraType: string;
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
      assert.equal(typeof member.teraType, 'string');
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
        { id: 'team-a', paste: pasteA },
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

    const duplicateSpecies = await apiJson(`${base}api/pool`, {
      name: 'gui-pool-2',
      format: FORMAT,
      teams: [
        { id: 'team-a', paste: pasteA },
        { id: 'team-a-again', paste: pasteA },
      ],
    });
    assert.equal(duplicateSpecies.status, 400);
    assert.match(String(duplicateSpecies.data.error), /same species set/);
  } finally {
    gui.close();
    fs.rmSync(teamsDir, { recursive: true, force: true });
  }
});

test('gui requires browser credentials and never exposes server keys', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'server-secret-must-not-be-used';
  let receivedKeys: Record<string, string> | undefined;
  const gui = new GuiServer({
    runner: async (_models, _seriesPerPair, _runDir, options = {}) => {
      receivedKeys = { ...options.apiKeys };
      return [];
    },
  });
  const base = await gui.listen(0);
  try {
    const missing = await apiJson(`${base}api/run`, {
      models: ['anthropic:test-model', 'random'],
      pool: 'test',
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.data.error), /bring an API key/);
    assert.doesNotMatch(JSON.stringify(missing.data), /server-secret/);

    const started = await apiJson(`${base}api/run`, {
      models: ['anthropic:test-model', 'random'],
      pool: 'test',
      apiKeys: { 'anthropic:test-model': 'browser-run-secret' },
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.deepEqual(receivedKeys, { 'anthropic:test-model': 'browser-run-secret' });
    const state = await apiJson(`${base}api/state`);
    assert.doesNotMatch(JSON.stringify(state.data), /browser-run-secret|server-secret/);
  } finally {
    gui.close();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('gui rejects a second run while one is active and stops on request', async () => {
  const gui = new GuiServer({
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
    assert.equal(run.state, 'done');
  } finally {
    gui.close();
  }
});

test('gui runs a random-vs-random series and streams live battle state', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-gui-run-'));
  const gui = new GuiServer({ recordsPath: path.join(scratch, 'results.jsonl') });
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
    const sides = snapshot.sides as Record<string, { player: string; mons: unknown[] }>;
    assert.equal(sides.p1!.player, 'random');
    assert.ok(sides.p1!.mons.length > 0);

    const records = await apiJson(`${base}api/records`);
    assert.equal(records.status, 200);
    assert.equal(records.data.count, 1);
    const standings = records.data.standings as Array<Record<string, unknown>>;
    assert.equal(standings.length, 1);
    assert.equal(standings[0]!.spec, 'random');
    assert.equal(standings[0]!.series, 2);
    const h2h = records.data.h2h as Record<string, Record<string, [number, number, number]>>;
    assert.ok(h2h.random!.random);

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
