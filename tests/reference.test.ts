import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    /Weather Ball \(Water Special BP 100\).*applied rain/,
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

test('learnset lookup lists format-legal moves and excludes folklore', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const pikachu = reference.lookup('lookup_learnset', { name: 'pikachu' });
  assert.match(pikachu, /^- Learnset Pikachu \(\d+ legal moves\): /);
  assert.match(pikachu, /Fake Out/);
  assert.doesNotMatch(pikachu, /Follow Me/);
  const gholdengo = reference.lookup('lookup_learnset', { name: 'gholdengo' });
  assert.match(gholdengo, /Make It Rain/);
  assert.doesNotMatch(gholdengo, /Thunder Wave/);
  assert.match(reference.lookup('lookup_learnset', { name: 'garchomp-mega' }), /Earthquake/);
  assert.equal(reference.lookup('lookup_learnset', { name: '' }), 'Species name is required.');
  assert.match(reference.lookup('lookup_learnset', { name: 'notreal' }), /No species data/);
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
});

test('reference render revision binds the versioned executed module bytes', () => {
  const modulePath = fileURLToPath(new URL('../src/reference.js', import.meta.url));
  const moduleBytes = fs.readFileSync(modulePath);
  const revisionFor = (content: Buffer): string =>
    createHash('sha256').update('showdown-reference-render-v1').update('\0').update(content).digest('hex').slice(0, 12);
  const revision = ShowdownReference.renderRevision();
  assert.match(revision, /^[0-9a-f]{12}$/);
  assert.equal(revision, revisionFor(moduleBytes));
  assert.notEqual(
    revisionFor(Buffer.concat([moduleBytes, Buffer.from("\nvoid 'modified reference revision fixture';\n")])),
    revision,
  );
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

test('offline damage defaults to a single hit and honors an explicit spread flag', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = {
    attacker: 'Garchomp',
    defender: 'Incineroar',
    move: 'Earthquake',
    attacker_stats: { atk: 182 },
    defender_stats: { hp: 202, def: 121 },
  };
  const single = reference.lookup('estimate_damage', args);
  const explicitSingle = reference.lookup('estimate_damage', { ...args, is_spread_hit: false });
  const spread = reference.lookup('estimate_damage', { ...args, is_spread_hit: true });
  assert.equal(single, explicitSingle);
  assert.doesNotMatch(single, /spread \(0\.75x\)/);
  assert.match(spread, /spread \(0\.75x\)/);
  assert.notEqual(spread, single);
  assert.match(
    (
      DEX_TOOLS.find((entry) => entry.name === 'estimate_damage')!.parameters.properties as Record<
        string,
        { description: string }
      >
    ).is_spread_hit!.description,
    /Defaults false outside a live battle/,
  );
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
  const fixed = reference.lookup('estimate_damage', {
    attacker: 'Maushold',
    defender: 'Farigiraf',
    move: 'Super Fang',
    defender_stats: { hp: 217, def: 121 },
  });
  assert.match(fixed, /49\.8-49\.8% of maximum HP/);
});

test('damage tools reject items removed from the Champions format', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = { attacker: 'Gengar', defender: 'Farigiraf', move: 'Sludge Bomb' };
  assert.match(reference.lookup('estimate_damage', args), /no abilities, items, status, or field effects applied/);
  assert.equal(
    reference.lookup('estimate_damage', { ...args, defender_item: 'Assault Vest' }),
    'Assault Vest is not legal in gen9championsvgc2026regmb.',
  );
  assert.equal(
    reference.lookup('estimate_damage', { ...args, defender_item: 'Eviolite' }),
    'Eviolite is not legal in gen9championsvgc2026regmb.',
  );
  assert.match(reference.lookup('estimate_damage', { ...args, defender_item: 'Leftovers' }), /defender item Leftovers/);
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

test('species lookups resolve board display names the dex does not alias', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(reference.lookup('lookup_species', { name: 'Basculegion-Male' }), /Species Basculegion:/);
  assert.match(reference.lookup('lookup_species', { name: 'Basculegion-Female' }), /Species Basculegion-F:/);
  assert.match(reference.lookup('lookup_species', { name: 'Meowstic-Male' }), /Species Meowstic:/);
  assert.match(reference.lookup('lookup_species', { name: 'Mega Raichu Y' }), /Species Raichu-Mega-Y:/);
  assert.match(reference.lookup('lookup_species', { name: 'Mega Meowstic' }), /Species Meowstic-M-Mega:/);
  assert.match(reference.lookup('lookup_species', { name: 'Paldean Tauros' }), /Species Tauros-Paldea-Combat:/);
  assert.match(reference.lookup('lookup_species', { name: 'Paldean Tauros Aqua' }), /Species Tauros-Paldea-Aqua:/);
  assert.match(reference.lookup('lookup_learnset', { name: 'Basculegion-Male' }), /Learnset Basculegion \(/);
  assert.match(
    reference.lookup('calculate_stats', { species: 'Basculegion-Male', nature: 'Jolly', evs: { atk: 32, spe: 32 } }),
    /^Basculegion \(Jolly/,
  );
});

test('damage estimates fall back to legal ranges for implausible stats but keep stage-boosted values', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = { attacker: 'Basculegion', defender: 'Gengar-Mega', move: 'Last Respects' };
  const implausibleDef = reference.lookup('estimate_damage', { ...args, defender_stats: { hp: 1, def: 1 } });
  assert.match(implausibleDef, /defender_stats\.def 1 is implausible for Gengar-Mega, so the legal range was used/);
  assert.match(implausibleDef, /% of maximum HP/, 'the estimate must still be produced');
  assert.match(
    reference.lookup('estimate_damage', { ...args, defender_stats: { hp: 1, def: 110 } }),
    /defender_stats\.hp 1 is outside Gengar-Mega's legal HP range \d+-\d+, so the legal range was used/,
  );
  assert.match(
    reference.lookup('estimate_damage', { ...args, attacker_stats: { atk: 9999 } }),
    /attacker_stats\.atk 9999 is implausible for Basculegion, so the legal range was used/,
  );
  assert.match(
    reference.lookup('estimate_damage', { ...args, attacker_stats: { atk: 328 } }),
    /Last Respects \(Ghost Physical BP 50\) into Gengar-Mega: \d+/,
  );
});

test('damage estimates apply abilities, stages, burn, screens, and terrain through the engine', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = { attacker: 'Garchomp', defender: 'Incineroar', move: 'Earthquake', is_spread_hit: false };
  const maxPercent = (result: string) => {
    const match = result.match(/-([\d.]+)% of maximum HP/);
    assert.ok(match, `expected a damage range in: ${result}`);
    return Number(match![1]);
  };
  const near = (ratio: number, expected: number) => Math.abs(ratio - expected) < 0.02;
  const base = maxPercent(reference.lookup('estimate_damage', args));
  const burned = maxPercent(reference.lookup('estimate_damage', { ...args, attacker_status: 'brn' }));
  assert.ok(near(burned / base, 0.5), `burn must halve physical damage (${base} -> ${burned})`);
  const boosted = maxPercent(reference.lookup('estimate_damage', { ...args, attacker_boosts: { atk: 2 } }));
  assert.ok(near(boosted / base, 2), `+2 atk must double damage (${base} -> ${boosted})`);
  const screened = maxPercent(reference.lookup('estimate_damage', { ...args, defender_screens: ['reflect'] }));
  assert.ok(near(screened / base, 2732 / 4096), `Reflect in doubles is a 1/3 cut (${base} -> ${screened})`);
  const intimidated = maxPercent(reference.lookup('estimate_damage', { ...args, attacker_boosts: { atk: -1 } }));
  assert.ok(intimidated < base, 'negative stages must reduce damage');
  assert.match(
    reference.lookup('estimate_damage', { ...args, defender_ability: 'Levitate' }),
    /immune or absorbed by Levitate/,
  );
  const grounded = maxPercent(
    reference.lookup('estimate_damage', {
      attacker: 'Iron Treads',
      defender: 'Incineroar',
      move: 'Steel Roller',
      terrain: 'grassy',
      is_spread_hit: false,
    }),
  );
  assert.ok(grounded > 0, 'terrain-dependent moves must compute under the supplied terrain');
  assert.match(
    reference.lookup('estimate_damage', {
      attacker: 'Azumarill',
      defender: 'Dragonite',
      move: 'Play Rough',
      attacker_ability: 'Huge Power',
    }),
    /applied attacker ability Huge Power/,
  );
  const partialBoosts = reference.lookup('estimate_damage', {
    ...args,
    defender_ability: 'Intimidate',
    attacker_boosts: { spe: 1 },
  });
  const explicitNeutralAttack = reference.lookup('estimate_damage', {
    ...args,
    defender_ability: 'Intimidate',
    attacker_boosts: { atk: 0, spe: 1 },
  });
  assert.equal(
    maxPercent(partialBoosts),
    maxPercent(explicitNeutralAttack),
    'unspecified current stat stages must stay neutral after ability activation',
  );
  const sunny = reference.lookup('estimate_damage', {
    attacker: 'Torkoal',
    defender: 'Gholdengo',
    move: 'Heat Wave',
    attacker_ability: 'Drought',
  });
  assert.equal(
    maxPercent(sunny),
    maxPercent(
      reference.lookup('estimate_damage', {
        attacker: 'Torkoal',
        defender: 'Gholdengo',
        move: 'Heat Wave',
        attacker_ability: 'Drought',
        weather: 'sun',
      }),
    ),
    'ability-created weather must remain active when no explicit weather is supplied',
  );
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

test('type-changing abilities convert Normal moves in the chart and matchup tool', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const chart = reference
    .renderActiveMatchups(
      [{ species: 'Gardevoir-Mega', moves: ['Hyper Voice'], ally: true, ability: 'Pixilate' }],
      [{ species: 'Gengar-Mega', moves: [], ally: false }],
    )
    .join('\n');
  assert.match(
    chart,
    /Hyper Voice \(currently Fairy for Gardevoir-Mega \(Pixilate\)\): Gengar-Mega not very effective \(0\.5x\)/,
  );
  assert.doesNotMatch(chart, /immune/);
  assert.match(
    reference.lookup('lookup_matchup', { attacker: 'Gardevoir-Mega', move: 'Hyper Voice', defender: 'Gengar-Mega' }),
    /Hyper Voice \(Fairy via Pixilate\) into Gengar-Mega[\s\S]*not very effective/,
  );
});

test('active matchup references apply visible defensive immunities', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const chart = reference
    .renderActiveMatchups(
      [{ species: 'Swampert', moves: ['Earthquake'], ally: true, ability: 'Damp' }],
      [{ species: 'Rotom-Heat', moves: [], ally: false, ability: 'Levitate' }],
    )
    .join('\n');
  assert.match(chart, /Rotom-Heat immune via Levitate \(type chart super-effective \(4x\)\)/);
  const moldBreaker = reference
    .renderActiveMatchups(
      [{ species: 'Excadrill', moves: ['Earthquake'], ally: true, ability: 'Mold Breaker' }],
      [{ species: 'Rotom-Heat', moves: [], ally: false, ability: 'Levitate' }],
    )
    .join('\n');
  assert.match(moldBreaker, /Rotom-Heat super-effective \(4x\)/);
  assert.doesNotMatch(moldBreaker, /immune via Levitate/);
});

test('Unaware ignores attacker boosts in the damage estimate', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const range = (result: string) => /(\d+(?:\.\d+)?-\d+(?:\.\d+)?)% of maximum HP/.exec(result)?.[1];
  const base = { attacker: 'Gengar-Mega', defender: 'Milotic', move: 'Shadow Ball', defender_ability: 'Unaware' };
  const unboosted = reference.lookup('estimate_damage', base);
  const boosted = reference.lookup('estimate_damage', { ...base, attacker_boosts: { spa: 2 } });
  assert.ok(range(unboosted), unboosted);
  assert.equal(range(boosted), range(unboosted));
  const noAbility = reference.lookup('estimate_damage', {
    attacker: 'Gengar-Mega',
    defender: 'Milotic',
    move: 'Shadow Ball',
    attacker_boosts: { spa: 2 },
  });
  assert.notEqual(range(noAbility), range(unboosted));
});

test('Last Respects scales with the attacker side fainted count', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const base = { attacker: 'Basculegion', defender: 'Kingambit', move: 'Last Respects' };
  const power = (fainted: number): number => {
    const text = reference.lookup('estimate_damage', { ...base, attacker_fainted_allies: fainted });
    return Number(/BP (\d+)/.exec(text)?.[1]);
  };
  assert.equal(power(0), 50);
  assert.equal(power(3), 200);
  const floor = reference.lookup('estimate_damage', { ...base, attacker_fainted_allies: 0 });
  const nuke = reference.lookup('estimate_damage', { ...base, attacker_fainted_allies: 3 });
  const high = (text: string): number => Number(/-(\d+(?:\.\d+)?)% of maximum HP/.exec(text)?.[1]);
  assert.ok(high(nuke) > high(floor) * 3, `${nuke} should far outdamage ${floor}`);
});

test('active allies apply their abilities without leaking their field effects', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const range = (text: string): string => /: ([\d.]+-[\d.]+)%/.exec(text)?.[1] ?? '';
  const quake = { attacker: 'Garchomp', defender: 'Incineroar', move: 'Earthquake' };
  const alone = range(reference.lookup('estimate_damage', quake));
  const guarded = range(
    reference.lookup('estimate_damage', { ...quake, defender_ally: 'Clefairy', defender_ally_ability: 'Friend Guard' }),
  );
  const neutral = range(
    reference.lookup('estimate_damage', { ...quake, defender_ally: 'Clefairy', defender_ally_ability: 'Magic Guard' }),
  );
  assert.notEqual(guarded, alone, 'Friend Guard must reduce the estimate');
  assert.equal(neutral, alone, 'an ally without a damage-relevant ability must change nothing');
  const sword = range(
    reference.lookup('estimate_damage', {
      ...quake,
      attacker_ally: 'Chien-Pao',
      attacker_ally_ability: 'Sword of Ruin',
    }),
  );
  assert.notEqual(sword, alone, 'a Ruin aura on the ally must reach the calculation');

  const ball = { attacker: 'Politoed', defender: 'Incineroar', move: 'Weather Ball' };
  assert.equal(
    range(reference.lookup('estimate_damage', { ...ball, attacker_ally: 'Torkoal', attacker_ally_ability: 'Drought' })),
    range(reference.lookup('estimate_damage', ball)),
    "an ally's weather ability must not invent weather the caller never reported",
  );
  const sun = { attacker: 'Charizard-Mega-Y', defender: 'Incineroar', move: 'Heat Wave', attacker_ability: 'Drought' };
  assert.equal(
    range(
      reference.lookup('estimate_damage', { ...sun, attacker_ally: 'Clefairy', attacker_ally_ability: 'Friend Guard' }),
    ),
    range(reference.lookup('estimate_damage', sun)),
    'the attacker’s own weather must survive an ally being fielded',
  );
});

test('damage estimates carry no repeated standing caveats', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const text = reference.lookup('estimate_damage', {
    attacker: 'Garchomp',
    defender: 'Incineroar',
    move: 'Earthquake',
  });
  for (const boilerplate of [
    "Computed by the format's battle engine",
    'Omits allies',
    'Assumes no critical hit',
    'are ignored',
  ])
    assert.ok(!text.includes(boilerplate), `standing caveat "${boilerplate}" belongs in the tool description`);
});
