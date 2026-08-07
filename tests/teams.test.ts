import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TEAMS_DIR } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { createPool, loadPool, packTeam, validatePool, validateTeam } from '../src/teams.js';

function pasteFromPool(file: string): string {
  const { Teams } = loadShowdown();
  const team = Teams.unpack(fs.readFileSync(path.join(TEAMS_DIR, 'test', file), 'utf8').trim());
  assert.ok(team, `test pool team ${file} should unpack`);
  return Teams.export(team);
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-teams-'));
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
  fs.writeFileSync(path.join(root, 'outside.team'), 'outside');
  fs.writeFileSync(
    path.join(poolDir, 'pool.json'),
    JSON.stringify({
      ...manifest,
      teams: [
        { id: 'a', file: '../outside.team' },
        { id: 'b', file: 'b.team' },
      ],
    }),
  );
  assert.throws(() => loadPool('snapshot', root), /escapes its pool directory/);
  assert.throws(() => loadPool('../snapshot', root), /pool name/);
});

test('a created pool keeps the event and the placements a bracket reads seeds from', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-createpool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createPool(
    'vr-import',
    'gen9championsvgc2026regmbbo3',
    {
      event: { name: 'Victory Road August Challenge #1', players: 194, cut: 8 },
      spreads: { published: false, reconstructed: true, reason: 'open lists publish no EVs' },
      teams: [
        {
          id: 'first',
          paste: pasteFromPool('jpnats-mega-swampert.team'),
          seed: 1,
          source: { placement: 1, player: 'Kazuki Ogushi', swiss: '8-2' },
        },
        { id: 'second', paste: pasteFromPool('wolfe-mega-raichu-y.team'), seed: 2 },
      ],
    },
    root,
  );
  const pool = loadPool('vr-import', root);
  assert.equal(pool.event?.name, 'Victory Road August Challenge #1');
  assert.equal(pool.event?.players, 194);
  assert.equal(pool.event?.reconstructedSpreads, true);
  assert.equal(pool.metadata.spreads?.reason, 'open lists publish no EVs');
  assert.deepEqual(
    pool.teams.map((team) => team.seed),
    [1, 2],
  );
  assert.equal(pool.teams[0]?.provenance?.player, 'Kazuki Ogushi');
  assert.equal(pool.teams[0]?.source?.swiss, '8-2', 'keys no shared type models survive republication');
  assert.equal(pool.teams[1]?.provenance, undefined);
});

test('team exports are packed by the direct Showdown API', () => {
  const packed = packTeam('Pikachu @ Light Ball\nAbility: Static\nLevel: 50\n- Protect\n- Thunderbolt');
  assert.match(packed, /Pikachu\|\|LightBall\|Static\|Protect,Thunderbolt/);
});

test('Mega-forme pastes normalize to the base forme holding the stone', () => {
  const packed = packTeam('Swampert-Mega @ Swampertite\nAbility: Damp\nLevel: 50\n- Protect\n- Wave Crash');
  assert.match(packed, /^Swampert\|\|Swampertite\|Damp/);
  assert.doesNotMatch(packed, /Swampert-Mega/);
});

test('Mega-forme pastes without the stone or with a Mega-only ability are rejected', () => {
  assert.throws(
    () => packTeam('Swampert-Mega @ Leftovers\nAbility: Damp\nLevel: 50\n- Protect'),
    /Swampert holding Swampertite/,
  );
  assert.throws(
    () => packTeam('Swampert-Mega @ Swampertite\nAbility: Swift Swim\nLevel: 50\n- Protect'),
    /Swampert's abilities/,
  );
});

test('Mega formes with a distinct source forme name normalize to that forme', () => {
  const packed = packTeam('Floette-Mega @ Floettite\nAbility: Flower Veil\nLevel: 50\n- Protect');
  assert.match(packed, /^Floette-Eternal\|\|Floettite\|FlowerVeil/);
  assert.throws(
    () => validateTeam('Floette-Mega||Floettite|FlowerVeil|Protect|Serious|||||50|', 'gen9championsvgc2026regmbbo3'),
    /entered as Floette-Eternal holding Floettite/,
  );
});

test('packed teams that still name a Mega forme fail validation loudly', () => {
  assert.throws(
    () =>
      validateTeam('Swampert-Mega||Swampertite|Damp|Protect,WaveCrash|Adamant|||||50|', 'gen9championsvgc2026regmbbo3'),
    /base formes/,
  );
});

test('Champions validation applies each species’ current learnset', () => {
  assert.throws(
    () =>
      validateTeam('Annihilape||SitrusBerry|Defiant|FinalGambit,Protect|Jolly|||||50|', 'gen9championsvgc2026regmbbo3'),
    /can't learn Final Gambit/,
  );
  assert.throws(
    () =>
      validateTeam(
        'Incineroar||SitrusBerry|Intimidate|KnockOff,FakeOut|Careful|||||50|',
        'gen9championsvgc2026regmbbo3',
      ),
    /can't learn Knock Off/,
  );
});
