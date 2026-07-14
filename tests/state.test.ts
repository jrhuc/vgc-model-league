import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../src/paths.js';
import { BattleState } from '../src/state.js';
import type { BattleRequest } from '../src/types.js';

test('own requests render known sets and stats', () => {
  const request = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests/data/showdown_requests/turn.json'), 'utf8'),
  ) as BattleRequest;
  const rendered = new BattleState('p1').render(request);
  const first = request.side!.pokemon![0]!;
  assert.match(rendered, new RegExp(`item ${first.item}`));
  assert.match(rendered, new RegExp(`ability ${first.ability}`));
  assert.match(rendered, new RegExp(String((first.moves as string[])[0])));
  assert.match(rendered, new RegExp(`stats atk ${(first.stats as Record<string, number>).atk}`));
});

test('open team sheets follow active nicknames', () => {
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Ground God|ArceusGround|EarthPlate|Multitype|Earthquake,Recover|||||||50|,,,,,Ground',
    '|switch|p2a: Ground God|Arceus-Ground, L50|100/100',
  ]);
  const rendered = state.render({});
  assert.match(rendered, /item EarthPlate/);
  assert.match(rendered, /ability Multitype/);
  assert.match(rendered, /Earthquake/);
  assert.doesNotMatch(rendered, /Tera Ground/);
});

test('Mega events preserve the detailschange forme', () => {
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p1|Gengar||Gengarite|CursedBody|shadowball,protect|Timid|||||50',
    '|switch|p1a: Gengar|Gengar, L50|135/135',
    '|detailschange|p1a: Gengar|Gengar-Mega, L50',
    '|-mega|p1a: Gengar|Gengar|Gengarite',
  ]);
  const rendered = state.render({});
  assert.match(rendered, /Gengar-Mega/);
  assert.match(rendered, /Mega Evolved/);
});

test('state ignores unstructured protocol messages', () => {
  const state = new BattleState('p1');
  state.feed(['|message|RAW_SENTINEL', '|turn|3']);
  const rendered = state.render({});
  assert.match(rendered, /Turn: 3/);
  assert.doesNotMatch(rendered, /RAW_SENTINEL/);
});
