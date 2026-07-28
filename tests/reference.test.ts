import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from '../src/paths.js';
import { DEX_TOOLS, ShowdownReference } from '../src/reference.js';
import { SHOWDOWN_LOCK, showdownCommit } from '../src/showdown.js';
import { isRecord } from '../src/value.js';

test('reference reads exact data from the configured Showdown checkout', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const rendered = reference
    .render({
      speciesSets: [
        ['Gengar', 'Gengarite', 'Timid'],
        ['Garchomp', 'Clear Amulet', 'Jolly'],
      ],
      moves: ['Shadow Ball', 'shadowball', 'Earthquake'],
      items: ['Gengarite', 'Clear Amulet'],
      abilities: ['Cursed Body', 'Rough Skin'],
      natures: ['Timid'],
    })
    .join('\n');
  assert.match(rendered, /commit /);
  assert.match(
    rendered,
    /Species Gengar: Ghost\/Poison; base stats HP 60, Attack 65, Defense 60, Special Attack 130, Special Defense 75, Speed 110; abilities Cursed Body/,
  );
  assert.match(rendered, /raw Speed 143-178 with Timid alignment/);
  assert.match(
    rendered,
    /Gengar-Mega \(Ghost\/Poison, base stats HP 60, Attack 65, Defense 80, Special Attack 170, Special Defense 95, Speed 130, abilities Shadow Tag; raw Speed 165-200 with Timid alignment\)/,
  );
  assert.match(
    rendered,
    /Species Garchomp: Dragon\/Ground; base stats HP 108, Attack 130, Defense 95, Special Attack 80, Special Defense 85, Speed 102/,
  );
  assert.match(rendered, /Move Shadow Ball: Ghost; Special; BP 80; acc 100%; priority \+0; target normal/);
  assert.equal(rendered.match(/- Move Shadow Ball:/g)?.length, 1);
  assert.match(rendered, /Move Earthquake: Ground; Physical; BP 100/);
  assert.match(rendered, /Ability Shadow Tag:/);
  assert.match(rendered, /Stat alignment Timid \(Showdown Nature\): \+spe, -atk/);
});

test('Champions stat ranges and exact spreads use Stat Points with fixed maximum IVs', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(
    reference.lookup('calculate_stats', {
      species: 'Garchomp',
      nature: 'Jolly',
      evs: { hp: 2, atk: 32, spe: 32 },
    }),
    /Stat Points 66\/66\): HP 185, Attack 182, Defense 115, Special Attack 90, Special Defense 105, Speed 169/,
  );
  assert.match(
    reference.lookup('lookup_ability', { name: 'Shadow Tag' }),
    /Ghost type|Ghost-type/,
    'an explicit mechanics lookup returns the full exception text',
  );
});

test('Mega formes require the visible matching stone', () => {
  const rendered = new ShowdownReference('gen9championsvgc2026regmb')
    .render({ speciesSets: [['Charizard', 'Choice Specs']], items: ['Choice Specs'] })
    .join('\n');
  assert.match(rendered, /Species Charizard: Fire\/Flying; base stats .* Speed 100/);
  assert.doesNotMatch(rendered, /Charizard-Mega/);
});

test('active matchup chart resolves Weather Ball under the live weather', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const attackers = [{ species: 'Politoed', moves: ['Weather Ball'], ally: true }];
  const defenders = [{ species: 'Incineroar', moves: [], ally: false }];
  const clear = reference.renderActiveMatchups(attackers, defenders).join('\n');
  assert.equal(clear, '- Damaging matchups not listed above are neutral (1x).');
  const rain = reference.renderActiveMatchups(attackers, defenders, 'RainDance').join('\n');
  assert.match(rain, /Weather Ball \(currently Water in RainDance\): Incineroar super-effective \(2x\)/);
  const sun = reference.renderActiveMatchups(attackers, defenders, 'SunnyDay').join('\n');
  assert.match(sun, /currently Fire in SunnyDay\): Incineroar not very effective/);
  const renderedRain = reference.renderActiveMatchups(attackers, defenders, 'RainDance (4 turns left)').join('\n');
  assert.match(renderedRain, /currently Water in RainDance \(4 turns left\)/);
  assert.match(
    reference.lookup('estimate_damage', {
      attacker: 'Politoed',
      defender: 'Incineroar',
      move: 'Weather Ball',
      weather: 'RainDance (4 turns left)',
    }),
    /weather 1\.5x/,
  );
});

test('active matchups exclude same-side targets and handle primal weather', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const attackers = [
    { species: 'Politoed', moves: ['Weather Ball'], ally: true },
    { species: 'Incineroar', moves: ['Flare Blitz'], ally: false },
  ];
  const defenders = [
    { species: 'Swampert', moves: [], ally: true },
    { species: 'Landorus', moves: [], ally: false },
  ];
  const rain = reference.renderActiveMatchups(attackers, defenders, 'PrimordialSea').join('\n');
  assert.match(rain, /Politoed Weather Ball \(currently Water in PrimordialSea\): Landorus/);
  assert.doesNotMatch(rain, /Politoed Weather Ball.*Swampert/);
  assert.match(rain, /Incineroar Flare Blitz \(Fire\): Swampert/);
  assert.doesNotMatch(rain, /Incineroar Flare Blitz.*Landorus/);

  const sun = reference.renderActiveMatchups(attackers, defenders, 'DesolateLand').join('\n');
  assert.doesNotMatch(sun, /Weather Ball/);
  assert.match(
    reference.lookup('estimate_damage', {
      attacker: 'Incineroar',
      defender: 'Gholdengo',
      move: 'Flare Blitz',
      weather: 'PrimordialSea (5 turns left)',
    }),
    /fails in Primordial Sea; 0% damage\. Cannot KO\./,
  );
});

test('lookup tools return one entry and reject missing data', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(reference.lookup('lookup_move', { name: 'Earthquake' }), /Earthquake/);
  assert.match(reference.lookup('lookup_move', { name: 'Protect' }), /triples each time/);
  assert.match(reference.lookup('lookup_move', { name: 'NotAMove' }), /No move data/);
  assert.match(reference.lookup('lookup_move', { name: 'Final Gambit' }), /Final Gambit/);
  assert.equal(
    reference.lookup('lookup_item', { name: 'Eviolite' }),
    'Eviolite is not legal in gen9championsvgc2026regmb.',
  );
  assert.equal(reference.lookup('lookup_species', { name: '' }), 'Species name is required.');
  assert.equal(reference.lookup('unknown'), 'Unknown tool: unknown');
  assert.deepEqual(DEX_TOOLS.find((tool) => tool.name === 'lookup_species')!.parameters.required, ['name']);
  assert.equal(
    'level' in (DEX_TOOLS.find((tool) => tool.name === 'lookup_species')!.parameters.properties as object),
    false,
  );
});

test('default Showdown checkout matches the pinned revision', () => {
  assert.equal(showdownCommit(), SHOWDOWN_LOCK.commit);
  assert.match(ShowdownReference.renderRevision(), /^[0-9a-f]{12}$/);
});

test('missing Showdown checkout fails immediately', () => {
  assert.throws(
    () => new ShowdownReference('test', path.join(REPO_ROOT, 'missing-showdown')),
    /Pokémon Showdown is not built.*setup:showdown/,
  );
});

test('matchup and damage tools stay within open information', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(
    reference.lookup('lookup_matchup', { move: 'Earthquake', defender: 'Decidueye-Hisui' }),
    /0\.5x|not very effective/,
  );
  assert.match(reference.lookup('lookup_matchup', { move: 'Leaf Blade', defender: 'Swampert' }), /2x|super-effective/);
  assert.match(reference.lookup('lookup_matchup', { move: 'Earthquake', defender: 'Pelipper' }), /immune/);
  const damage = reference.lookup('estimate_damage', {
    attacker: 'Swampert',
    defender: 'Farigiraf',
    move: 'Earthquake',
    attacker_stats: { atk: 176, def: 110, spa: 94, spd: 110, spe: 98 },
    defender_nature: 'Calm',
    is_spread_hit: true,
  });
  assert.match(damage, /\d+(?:\.\d+)?-\d+(?:\.\d+)?% of maximum HP/);
  assert.match(damage, /legal range|exact from request/);
  assert.doesNotMatch(damage, /exact foe|hidden (iv|ev)s?/i);
  assert.ok(DEX_TOOLS.some((tool) => tool.name === 'lookup_matchup'));
  assert.ok(DEX_TOOLS.some((tool) => tool.name === 'estimate_damage'));
});

test('effectiveness shows the per-type factors behind the combined multiplier', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(
    reference.lookup('lookup_matchup', { move: 'High Horsepower', defender: 'Venusaur' }),
    /neutral \(1x\) = Ground vs Grass 0\.5x × vs Poison 2x/,
  );
  assert.match(
    reference.lookup('lookup_matchup', { move: 'Close Combat', defender: 'Tinkaton' }),
    /neutral \(1x\) = Fighting vs Fairy 0\.5x × vs Steel 2x/,
  );
  assert.match(
    reference.lookup('estimate_damage', { attacker: 'Swampert', defender: 'Venusaur', move: 'High Horsepower' }),
    /neutral \(1x\) = Ground vs Grass 0\.5x × vs Poison 2x/,
  );
  assert.match(
    reference.lookup('estimate_damage', { attacker: 'Swampert', defender: 'Pelipper', move: 'Earthquake' }),
    /immune \(0x\) = Ground vs Water 1x × vs Flying 0x; 0% damage/,
  );
});

test('exact defender stats collapse the open-sheet range', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = {
    attacker: 'Gengar',
    defender: 'Farigiraf',
    move: 'Sludge Bomb',
    attacker_stats: { atk: 90, def: 80, spa: 182, spd: 95, spe: 178 },
  };
  const open = reference.lookup('estimate_damage', args);
  assert.match(open, /attack exact from request, open-sheet defense\/HP range/);
  const exact = reference.lookup('estimate_damage', {
    ...args,
    defender_stats: { hp: 217, def: 121, spd: 141 },
  });
  assert.match(exact, /attack exact from request, defense\/HP exact from request/);
  const spread = (text: string) => {
    const match = text.match(/: ([\d.]+)-([\d.]+)% of maximum HP/)!;
    return Number(match[2]) - Number(match[1]);
  };
  assert.ok(spread(exact) < spread(open), 'exact stats must narrow the damage range');
});

test('damage tools reject items removed from the Champions format', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = { attacker: 'Gengar', defender: 'Farigiraf', move: 'Sludge Bomb' };
  assert.match(reference.lookup('estimate_damage', args), /defender item 1x/);
  assert.equal(
    reference.lookup('estimate_damage', { ...args, defender_item: 'Assault Vest' }),
    'Assault Vest is not legal in gen9championsvgc2026regmb.',
  );
  assert.equal(
    reference.lookup('estimate_damage', { ...args, defender_item: 'Eviolite' }),
    'Eviolite is not legal in gen9championsvgc2026regmb.',
  );
  assert.match(reference.lookup('estimate_damage', { ...args, defender_item: 'Leftovers' }), /defender item 1x/);
});

test('damage estimates accept percentages only, reject zero exact stats, and label KO certainty', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const possible = reference.lookup('estimate_damage', {
    attacker: 'Tauros-Paldea-Aqua',
    defender: 'Incineroar',
    move: 'Raging Bull',
    attacker_stats: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    attacker_nature: 'Adamant',
    defender_hp_percent: 70,
  });
  assert.match(possible, /Raging Bull \(Water Physical BP 90\)/);
  assert.match(possible, /Possible KO from the shown 70%, not guaranteed/);
  assert.match(possible, /legal attack range/);
  assert.doesNotMatch(possible, /damage \d+-\d+|max HP \d+|current HP \d+/);

  const guaranteed = reference.lookup('estimate_damage', {
    attacker: 'Tauros-Paldea-Aqua',
    defender: 'Incineroar',
    move: 'Raging Bull',
    attacker_nature: 'Adamant',
    defender_hp_percent: 10,
  });
  assert.match(guaranteed, /Guaranteed KO from the shown 10%/);

  const impossible = reference.lookup('estimate_damage', {
    attacker: 'Pikachu',
    defender: 'Steelix',
    move: 'Quick Attack',
    attacker_nature: 'Timid',
  });
  assert.match(impossible, /Cannot OHKO/);

  const damageProperties = DEX_TOOLS.find((tool) => tool.name === 'estimate_damage')!.parameters.properties;
  assert.ok(isRecord(damageProperties));
  assert.equal('attacker_hp' in damageProperties, false);
  assert.equal('attacker_max_hp' in damageProperties, false);
  assert.equal('defender_hp' in damageProperties, false);
  assert.equal('defender_max_hp' in damageProperties, false);
});

test('compact reference omits ability essays and full move text', () => {
  const compact = new ShowdownReference('gen9championsvgc2026regmb')
    .renderCompact([
      {
        species: 'Swampert',
        item: 'Swampertite',
        nature: 'Adamant',
        moves: ['Earthquake', 'Protect'],
        active: true,
      },
    ])
    .join('\n');
  assert.match(compact, /Compact Showdown reference/);
  assert.match(compact, /Swampert: Water\/Ground/);
  assert.match(compact, /Earthquake Ground\/Physical\/100/);
  assert.doesNotMatch(compact, /Damage doubles if the target is using Dig/);
  assert.doesNotMatch(compact, /abilities Damp\/Torrent/);
});

test('compact reference tags non-single-target moves', () => {
  const compact = new ShowdownReference('gen9championsvgc2026regmb')
    .renderCompact([
      {
        species: 'Sylveon',
        item: 'Fairy Feather',
        nature: 'Modest',
        moves: ['Hyper Voice', 'Earthquake', 'Tailwind', 'Rage Powder', 'Quick Attack'],
        active: false,
      },
    ])
    .join('\n');
  assert.match(compact, /Hyper Voice Normal\/Special\/90\/spread/);
  assert.match(compact, /Earthquake Ground\/Physical\/100\/spread\+ally/);
  assert.match(compact, /Tailwind Flying\/Status\/no power\/ally-side/);
  assert.match(
    compact,
    /Rage Powder Bug\/Status\/no power\/self\/priority \+2\/powder: fails on Grass types, Overcoat, and Safety Goggles/,
  );
  assert.match(compact, /Quick Attack Normal\/Physical\/40\/priority \+1/);
});

test('compact and matchup references resolve Raging Bull from the Tauros forme', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const compact = reference
    .renderCompact([
      { species: 'Tauros-Paldea-Combat', moves: ['Raging Bull'] },
      { species: 'Tauros-Paldea-Blaze', moves: ['Raging Bull'] },
      { species: 'Tauros-Paldea-Aqua', moves: ['Raging Bull'] },
    ])
    .join('\n');
  assert.match(compact, /Tauros-Paldea-Combat: Fighting;.*Raging Bull Fighting\/Physical\/90/);
  assert.match(compact, /Tauros-Paldea-Blaze: Fighting\/Fire;.*Raging Bull Fire\/Physical\/90/);
  assert.match(compact, /Tauros-Paldea-Aqua: Fighting\/Water;.*Raging Bull Water\/Physical\/90/);
  assert.match(
    reference.lookup('lookup_matchup', {
      attacker: 'Tauros-Paldea-Aqua',
      move: 'Raging Bull',
      defender: 'Gengar',
    }),
    /Raging Bull \(Water\).*neutral/,
  );
  assert.equal(
    reference.lookup('lookup_matchup', { move: 'Raging Bull', defender: 'Gengar' }),
    'attacker is required to resolve Raging Bull typing.',
  );
});

test('move lookups surface powder and sound interactions missing from descriptions', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(
    reference.lookup('lookup_move', { name: 'Rage Powder' }),
    /powder move: no effect on Grass types, Overcoat, or Safety Goggles holders \(including redirection\)/,
  );
  assert.match(
    reference.lookup('lookup_move', { name: 'Hyper Voice' }),
    /sound move: blocked by Soundproof, bypasses Substitute/,
  );
  assert.doesNotMatch(reference.lookup('lookup_move', { name: 'Earthquake' }), /powder move|sound move/);
});

test('compact reference shows the mega outcome for stone holders only', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const holder = reference
    .renderCompact([{ species: 'Swampert', item: 'Swampertite', nature: 'Adamant', moves: [], active: false }])
    .join('\n');
  assert.match(holder, /if Mega Evolved -> Swampert-Mega: Water\/Ground, ability Swift Swim/);
  assert.match(holder, /Attack 150/);
  const wrongStone = reference
    .renderCompact([{ species: 'Swampert', item: 'Gengarite', nature: 'Adamant', moves: [], active: false }])
    .join('\n');
  assert.doesNotMatch(wrongStone, /Mega Evolved/);
});

test('speed profiles apply visible battle modifiers without collapsing hidden ranges', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.deepEqual(
    reference.speedProfile({
      species: 'Tauros-Paldea-Aqua',
      nature: 'Adamant',
      item: 'Choice Scarf',
    }),
    {
      raw: [120, 152],
      effective: [180, 228],
      modifiers: ['Choice Scarf ×1.5'],
    },
  );
  assert.deepEqual(
    reference.speedProfile({
      species: 'Venusaur-Mega',
      nature: 'Modest',
      tailwind: true,
    })?.effective,
    [200, 264],
  );
  assert.deepEqual(
    reference.speedProfile({
      species: 'Gengar-Mega',
      exact: 170,
      status: 'par',
    })?.effective,
    [85, 85],
  );
  assert.equal(reference.movePriority('Quick Attack'), 1);
  assert.equal(reference.movePriority('Encore'), 0);
});
