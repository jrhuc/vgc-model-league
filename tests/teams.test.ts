import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPool, packTeam, validatePool } from '../src/teams.js';

test('default pool loads in manifest order and validates', () => {
  const pool = loadPool();
  assert.equal(pool.id, 'test');
  assert.equal(pool.format, 'gen9championsvgc2026regmbbo3');
  assert.deepEqual(
    pool.teams.map((team) => team.id),
    [
      'boschmans-mega-pyroar',
      'cybertron-mega-staraptor',
      'endo-mega-sceptile',
      'jpnats-mega-swampert',
      'rios-mega-raichu-x-venusaur',
      'wolfe-mega-raichu-y',
    ],
  );
  assert.ok(pool.teams.every((team) => team.packed.split(']').length === 6));
  validatePool(pool);
});

test('pool loader uses custom directories and rejects invalid manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcbench-teams-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const poolDir = path.join(root, 'snapshot');
  fs.mkdirSync(poolDir);
  fs.writeFileSync(path.join(poolDir, 'a.team'), 'alpha');
  fs.writeFileSync(path.join(poolDir, 'b.team'), 'beta');
  const manifest = {
    id: 'snapshot',
    format: 'gen9championsvgc2026regmbbo3',
    teams: [
      { id: 'a', file: 'a.team' },
      { id: 'b', file: 'b.team' },
    ],
  };
  fs.writeFileSync(path.join(poolDir, 'pool.json'), JSON.stringify(manifest));
  assert.deepEqual(loadPool('snapshot', root).teams, [
    { id: 'a', packed: 'alpha' },
    { id: 'b', packed: 'beta' },
  ]);
  fs.writeFileSync(
    path.join(poolDir, 'pool.json'),
    JSON.stringify({ ...manifest, format: 'gen9championsvgc2026regmb' }),
  );
  assert.throws(() => loadPool('snapshot', root), /BO3 format/);
  fs.writeFileSync(
    path.join(poolDir, 'pool.json'),
    JSON.stringify({
      ...manifest,
      teams: [
        { id: 'a', file: 'a.team' },
        { id: 'a', file: 'b.team' },
      ],
    }),
  );
  assert.throws(() => loadPool('snapshot', root), /duplicate team id/);
});

test('team exports are packed by the direct Showdown API', () => {
  const packed = packTeam('Pikachu @ Light Ball\nAbility: Static\nLevel: 50\n- Protect\n- Thunderbolt');
  assert.match(packed, /Pikachu\|\|LightBall\|Static\|Protect,Thunderbolt/);
});
