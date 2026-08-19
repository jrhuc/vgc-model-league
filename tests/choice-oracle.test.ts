import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Battle, Side } from 'pokemon-showdown';

import { buildMenus } from '../src/choices.js';
import { acceptedBattleActionEntries } from '../src/fork.js';
import { REPO_ROOT } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import type { BattleRequest, Pid } from '../src/types.js';
import { requestActionCandidates } from './fixtures/fork.js';

const Showdown = loadShowdown();
const SEED = '31,41,59,26' as const;
const FORMAT = 'gen9championsvgc2026regmbbo3';

type PokemonSet = NonNullable<Parameters<typeof Showdown.Teams.pack>[0]>[number];

function oracleSet(name: string, species: string, ability: string, moves: string[]): PokemonSet {
  return {
    name,
    species,
    item: '',
    ability,
    moves,
    nature: 'Serious',
    gender: '',
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: 100,
  };
}

const ORACLE_TEAM: PokemonSet[] = [
  oracleSet('One', 'Mew', 'Synchronize', ['Acupressure', 'Helping Hand', 'Earthquake', 'Protect']),
  oracleSet('Two', 'Mew', 'Synchronize', ['Doodle', 'Aura Sphere', 'Outrage', 'Counter']),
  oracleSet('Three', 'Pawmot', 'Natural Cure', ['Revival Blessing', 'Nuzzle', 'Protect', 'Close Combat']),
  oracleSet('Four', 'Pikachu', 'Static', ['Thunderbolt', 'Protect']),
  oracleSet('Five', 'Eevee', 'Run Away', ['Quick Attack', 'Protect']),
  oracleSet('Six', 'Ditto', 'Limber', ['Transform']),
];

const ORACLE_PACKED = Showdown.Teams.pack(ORACLE_TEAM);
const MEGA_PACKED = fs
  .readFileSync(path.join(REPO_ROOT, 'teams', 'test', 'rios-mega-raichu-x-venusaur.team'), 'utf8')
  .trim();

function newBattle(format = FORMAT, packed = ORACLE_PACKED): Battle {
  const battle = new Showdown.Battle({ formatid: format, seed: SEED });
  battle.setPlayer('p1', { name: 'oracle-p1', team: packed });
  battle.setPlayer('p2', { name: 'oracle-p2', team: packed });
  return battle;
}

function requestOf(battle: Battle, pid: Pid = 'p1'): BattleRequest {
  return battle.getSide(pid).activeRequest as unknown as BattleRequest;
}

function cloneBattle(battle: Battle): Battle {
  const clone = Showdown.Battle.fromJSON(battle.toJSON());
  clone.restart(() => {});
  return clone;
}

function accepted(battle: Battle, command: string, pid: Pid = 'p1'): boolean {
  return cloneBattle(battle).getSide(pid).choose(command) === true;
}

function assertAccepted(battle: Battle, command: string, pid: Pid = 'p1'): void {
  const clone = cloneBattle(battle);
  const side = clone.getSide(pid);
  assert.equal(side.choose(command), true, `${pid} rejected ${command}: ${side.choice.error}`);
}

function assertAcceptedAndSurfaced(battle: Battle, command: string, pid: Pid = 'p1'): void {
  assertAccepted(battle, command, pid);
  assert.ok(
    requestActionCandidates(requestOf(battle, pid)).includes(command),
    `accepted command was not surfaced: ${command}`,
  );
}

function assertEverySurfacedActionIsAccepted(battle: Battle, pid: Pid = 'p1'): string[] {
  const request = requestOf(battle, pid);
  const actions = requestActionCandidates(request);
  assert.ok(actions.length > 0);
  for (const action of actions) assertAccepted(battle, action, pid);
  assert.deepEqual(
    acceptedBattleActionEntries(battle, pid).map((entry) => entry.command),
    actions,
  );
  return actions;
}

function choosePreview(battle: Battle, p1 = '1234', p2 = '1234'): void {
  assert.equal(battle.choose('p1', `team ${p1}`), true);
  assert.equal(battle.choose('p2', `team ${p2}`), true);
}

function markFainted(side: Side, index: number, needsReplacement = false): void {
  const pokemon = side.pokemon[index]!;
  pokemon.hp = 0;
  pokemon.fainted = true;
  pokemon.switchFlag = needsReplacement;
  side.pokemonLeft -= 1;
  side.totalFainted += 1;
}

test('team preview candidates round-trip through a cloned Showdown battle', () => {
  const battle = newBattle();
  const request = requestOf(battle);
  assert.equal(request.teamPreview, true);
  assert.equal(request.maxChosenTeamSize, 4);
  assert.equal(request.active, undefined);

  const actions = assertEverySurfacedActionIsAccepted(battle);
  assert.ok(actions.every((action) => !action.includes('terastallize')));
  assertAcceptedAndSurfaced(battle, 'team 6543');
});

test('special target kinds round-trip through their real move request', () => {
  const battle = newBattle();
  choosePreview(battle);
  const request = requestOf(battle);
  assert.ok(request.active?.every((active) => !active?.canTerastallize));
  const targets = request.active?.flatMap((active) =>
    ((active?.moves ?? []) as Array<Record<string, unknown>>).map((move) => move.target),
  );
  for (const target of [
    'adjacentAllyOrSelf',
    'adjacentAlly',
    'allAdjacent',
    'self',
    'adjacentFoe',
    'any',
    'randomNormal',
    'scripted',
  ]) {
    assert.ok(targets?.includes(target), `real request did not contain ${target}`);
  }

  assertEverySurfacedActionIsAccepted(battle);
  for (const command of [
    'move 1 -1, move 3',
    'move 2 -2, move 4',
    'move 3, move 1 +2',
    'move 4, move 2 -1',
    'move 4, move 2 +2',
  ]) {
    assertAcceptedAndSurfaced(battle, command);
  }
});

test('a trapped active has only Showdown-accepted surfaced actions', () => {
  const battle = newBattle();
  choosePreview(battle);
  const side = battle.getSide('p1');
  side.active[0]!.trapped = true;
  battle.makeRequest('move');
  const request = requestOf(battle);
  assert.equal(request.active?.[0]?.trapped, true);

  const actions = assertEverySurfacedActionIsAccepted(battle);
  assertAcceptedAndSurfaced(battle, 'move 4, switch 3');
  assert.equal(accepted(battle, 'switch 3, move 3'), false);
  assert.ok(actions.every((action) => !action.startsWith('switch ')));
});

test('joint menus surface either Mega Evolution but not Showdown-rejected double Mega', () => {
  const battle = newBattle(FORMAT, MEGA_PACKED);
  choosePreview(battle);
  const request = requestOf(battle);
  assert.ok(request.active?.every((active) => active?.canMegaEvo === true));

  const actions = assertEverySurfacedActionIsAccepted(battle);
  assertAcceptedAndSurfaced(battle, 'move 1 +1 mega, move 1');
  assertAcceptedAndSurfaced(battle, 'move 1 +1, move 1 mega');
  assert.equal(accepted(battle, 'move 1 +1 mega, move 1 mega'), false);
  assert.ok(actions.every((action) => (action.match(/ mega/g) ?? []).length <= 1));

  assert.ok(buildMenus(request)[0]?.some((item) => item.kind === 'forfeit'));
  assert.ok(actions.every((action) => !action.includes('forfeit')));
});

test('Revival Blessing request targets fainted party slots accepted by Showdown', () => {
  const battle = newBattle();
  choosePreview(battle, '3124');
  const side = battle.getSide('p1');
  markFainted(side, 2);
  markFainted(side, 3);
  battle.makeRequest('move');

  assert.equal(battle.choose('p1', 'move 1, move 4'), true);
  assert.equal(battle.choose('p2', 'move 4, move 4'), true);
  const request = requestOf(battle);
  assert.deepEqual(request.forceSwitch, [true, false]);
  assert.equal(request.side?.pokemon?.[0]?.reviving, true);

  assertEverySurfacedActionIsAccepted(battle);
  assertAcceptedAndSurfaced(battle, 'switch 3, pass');
  assertAcceptedAndSurfaced(battle, 'switch 4, pass');
  assert.equal(accepted(battle, 'switch 1, pass'), false);
});

test('Revival Blessing can target an ally that fainted in its active slot', () => {
  const battle = newBattle();
  choosePreview(battle, '3142', '5612');
  battle.getSide('p1').active[1]!.hp = 1;
  battle.makeRequest('move');

  assert.equal(battle.choose('p1', 'move 1, move 1 -2'), true);
  assert.equal(battle.choose('p2', 'move 1 +2, move 1 +1'), true);
  const request = requestOf(battle);
  assert.deepEqual(request.forceSwitch, [true, false]);
  assert.equal(request.side?.pokemon?.[0]?.reviving, true);
  assert.equal(request.side?.pokemon?.[1]?.active, true);
  assert.match(String(request.side?.pokemon?.[1]?.condition), / fnt$/);

  assertEverySurfacedActionIsAccepted(battle);
  assertAcceptedAndSurfaced(battle, 'switch 2, pass');
  assert.equal(accepted(battle, 'switch 3, pass'), false);
});

test('a double replacement with one reserve surfaces both accepted switch/pass orders', () => {
  const battle = newBattle();
  choosePreview(battle);
  const side = battle.getSide('p1');
  markFainted(side, 0, true);
  markFainted(side, 1, true);
  markFainted(side, 3);
  battle.makeRequest('switch');
  const request = requestOf(battle);
  assert.deepEqual(request.forceSwitch, [true, true]);

  assertEverySurfacedActionIsAccepted(battle);
  assertAcceptedAndSurfaced(battle, 'switch 3, pass');
  assertAcceptedAndSurfaced(battle, 'pass, switch 3');
  assert.equal(accepted(battle, 'pass, pass'), false);
});
