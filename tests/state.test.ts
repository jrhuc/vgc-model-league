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
  assert.doesNotMatch(rendered, /\bL50\b/);
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
  assert.doesNotMatch(rendered, /ability CursedBody/);
});

test('opposing Mega formes do not duplicate their open-sheet base forme', () => {
  const state = new BattleState('p1');
  state.feed([
    '|poke|p2|Gengar, L50|',
    '|showteam|p2|Spooky|Gengar|Gengarite|CursedBody|shadowball,protect|Timid|||||50',
    '|switch|p2a: Spooky|Gengar, L50|100/100',
    '|detailschange|p2a: Spooky|Gengar-Mega, L50',
    '|-mega|p2a: Spooky|Gengar|Gengarite',
  ]);
  const rendered = state.render({});
  assert.equal(rendered.match(/^- Gengar(?:-Mega)?;/gm)?.length, 1);
  assert.match(rendered, /Gengar-Mega/);
});

test('post-preview own state omits Pokémon that were not brought', () => {
  const state = new BattleState('p1');
  const previewPokemon = Array.from({ length: 6 }, (_, index) => ({
    ident: `p1: Mon${index + 1}`,
    details: `Species${index + 1}, L50`,
    condition: '100/100',
    active: false,
  }));
  const preview: BattleRequest = { teamPreview: true, side: { pokemon: previewPokemon } };
  assert.match(state.render(preview), /Species6/);

  const brought: BattleRequest = {
    side: { pokemon: previewPokemon.slice(0, 4).map((pokemon, index) => ({ ...pokemon, active: index < 2 })) },
    active: [null, null],
  };
  const rendered = state.render(brought);
  assert.match(rendered, /Species4/);
  assert.doesNotMatch(rendered, /Species5|Species6/);
});

test('public percentage HP color suffixes are normalized', () => {
  const state = new BattleState('p1');
  state.feed(['|switch|p2a: Whimsicott|Whimsicott, L50|50/100g']);
  const mon = [...state.sides.p2.mons.values()][0]!;
  assert.equal(mon.hp, '50/100');
  assert.equal(mon.hpPercent, 50);
  assert.doesNotMatch(state.render({}), /100g/);
});

test('state ignores unstructured protocol messages', () => {
  const state = new BattleState('p1');
  state.feed(['|message|RAW_SENTINEL', '|turn|3']);
  const rendered = state.render({});
  assert.match(rendered, /Turn: 3/);
  assert.doesNotMatch(rendered, /RAW_SENTINEL/);
});

test('persistent volatile conditions render and clear on switch', () => {
  const state = new BattleState('p1');
  state.feed([
    '|switch|p1a: Gengar|Gengar, L50|100/100',
    '|-start|p1a: Gengar|move: Taunt',
    '|-start|p1a: Gengar|Substitute',
  ]);
  assert.match(state.render({}), /volatile Substitute, Taunt/);
  state.feed(['|switch|p1a: Incineroar|Incineroar, L50|100/100']);
  assert.doesNotMatch(state.render({}), /volatile/);
});

test('last observed move retains target and turn for live viewers', () => {
  const state = new BattleState('p1');
  state.feed([
    '|switch|p1a: Miraidon|Miraidon, L50|207/207',
    '|switch|p2a: Calyrex-Ice|Calyrex-Ice, L50|252/252',
    '|turn|3',
    '|move|p1a: Miraidon|Electro Drift|p2a: Calyrex-Ice',
    '|turn|4',
  ]);
  assert.deepEqual([...state.sides.p1.mons.values()][0]!.lastMove, {
    name: 'Electro Drift',
    target: 'p2a: Calyrex-Ice',
    turn: 3,
  });
  assert.match(state.render({}), /last move Electro Drift into Calyrex-Ice \(turn 3\)/);
});

test('field weather and screens render remaining turns', () => {
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p1|Grimmsnarl||LightClay|Prankster|FoulPlay,Reflect|Calm||||',
    '|switch|p1a: Grimmsnarl|Grimmsnarl, L50|202/202',
    '|turn|1',
    '|-fieldstart|move: Trick Room',
    '|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal',
    '|-sidestart|p1: p1|Reflect',
    '|turn|2',
  ]);
  const rendered = state.render({});
  assert.match(rendered, /Trick Room \(4 turns? left\)/);
  // Gen 9 ability weather also lasts 5 turns; Torkoal's item is unknown, so no Heat Rock extension.
  assert.match(rendered, /SunnyDay \(4 turns? left\)/);
  // Light Clay extends Reflect to 8; one turn has elapsed by the turn-2 decision.
  assert.match(rendered, /Reflect \(7 turns? left\)/);
});

test('Protect success reduction is tracked for the next menu', () => {
  const state = new BattleState('p1');
  state.feed([
    '|switch|p1a: Archaludon|Archaludon, L50|197/197',
    '|turn|5',
    '|move|p1a: Archaludon|Protect|p1a: Archaludon',
    '|-singleturn|p1a: Archaludon|Protect',
    '|turn|6',
  ]);
  assert.equal(state.protectReducedSlots()[1], true);
  assert.match(state.render({}), /Protect success rate reduced/);
});
