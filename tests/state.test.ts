import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { summarizeBattleEvents } from '../src/battle-transcript.js';
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

test('battle damage binds open-sheet abilities and ignores fabricated caller state', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Toaster|Rotom-Heat|SitrusBerry|Levitate|overheat,thunderbolt,protect|Timid|||||50',
    '|switch|p2a: Toaster|Rotom-Heat, L50|100/100',
  ]);
  const request: BattleRequest = {
    active: [{ moves: [{ move: 'Earthquake', id: 'earthquake', target: 'allAdjacent' }] }],
    side: {
      pokemon: [
        {
          ident: 'p1: Swampert',
          details: 'Swampert, L50',
          condition: '187/187',
          active: true,
          stats: { atk: 178, def: 130, spa: 103, spd: 130, spe: 112 },
          moves: ['earthquake'],
          item: 'swampertite',
          ability: 'damp',
        },
      ],
    },
  };
  const result = state.estimateDamage(
    {
      attacker: 'Swampert',
      defender: 'Rotom-Heat',
      move: 'Earthquake',
      attacker_status: 'brn',
      defender_ability: 'Pressure',
      attacker_stats: { atk: 1 },
    },
    request,
    reference,
  );
  assert.match(result, /defender Rotom-Heat \(Levitate\)/);
  assert.match(result, /immune or absorbed by Levitate;.*4x.*; 0% damage/);
  assert.doesNotMatch(result, /Pressure|burned|attacker_stats\.atk 1/);
});

test('live damage derives spread reduction from Showdown targets and live actives', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const request = (attacker: string, move: string, ally?: string): BattleRequest => ({
    active: [
      { moves: [{ move, id: move.toLowerCase().replaceAll(' ', ''), target: 'normal' }] },
      ...(ally ? [{ moves: [{ move: 'Protect', id: 'protect', target: 'self' }] }] : []),
    ],
    side: {
      pokemon: [
        {
          ident: `p1: ${attacker}`,
          details: `${attacker}, L50`,
          condition: '200/200',
          active: true,
          stats: { atk: 180, spa: 180 },
          moves: [move],
        },
        ...(ally
          ? [
              {
                ident: `p1: ${ally}`,
                details: `${ally}, L50`,
                condition: '200/200',
                active: true,
                stats: { atk: 120, spa: 120 },
                moves: ['Protect'],
              },
            ]
          : []),
      ],
    },
  });

  const foes = new BattleState('p1');
  foes.feed(['|switch|p2a: Incineroar|Incineroar, L50|100/100']);
  const oneFoe = foes.estimateDamage(
    { attacker: 'Sylveon', defender: 'Incineroar', move: 'Hyper Voice', is_spread_hit: true },
    request('Sylveon', 'Hyper Voice'),
    reference,
  );
  assert.doesNotMatch(oneFoe, /spread \(0\.75x\)/);

  foes.feed(['|switch|p2b: Farigiraf|Farigiraf, L50|100/100']);
  const twoFoes = foes.estimateDamage(
    { attacker: 'Sylveon', defender: 'Incineroar', move: 'Hyper Voice', is_spread_hit: false },
    request('Sylveon', 'Hyper Voice'),
    reference,
  );
  assert.match(twoFoes, /spread \(0\.75x\)/);
  const singleTarget = foes.estimateDamage(
    { attacker: 'Sylveon', defender: 'Incineroar', move: 'Shadow Ball', is_spread_hit: true },
    request('Sylveon', 'Shadow Ball'),
    reference,
  );
  assert.doesNotMatch(singleTarget, /spread \(0\.75x\)/);

  const opposingAttacker = new BattleState('p1');
  opposingAttacker.feed(['|switch|p2a: Sylveon|Sylveon, L50|100/100', '|switch|p2b: Farigiraf|Farigiraf, L50|100/100']);
  const oneFoeFromEitherSide = opposingAttacker.estimateDamage(
    { attacker: 'Sylveon', defender: 'Incineroar', move: 'Hyper Voice', is_spread_hit: true },
    request('Incineroar', 'Protect'),
    reference,
  );
  assert.doesNotMatch(oneFoeFromEitherSide, /spread \(0\.75x\)/);

  const adjacent = new BattleState('p1');
  adjacent.feed(['|switch|p2a: Incineroar|Incineroar, L50|100/100']);
  const foeOnly = adjacent.estimateDamage(
    { attacker: 'Garchomp', defender: 'Incineroar', move: 'Earthquake', is_spread_hit: true },
    request('Garchomp', 'Earthquake'),
    reference,
  );
  assert.doesNotMatch(foeOnly, /spread \(0\.75x\)/);
  const allyAndFoe = adjacent.estimateDamage(
    { attacker: 'Garchomp', defender: 'Incineroar', move: 'Earthquake', is_spread_hit: false },
    request('Garchomp', 'Earthquake', 'Tinkaton'),
    reference,
  );
  assert.match(allyAndFoe, /spread \(0\.75x\)/);
});

test('copied abilities are explained and reset from the open sheet on switch', () => {
  assert.deepEqual(
    summarizeBattleEvents(['|-ability|p2a: Gardevoir|Mega Launcher|Trace|[from] ability: Trace|[of] p1a: Blastoise']),
    ["Gardevoir's Trace copied Mega Launcher from Blastoise."],
  );
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Gardevoir||Gardevoirite|Trace|hypervoice,protect|Timid|||||50]Incineroar||SitrusBerry|Intimidate|fakeout,protect|Careful|||||50',
    '|switch|p2a: Gardevoir|Gardevoir, L50|100/100',
    '|-ability|p2a: Gardevoir|Mega Launcher|Trace|[from] ability: Trace|[of] p1a: Blastoise',
    '|switch|p2a: Incineroar|Incineroar, L50|100/100',
    '|switch|p2a: Gardevoir|Gardevoir, L50|100/100',
  ]);
  assert.match(state.render({}), /Gardevoir;.*ability Trace/);
  assert.doesNotMatch(state.render({}), /Gardevoir;.*ability Mega Launcher/);
});

test('suppressed abilities stay suppressed in live damage context', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Toaster|Rotom-Heat|SitrusBerry|Levitate|overheat,protect|Timid|||||50',
    '|switch|p2a: Toaster|Rotom-Heat, L50|100/100',
    '|-endability|p2a: Toaster|Levitate|[from] move: Gastro Acid',
  ]);
  const request: BattleRequest = {
    active: [{ moves: [{ move: 'Earthquake', id: 'earthquake', target: 'allAdjacent' }] }],
    side: {
      pokemon: [
        {
          ident: 'p1: Swampert',
          details: 'Swampert, L50',
          condition: '187/187',
          active: true,
          stats: { atk: 178 },
          moves: ['earthquake'],
          ability: 'damp',
        },
      ],
    },
  };
  const result = state.estimateDamage(
    { attacker: 'Swampert', defender: 'Rotom-Heat', move: 'Earthquake' },
    request,
    reference,
  );
  assert.match(result, /defender Rotom-Heat \(ability suppressed\)/);
  assert.match(result, /super-effective \(4x\)/);
  assert.doesNotMatch(result, /absorbed by Levitate/);
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

test('a Mega whose sheet identity differs still merges with its base forme', () => {
  const state = new BattleState('p1');
  state.feed([
    '|poke|p2|Floette-Eternal, L50|',
    '|showteam|p2|Floette-Eternal|Floette-Eternal|Floettite|FlowerVeil|moonblast,protect|Timid|||||50',
    '|switch|p2a: Floette|Floette-Eternal, L50|100/100',
    '|detailschange|p2a: Floette|Floette-Mega, L50',
    '|-mega|p2a: Floette|Floette-Eternal|Floettite',
  ]);
  const rendered = state.render({});
  assert.equal(rendered.match(/^- Floette/gm)?.length, 1, 'the mega and its sheet entry are one Pokémon');
  assert.match(rendered, /Floette-Mega/);
});

test('unseen opponents read as not brought once the whole bring is revealed', () => {
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Altaria||FocusSash|CloudNine|dracometeor,roost|Timid|||||50]Rotom-Wash||SitrusBerry|Levitate|thunderbolt,protect|Timid|||||50]Garchomp||LifeOrb|RoughSkin|earthquake,protect|Jolly|||||50]Dragapult||MuscleBand|ClearBody|dragondarts,protect|Jolly|||||50]Annihilape||Leftovers|Defiant|ragefist,protect|Jolly|||||50]Floette-Eternal||Floettite|FlowerVeil|moonblast,protect|Timid|||||50',
    '|switch|p2a: Altaria|Altaria, L50|100/100',
    '|switch|p2b: Rotom|Rotom-Wash, L50|100/100',
  ]);
  const brought: BattleRequest = {
    side: {
      pokemon: Array.from({ length: 4 }, (_, index) => ({
        ident: `p1: Own${index + 1}`,
        details: `Species${index + 1}, L50`,
        condition: '100/100',
        active: index < 2,
      })),
    },
    active: [null, null],
  };
  const partial = state.render(brought);
  assert.match(partial, /Annihilape; HP \?/, 'two reveals leave the bench uncertain');
  assert.match(partial, /Opponent brought 4 this game; 2 revealed so far, so only 2 of the "HP \?" Pokémon below are/);

  state.feed(['|switch|p2a: Garchomp|Garchomp, L50|100/100', '|switch|p2b: Dragapult|Dragapult, L50|100/100']);
  const rendered = state.render(brought);
  assert.match(rendered, /Annihilape; not brought this game/);
  assert.match(rendered, /Floette-Eternal; not brought this game/);
  assert.doesNotMatch(rendered, /HP \?/, 'four reveals resolve the whole opposing bring');
  assert.doesNotMatch(rendered, /Opponent brought 4 this game/, 'the interim count disappears once resolved');
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
  /** Gen 9 ability weather also lasts 5 turns; Torkoal's item is unknown, so no Heat Rock extension. */
  assert.match(rendered, /SunnyDay \(4 turns? left\)/);
  /** Light Clay extends Reflect to 8; one turn has elapsed by the turn-2 decision. */
  assert.match(rendered, /Reflect \(7 turns? left\)/);
});

test('hazards persist without a timer', () => {
  const state = new BattleState('p1');
  state.feed([
    '|switch|p1a: Garchomp|Garchomp, L50|183/183',
    '|turn|1',
    '|-sidestart|p1: p1|move: Toxic Spikes',
    '|-sidestart|p2: p2|move: Stealth Rock',
    '|-sidestart|p2: p2|Tailwind',
    '|turn|8',
  ]);
  const rendered = state.render({});
  assert.match(rendered, /Toxic Spikes(?! \()/);
  assert.match(rendered, /Stealth Rock(?! \()/);
  assert.doesNotMatch(rendered, /Toxic Spikes \(|Stealth Rock \(/);
  assert.match(rendered, /Tailwind \(0 turns left\)/);
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

test('effective speed and action order use format ranges and explain redundant Encore', () => {
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
  assert.match(rendered, /raw Speed range 120-152/);
  assert.match(state.renderEffectiveSpeeds(reference), /foe Tauros-Paldea-Aqua 180–228 \(Choice Scarf ×1\.5\)/);
  assert.equal(state.moveAnnotation('Encore', 'foe', 1), 'redundant: target is Choice-locked into Close Combat');
  assert.match(
    state.compareActionOrder(
      { first: 'Gengar-Mega', first_move: 'Encore', second: 'Tauros-Paldea-Aqua', second_move: 'Close Combat' },
      reference,
    ),
    /Tauros-Paldea-Aqua is guaranteed to act first[\s\S]*Encore is redundant/,
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

test('action order applies Gale Wings and Prankster priority modifiers', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const state = new BattleState('p1');
  state.feed([
    '|showteam|p2|Mamoswine||FocusSash|ThickFat|IceShard,RockSlide|Adamant|||||50',
    '|switch|p1a: Talonflame|Talonflame, L50|155/155',
    '|switch|p2a: Mamoswine|Mamoswine, L50|100/100',
  ]);
  const talonflame = {
    ident: 'p1: Talonflame',
    details: 'Talonflame, L50',
    condition: '155/155',
    active: true,
    ability: 'Gale Wings',
    stats: { spe: 195 },
  };
  state.render({ active: [{ moves: [{ move: 'Brave Bird', target: 'normal' }] }], side: { pokemon: [talonflame] } });
  const args = { first: 'Talonflame', first_move: 'Brave Bird', second: 'Mamoswine', second_move: 'Ice Shard' };
  const fullHp = state.compareActionOrder(args, reference);
  assert.match(fullHp, /Talonflame is guaranteed to act first \(equal priority\)/);
  assert.match(fullHp, /Gale Wings \+1 \(full HP\)/);

  state.feed(['|-damage|p1a: Talonflame|154/155']);
  const chipped = state.compareActionOrder(args, reference);
  assert.match(chipped, /Mamoswine is guaranteed to act first \(move priority \+0 vs \+1\)/);
  assert.match(chipped, /Gale Wings inactive \(not at full HP\)/);

  const prankster = new BattleState('p1');
  prankster.feed([
    '|showteam|p2|Whimsicott||FocusSash|Prankster|Tailwind,Moonblast|Timid|||||50',
    '|switch|p1a: Dragapult|Dragapult, L50|163/163',
    '|switch|p2a: Whimsicott|Whimsicott, L50|100/100',
  ]);
  prankster.render({
    active: [{ moves: [{ move: 'Dragon Darts', target: 'normal' }] }],
    side: {
      pokemon: [
        { ident: 'p1: Dragapult', details: 'Dragapult, L50', condition: '163/163', active: true, stats: { spe: 213 } },
        { ident: 'p1: Tinkaton', details: 'Tinkaton, L50', condition: '171/171', active: false, stats: { spe: 155 } },
      ],
    },
  });
  const pranked = prankster.compareActionOrder(
    { first: 'Dragapult', first_move: 'Dragon Darts', second: 'Whimsicott', second_move: 'Tailwind' },
    reference,
  );
  assert.match(pranked, /Whimsicott is guaranteed to act first \(move priority \+0 vs \+1\)/);
  assert.match(pranked, /Prankster \+1/);

  const benched = prankster.compareActionOrder({ first: 'Tinkaton', second: 'Whimsicott' }, reference);
  assert.match(benched, /Tinkaton \(benched\)/);
  assert.match(benched, /Benched Pokémon are compared as if already on the field/);
});

test('weather from a replacement switch-in counts from its first full turn', () => {
  const state = new BattleState('p1');
  state.feed([
    '|switch|p1a: Gengar|Gengar-Mega, L50|165/165',
    '|switch|p2a: Milotic|Milotic, L50|100/100',
    '|turn|3',
    '|upkeep',
    '|switch|p2a: Tyranitar|Tyranitar, L50|100/100',
    '|-weather|Sandstorm|[from] ability: Sand Stream|[of] p2a: Tyranitar',
    '|turn|4',
  ]);
  assert.match(state.render({}), /Sandstorm \(5 turns left\)/);
});

test('charge turns render as charging, not as a completed move', () => {
  const summary = summarizeBattleEvents([
    '|move|p2a: Charizard|Solar Beam|p1a: Spiritomb|[still]',
    '|-prepare|p2a: Charizard|Solar Beam',
  ]).join('\n');
  assert.match(summary, /Charizard is charging Solar Beam; it releases next turn unless disrupted\./);
});

test('blocked moves, side labels, and win lines render from the player point of view', () => {
  const events = summarizeBattleEvents(
    [
      '|cant|p1a: Tsareena|ability: Queenly Majesty|Brave Bird|[of] p2b: Talonflame',
      '|-sidestart|p2: p2-openrouter:qwen/qwen3.8-max|move: Tailwind',
      '|-sideend|p1: p1-openai:gpt-5.6-terra|move: Tailwind',
      '|win|p1-openai:gpt-5.6-terra',
    ],
    'p2',
  ).join('\n');
  assert.match(events, /Talonflame's Brave Bird was blocked by Tsareena's Queenly Majesty\./);
  assert.match(events, /Your side gained Tailwind\./);
  assert.match(events, /The opponent's side lost Tailwind\./);
  assert.match(events, /The opponent won the game\./);
  assert.doesNotMatch(events, /openrouter|openai/);
});
