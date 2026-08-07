import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runExhibition } from '../src/exhibition.js';
import type { SeriesRecord } from '../src/records.js';
import { loadRows, scopeRows } from '../src/records.js';
import { SeatBridge } from '../src/seat.js';

test('unscoped play data includes exhibitions without turning them into a ranking', () => {
  const rows = [
    { mode: 'rotation', pool: 'regmb', players: { p1: 'a', p2: 'b' }, winner: 'a' },
    { mode: 'exhibition', pool: 'regmb', players: { p1: 'cli-agent', p2: 'b' }, winner: 'b' },
  ] as SeriesRecord[];
  assert.equal(scopeRows(rows).length, 2);
  assert.equal(scopeRows(rows, 'regmb').length, 2);
});

test('seat bridge serves exchanges, enforces its token, and answers tool lookups', async () => {
  const lookups: string[] = [];
  const bridge = new SeatBridge({
    lookup: (name, args) => {
      lookups.push(name);
      return `result for ${String(args.name)}`;
    },
  });
  const url = await bridge.listen(0);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` };
  const post = async (route: string, body: unknown) =>
    fetch(`${url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const unauthorized = await fetch(`${url}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    const empty = (await (await post('/poll', { waitMs: 0 })).json()) as { exchange: unknown };
    assert.equal(empty.exchange, null);

    const completion = bridge.provider().complete('SYSTEM TEXT', [{ role: 'user', content: 'prompt text' }]);
    const poll = (await (await post('/poll', { waitMs: 2000 })).json()) as {
      exchange: { id: number; phase: string; system: string; prompt: string };
    };
    assert.equal(poll.exchange.phase, 'decision');
    assert.equal(poll.exchange.system, 'SYSTEM TEXT');
    assert.equal(poll.exchange.prompt, 'prompt text');

    const stale = await post('/submit', { id: poll.exchange.id + 1, text: 'x' });
    assert.equal(stale.status, 409);

    const unknownTool = await post('/tool', { name: 'not_a_tool', arguments: {} });
    assert.equal(unknownTool.status, 400);
    const tool = (await (await post('/tool', { name: 'lookup_move', arguments: { name: 'Protect' } })).json()) as {
      result: string;
    };
    assert.equal(tool.result, 'result for Protect');
    assert.deepEqual(lookups, ['lookup_move']);

    const submitted = await post('/submit', { id: poll.exchange.id, text: '{"choices":[0]}' });
    assert.equal(submitted.status, 200);
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
  assert.equal(row.pool, 'test');
  assert.equal(row.seat, 'p1');
  assert.deepEqual(row.players, { p1: 'cli-agent', p2: 'random' });
  assert.match(String(row.scaffold), /^[0-9a-f]{12}$/);
  assert.deepEqual(row.execution_harnesses, {
    p1: {
      adapter: 'trusted-external-bridge',
      version: 1,
      filesystem_isolation: false,
      delegation: 'unrestricted-unobserved',
    },
    p2: { adapter: 'random-engine', version: 1, filesystem_isolation: true, delegation: 'none' },
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

  const recorded = loadRows(recordsPath);
  assert.equal(recorded.length, 1);
  assert.equal(scopeRows(recorded).length, 0);
  assert.equal(scopeRows(recorded, 'test').length, 1);

  const seriesDir = path.join(runDir, 'series', String(row.series_id));
  assert.ok(fs.existsSync(path.join(seriesDir, 'p1-decisions.jsonl')));
  assert.ok(fs.existsSync(path.join(seriesDir, 'p1-trace.jsonl')));
});
