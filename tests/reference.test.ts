import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from '../src/paths.js';
import { DEX_TOOLS, ShowdownReference } from '../src/reference.js';

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
    .render({ speciesItems: [['Charizard', 'Choice Specs']], items: ['Choice Specs'] })
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

test('missing Showdown checkout fails immediately', () => {
  assert.throws(() => new ShowdownReference('test', path.join(REPO_ROOT, 'missing-showdown')), /Cannot find module/);
});
