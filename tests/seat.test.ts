import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runExhibition } from '../src/exhibition.js';
import type { SeriesRecord } from '../src/records.js';
import { loadSeriesRecords, scopeRows } from '../src/records.js';
import { SeatBridge } from '../src/seat.js';

test('unscoped play data includes exhibitions without turning them into a ranking', () => {
  const rows = [
    { mode: 'rotation', pool: 'regmb', players: { p1: 'a', p2: 'b' }, winner: 'a' },
    { mode: 'exhibition', pool: 'regmb', players: { p1: 'cli-agent', p2: 'b' }, winner: 'b' },
  ] as SeriesRecord[];
  assert.equal(scopeRows(rows).length, 2);
  assert.equal(scopeRows(rows, 'regmb').length, 2);
});

test('seat bridge keeps a pending exchange, tools, and private context behind one token', async () => {
  const lookups: string[] = [];
  const bridge = new SeatBridge({
    lookup: (name, args) => {
      lookups.push(name);
      return `result for ${String(args.name)}`;
    },
    context: (query) => ({ query }),
  });
  const url = await bridge.listen(0);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` };
  const post = (route: string, body: unknown) =>
    fetch(`${url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal(
      (
        await fetch(`${url}/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );

    const completion = bridge.provider().complete('SYSTEM TEXT', [{ role: 'user', content: 'prompt text' }]);
    const poll = (await (await post('/poll', { waitMs: 2000 })).json()) as {
      exchange: { id: number; phase: string; system: string; prompt: string };
    };
    assert.deepEqual(
      {
        phase: poll.exchange.phase,
        system: poll.exchange.system,
        prompt: poll.exchange.prompt,
      },
      { phase: 'decision', system: 'SYSTEM TEXT', prompt: 'prompt text' },
    );

    const tool = (await (await post('/tool', { name: 'lookup_move', arguments: { name: 'Protect' } })).json()) as {
      result: string;
    };
    assert.equal(tool.result, 'result for Protect');
    assert.deepEqual(lookups, ['lookup_move']);
    const context = (await (await post('/context', { after: 'ctx-00000001' })).json()) as {
      query: { after: string };
    };
    assert.equal(context.query.after, 'ctx-00000001');

    assert.equal((await post('/submit', { id: poll.exchange.id, text: '{"choices":[0]}' })).status, 200);
    assert.equal((await completion).text, '{"choices":[0]}');
  } finally {
    bridge.close();
  }
});

function decide(prompt: string): number[] {
  const menus: string[][] = [];
  for (const line of prompt.split('\n')) {
    if (/^Slot \d+ — /.test(line)) menus.push([]);
    else if (menus.length && /^ {2}\d+\. /.test(line)) menus.at(-1)!.push(line.replace(/^ {2}\d+\. /, ''));
    else if (menus.length && line === '') break;
  }
  const chosen: string[] = [];
  return menus.map((labels) => {
    let index = labels.findIndex((label) => !(/^(Pick|Switch to) /.test(label) && chosen.includes(label)));
    if (index < 0) index = 0;
    chosen.push(labels[index]!);
    return index;
  });
}

test('exhibition refuses every reused or symlinked agent workspace', async () => {
  const layouts: Array<{ name: string; prepare: (agentDir: string) => void }> = [
    { name: 'empty-directory', prepare: (agentDir) => fs.mkdirSync(agentDir) },
    {
      name: 'occupied-directory',
      prepare: (agentDir) => {
        fs.mkdirSync(agentDir);
        fs.writeFileSync(path.join(agentDir, 'untrusted'), 'occupied');
      },
    },
    { name: 'file', prepare: (agentDir) => fs.writeFileSync(agentDir, 'occupied') },
  ];
  if (process.platform !== 'win32') {
    layouts.push({
      name: 'symlink',
      prepare: (agentDir) => {
        const target = `${agentDir}-target`;
        fs.mkdirSync(target);
        fs.symlinkSync(target, agentDir, 'dir');
      },
    });
  }

  for (const layout of layouts) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-seat-workspace-${layout.name}-`));
    const agentDir = path.join(scratch, 'agent');
    layout.prepare(agentDir);
    await assert.rejects(
      runExhibition(path.join(scratch, 'run'), {
        opponent: 'random',
        seed: 12,
        agentDir,
        recordsPath: path.join(scratch, 'results.jsonl'),
      }),
      /agent workspace must be freshly created/,
    );
  }
});

test('exhibition refuses reused or symlinked workspace artifacts', async () => {
  const layouts: Array<{
    name: string;
    plant: (seatConfig: string, target: string) => void;
    verify: (seatConfig: string, target: string) => void;
  }> = [
    {
      name: 'file',
      plant: (seatConfig) => fs.writeFileSync(seatConfig, 'occupied'),
      verify: (seatConfig) => assert.equal(fs.readFileSync(seatConfig, 'utf8'), 'occupied'),
    },
  ];
  if (process.platform !== 'win32') {
    layouts.push({
      name: 'symlink',
      plant: (seatConfig, target) => fs.symlinkSync(target, seatConfig),
      verify: (seatConfig, target) => {
        assert.equal(fs.lstatSync(seatConfig).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
      },
    });
  }

  for (const layout of layouts) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-seat-artifact-${layout.name}-`));
    const agentDir = path.join(scratch, 'agent');
    const seatConfig = path.join(agentDir, 'seat.json');
    const target = path.join(scratch, 'outside-token-target');
    fs.writeFileSync(target, 'unchanged');

    const originalOpenSync = fs.openSync;
    const originalOpenSyncDescriptor = Object.getOwnPropertyDescriptor(fs, 'openSync');
    if (!originalOpenSyncDescriptor) throw new Error('fs.openSync property descriptor is unavailable');
    let planted = false;
    const interceptedOpenSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!planted && filePath === seatConfig) {
        layout.plant(seatConfig, target);
        planted = true;
      }
      return Reflect.apply(originalOpenSync, fs, [filePath, flags, mode]) as number;
    }) as typeof fs.openSync;
    Object.defineProperty(fs, 'openSync', { ...originalOpenSyncDescriptor, value: interceptedOpenSync });
    try {
      await assert.rejects(
        runExhibition(path.join(scratch, 'run'), {
          opponent: 'random',
          seed: 13,
          agentDir,
          recordsPath: path.join(scratch, 'results.jsonl'),
        }),
        /agent workspace artifact must be freshly created: seat\.json/,
      );
    } finally {
      Object.defineProperty(fs, 'openSync', originalOpenSyncDescriptor);
    }

    assert.equal(planted, true);
    layout.verify(seatConfig, target);
  }
});

test('an exhibition series against random plays to completion through the bridge', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-seat-'));
  const runDir = path.join(scratch, 'run');
  const recordsPath = path.join(scratch, 'results.jsonl');
  const ready = Promise.withResolvers<{ url: string; agentDir: string }>();
  const rowPromise = runExhibition(runDir, {
    opponent: 'random',
    seed: 11,
    recordsPath,
    onReady: ready.resolve,
  });
  const { url, agentDir } = await Promise.race([
    ready.promise,
    rowPromise.then(() => {
      throw new Error('series finished before the bridge was ready');
    }),
  ]);

  const config = JSON.parse(fs.readFileSync(path.join(agentDir, 'seat.json'), 'utf8')) as { token: string };
  assert.ok(fs.existsSync(path.join(agentDir, 'seat.mjs')));
  assert.ok(fs.existsSync(path.join(agentDir, 'SEAT.md')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(agentDir).mode & 0o777, 0o700);
    for (const artifact of ['seat.json', 'seat.mjs', 'SEAT.md'])
      assert.equal(fs.statSync(path.join(agentDir, artifact)).mode & 0o777, 0o600);
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.token}` };

  const prompts: string[] = [];
  let battleTools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  let driving = true;
  const driver = (async () => {
    while (driving) {
      let data: { exchange: { id: number; phase: string; prompt: string } | null };
      try {
        const response = await fetch(`${url}/poll`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ waitMs: 500 }),
        });
        data = (await response.json()) as typeof data;
      } catch {
        return;
      }
      if (!data.exchange) continue;
      prompts.push(data.exchange.prompt);
      if (data.exchange.phase === 'decision' && battleTools.length === 0) {
        const response = await fetch(`${url}/tools`, { method: 'POST', headers, body: '{}' });
        battleTools = ((await response.json()) as { tools: typeof battleTools }).tools;
      }
      const text =
        data.exchange.phase === 'reflection'
          ? '{"summary":"s","adjustment":"a","notebook":"n"}'
          : JSON.stringify({
              choices: decide(data.exchange.prompt),
              rationale: 'r',
              notebook: 'n',
            });
      try {
        await fetch(`${url}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: data.exchange.id, text }),
        });
      } catch {
        return;
      }
    }
  })();

  const row = await rowPromise;
  driving = false;
  await driver;

  assert.equal(row.mode, 'exhibition');
  assert.equal(row.protocol_version, 5);
  assert.equal(row.pool, 'test');
  assert.equal(row.seat, 'p1');
  assert.deepEqual(row.players, { p1: 'cli-agent', p2: 'random' });
  assert.match(String(row.scaffold), /^[0-9a-f]{12}$/);
  assert.deepEqual(row.execution_harnesses, {
    p1: {
      adapter: 'trusted-external-bridge',
      version: 4,
      filesystem_isolation: false,
      process_isolation: false,
      network_isolation: false,
      host_filesystem_access: 'unrestricted-unobserved',
      host_process_access: 'unrestricted-unobserved',
      arbitrary_network_access: 'unrestricted-unobserved',
      workspace_policy: 'fresh-directory-0700-v1',
      credential_policy: 'exclusive-artifacts-0600-v1',
      delegation: 'unrestricted-unobserved',
      context: 'cursor-addressable-authorized-series-stream-v1',
      tools: 'live-decision-bound-lookups-v1',
      model_visible_adapter: {
        version: 1,
        digest: '9497a731bd2215903a801480ddd2e56dbf59e85f7919ff35d57aa57017909095',
      },
      evidence_log: {
        version: 1,
        collection: 'host-side-jsonl-v1',
        artifacts: ['decisions', 'trace', 'context', 'bridge-tools'],
        presented_through_adapter: false,
      },
    },
    p2: {
      adapter: 'random-engine',
      version: 2,
      filesystem_isolation: false,
      process_isolation: false,
      network_isolation: false,
      host_filesystem_access: 'not-exposed-through-model-api',
      host_process_access: 'not-exposed-through-model-api',
      arbitrary_network_access: 'not-exposed-through-model-api',
      delegation: 'none',
      context: 'none',
      tools: 'none',
    },
  });
  assert.ok(battleTools.some((tool) => tool.name === 'compare_action_order'));
  const damage = battleTools.find((tool) => tool.name === 'estimate_damage');
  assert.ok(damage);
  const damageParameters = damage.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(damageParameters), ['attacker', 'defender', 'move', 'helping_hand', 'is_critical_hit']);
  const score = row.score as Record<string, number>;
  assert.equal(Math.max(score.p1!, score.p2!), 2);
  assert.ok(prompts.some((prompt) => prompt.includes('Ordered team menu')));
  assert.ok(!prompts.some((prompt) => prompt.includes('Showdown timer:')));

  const recorded = loadSeriesRecords(recordsPath);
  assert.equal(recorded.length, 1);
  assert.equal(scopeRows(recorded).length, 0);
  assert.equal(scopeRows(recorded, 'test').length, 1);

  const seriesDir = path.join(runDir, 'series', String(row.series_id));
  assert.ok(fs.existsSync(path.join(seriesDir, 'p1-decisions.jsonl')));
  assert.ok(fs.existsSync(path.join(seriesDir, 'p1-trace.jsonl')));
  const contextRows = fs
    .readFileSync(path.join(seriesDir, 'p1-context.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { context_id: string; kind: string });
  assert.equal(contextRows[0]?.context_id, 'ctx-00000001');
  assert.ok(contextRows.some((row) => row.kind === 'agent_context'));
});
