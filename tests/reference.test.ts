import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from '../src/paths.js';
import { DEX_TOOLS, ShowdownReference } from '../src/reference.js';
import { SHOWDOWN_LOCK, showdownCommit } from '../src/showdown.js';

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
    /Species Gengar: Ghost\/Poison; base stats HP 60, Atk 65, Def 60, SpA 130, SpD 75, Spe 110; abilities Cursed Body/,
  );
  assert.match(rendered, /Speed 126-178 with Timid alignment/);
  assert.match(
    rendered,
    /Gengar-Mega \(Ghost\/Poison, base stats HP 60, Atk 65, Def 80, SpA 170, SpD 95, Spe 130, abilities Shadow Tag; Speed 148-200 with Timid alignment\)/,
  );
  assert.match(
    rendered,
    /Species Garchomp: Dragon\/Ground; base stats HP 108, Atk 130, Def 95, SpA 80, SpD 85, Spe 102/,
  );
  assert.match(rendered, /Move Shadow Ball: Ghost; Special; BP 80; acc 100%; priority \+0; target normal/);
  assert.equal(rendered.match(/- Move Shadow Ball:/g)?.length, 1);
  assert.match(rendered, /Move Earthquake: Ground; Physical; BP 100/);
  assert.match(rendered, /Ability Shadow Tag:/);
  assert.match(rendered, /Stat alignment Timid \(Showdown Nature\): \+spe, -atk/);
});

test('Mega formes require the visible matching stone', () => {
  const rendered = new ShowdownReference('gen9championsvgc2026regmb')
    .render({ speciesSets: [['Charizard', 'Choice Specs']], items: ['Choice Specs'] })
    .join('\n');
  assert.match(rendered, /Species Charizard: Fire\/Flying; base stats .* Spe 100/);
  assert.doesNotMatch(rendered, /Charizard-Mega/);
});

test('lookup tools return one entry and reject missing data', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  assert.match(reference.lookup('lookup_move', { name: 'Earthquake' }), /Earthquake/);
  assert.match(reference.lookup('lookup_move', { name: 'Protect' }), /triples each time/);
  assert.match(reference.lookup('lookup_move', { name: 'NotAMove' }), /No move data/);
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
  assert.match(damage, /damage \d+-\d+/);
  assert.match(damage, /legal range|exact from request/);
  assert.doesNotMatch(damage, /exact foe|hidden (iv|ev)s?/i);
  assert.ok(DEX_TOOLS.some((tool) => tool.name === 'lookup_matchup'));
  assert.ok(DEX_TOOLS.some((tool) => tool.name === 'estimate_damage'));
});

test('defender items model Assault Vest and Eviolite and disclose everything else', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = { attacker: 'Gengar', defender: 'Farigiraf', move: 'Sludge Bomb' };
  assert.match(reference.lookup('estimate_damage', args), /defender item 1x/);
  assert.match(reference.lookup('estimate_damage', { ...args, defender_item: 'Assault Vest' }), /defender item 1\.5x/);
  assert.match(
    reference.lookup('estimate_damage', { ...args, move: 'Crunch', defender_item: 'Assault Vest' }),
    /defender item 1x/,
  );
  assert.match(
    reference.lookup('estimate_damage', { ...args, defender_item: 'Leftovers' }),
    /defender item 1x.*other than Assault Vest\/Eviolite/s,
  );
});

test('damage percentages use real foe HP even when the model passes percent-scale HP', () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const args = {
    attacker: 'Whimsicott',
    defender: 'Incineroar',
    move: 'Moonblast',
    attacker_stats: { atk: 78, def: 105, spa: 129, spd: 95, spe: 184 },
    defender_nature: 'Impish',
  };
  // Showdown shows foe HP as x/100; raw 70/100 must not be treated as 70 real HP.
  const misused = reference.lookup('estimate_damage', { ...args, defender_hp: 70, defender_max_hp: 100 });
  assert.match(misused, /legal max HP \d{3}/);
  assert.match(misused, /defender shown at 70%/);
  assert.doesNotMatch(misused, /1[0-9][0-9](?:\.\d)?% of/);
  const explicit = reference.lookup('estimate_damage', { ...args, defender_hp_percent: 70 });
  assert.match(explicit, /defender shown at 70%/);
  // Exact raw HP for the model's own side still reports percent of current HP.
  const own = reference.lookup('estimate_damage', { ...args, defender_hp: 142, defender_max_hp: 202 });
  assert.match(own, /% of current HP 142/);
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
