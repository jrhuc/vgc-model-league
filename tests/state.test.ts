import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../src/paths.js';
import { ShowdownReference } from '../src/reference.js';
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
  assert.match(rendered, new RegExp(`Attack ${(first.stats as Record<string, number>).atk}`));
  assert.doesNotMatch(rendered, /\bL50\b/);
  assert.match(rendered, /HP \d+%/);
  assert.doesNotMatch(rendered, /HP \d+\/\d+/);
});

test('post-preview prompts show percentage HP and compact bench sets', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  const rendered = state.render(
    {
      active: [
        {
          moves: [{ move: 'Raging Bull', id: 'ragingbull', pp: 10, maxpp: 10, target: 'normal', disabled: false }],
        },
      ],
      side: {
        pokemon: [
          {
            ident: 'p1: Tauros',
            details: 'Tauros-Paldea-Aqua, L50',
            condition: '76/152',
            active: true,
            stats: { atk: 178, def: 125, spa: 45, spd: 90, spe: 152 },
            moves: ['ragingbull'],
            item: 'choicescarf',
            ability: 'intimidate',
          },
          {
            ident: 'p1: Venusaur',
            details: 'Venusaur, L50',
            condition: '187/187',
            active: false,
            stats: { atk: 91, def: 108, spa: 143, spd: 120, spe: 119 },
            moves: ['protect', 'gigadrain', 'earthpower', 'sludgebomb'],
            item: 'venusaurite',
            ability: 'chlorophyll',
          },
        ],
      },
    },
    (mon) => reference.describeCompact(mon),
  );
  const active = rendered.split('\n').find((line) => line.startsWith('- Tauros-Paldea-Aqua;')) ?? '';
  const bench = rendered.split('\n').find((line) => line.startsWith('- Venusaur;')) ?? '';
  assert.match(active, /HP 50%/);
  assert.match(active, /Raging Bull \[Water\/Physical\/90\]/);
  assert.match(bench, /HP 100%; moves protect, gigadrain, earthpower, sludgebomb; Speed 119/);
  assert.doesNotMatch(bench, /\[/);
  assert.doesNotMatch(rendered, /76\/152|187\/187/);
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

test('effective speed and action order preserve hidden ranges and explain redundant Encore', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Tauros|Tauros-Paldea-Aqua|ChoiceScarf|Intimidate|CloseCombat,AquaJet|Adamant|||||50',
    '|switch|p1a: Gengar|Gengar-Mega, L50|165/165',
    '|switch|p2a: Tauros|Tauros-Paldea-Aqua, L50|100/100',
    '|turn|5',
    '|move|p2a: Tauros|Close Combat|p1a: Gengar',
  ]);
  const request: BattleRequest = {
    active: [{ moves: [{ move: 'Encore', id: 'encore', target: 'normal' }] }],
    side: {
      pokemon: [
        {
          ident: 'p1: Gengar',
          details: 'Gengar-Mega, L50',
          condition: '165/165',
          active: true,
          stats: { atk: 76, def: 121, spa: 190, spd: 125, spe: 170 },
          moves: ['encore'],
        },
      ],
    },
  };
  const rendered = state.render(request, (mon) => reference.describeCompact(mon));
  assert.match(rendered, /Special Defense 125, Speed 170/);
  assert.match(rendered, /raw Speed range 105-152/);
  assert.match(rendered, /Choice-locked into Close Combat/);
  assert.match(state.renderEffectiveSpeeds(reference), /foe Tauros-Paldea-Aqua 157–228 \(Choice Scarf ×1\.5\)/);
  assert.equal(state.moveAnnotation('Encore', 'foe', 1), 'redundant: target is Choice-locked into Close Combat');
  assert.match(
    state.compareActionOrder(
      { first: 'Gengar-Mega', first_move: 'Encore', second: 'Tauros-Paldea-Aqua', second_move: 'Close Combat' },
      reference,
    ),
    /order is uncertain[\s\S]*Encore is redundant/,
  );

  state.feed(['|-start|p2a: Tauros|Encore']);
  assert.equal(state.moveAnnotation('Encore', 'foe', 1), 'fails: target already Encored');
  state.feed(['|switch|p2a: Incineroar|Incineroar, L50|100/100']);
  assert.doesNotMatch(state.render({}), /Choice-locked/);
});

test('action order proves one-point and Tailwind speed guarantees', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Garchomp||LifeOrb|RoughSkin|Earthquake|Jolly|||||50',
    '|switch|p1a: Gengar|Gengar-Mega, L50|165/165',
    '|switch|p2a: Garchomp|Garchomp, L50|100/100',
  ]);
  state.render({
    active: [{ moves: [{ move: 'Shadow Ball', target: 'normal' }] }],
    side: {
      pokemon: [
        {
          ident: 'p1: Gengar',
          details: 'Gengar-Mega, L50',
          condition: '165/165',
          active: true,
          stats: { spe: 170 },
        },
      ],
    },
  });
  assert.match(
    state.compareActionOrder(
      { first: 'Gengar-Mega', first_move: 'Shadow Ball', second: 'Garchomp', second_move: 'Earthquake' },
      reference,
    ),
    /Gengar-Mega is guaranteed to act first/,
  );

  const tailwind = new BattleState('p1');
  tailwind.feed([
    '|showteam|p2|Venusaur|Venusaur-Mega|Venusaurite|ThickFat|GigaDrain|Modest|||||50',
    '|switch|p1a: Tinkaton|Tinkaton, L50|171/171',
    '|switch|p2a: Venusaur|Venusaur-Mega, L50|100/100',
    '|-sidestart|p2: foe|Tailwind',
  ]);
  tailwind.render({
    active: [{ moves: [{ move: 'Encore', target: 'normal' }] }],
    side: {
      pokemon: [
        {
          ident: 'p1: Tinkaton',
          details: 'Tinkaton, L50',
          condition: '171/171',
          active: true,
          stats: { spe: 155 },
        },
      ],
    },
  });
  assert.match(
    tailwind.compareActionOrder(
      { first: 'Tinkaton', first_move: 'Encore', second: 'Venusaur-Mega', second_move: 'Giga Drain' },
      reference,
    ),
    /Venusaur-Mega is guaranteed to act first[\s\S]*attempts to lock the move used this turn, Giga Drain/,
  );
});
