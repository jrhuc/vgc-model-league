import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { SlotMenu } from '../src/choices.js';
import { buildMenus } from '../src/choices.js';
import { BaseEngine } from '../src/engines.js';
import { REPO_ROOT } from '../src/paths.js';
import type { BattleRequest } from '../src/types.js';

function fixture(name: string): BattleRequest {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests', 'data', 'showdown_requests', name), 'utf8'),
  ) as BattleRequest;
}

class LastEngine extends BaseEngine {
  protected decideJoint(menus: SlotMenu[]): number[] {
    const choices: number[] = [];
    const parts: string[] = [];
    for (const menu of menus) {
      const item = BaseEngine.remaining(menu, parts).at(-1)!;
      choices.push(menu.indexOf(item));
      parts.push(item.part);
    }
    return choices;
  }
}

test('wait and team preview menus compose legal choices', async () => {
  assert.deepEqual(buildMenus({ wait: true }), []);
  const request = fixture('team_preview.json');
  const menus = buildMenus(request);
  assert.equal(menus.length, 4);
  assert.ok(menus.every((menu) => menu.every((item) => item.kind === 'team')));
  assert.equal(await new LastEngine('p1').act(request, { povLines: [] }), 'team 6543');
});

test('forced switches cannot pass while replacements remain', () => {
  const switchItem = { label: 'Switch to Mon5', part: 'switch 5', kind: 'switch' as const };
  const pass = { label: 'Pass', part: 'pass', kind: 'pass' as const };
  const menus = [
    [switchItem, pass],
    [switchItem, pass],
  ];
  assert.throws(() => BaseEngine.parts(menus, [1, 1]), /forced switch/);
  assert.deepEqual(BaseEngine.parts(menus, [0, 1]), ['switch 5', 'pass']);
  assert.deepEqual(BaseEngine.defaults(menus)[1], ['switch 5', 'pass']);
});

test('move targeting follows Showdown target types', () => {
  const request = fixture('turn.json');
  const active = request.active![0]!;
  const moves = active.moves as Array<Record<string, unknown>>;
  moves[0]!.target = 'normal';
  const normal = new Set(
    buildMenus(request)[0]!
      .filter((item) => item.part.startsWith('move 1'))
      .map((item) => item.part),
  );
  assert.ok(normal.has('move 1 +1'));
  assert.ok(normal.has('move 1 +2'));
  assert.ok(normal.has('move 1 -2'));
  moves[0]!.target = 'adjacentFoe';
  const foe = new Set(
    buildMenus(request)[0]!
      .filter((item) => item.part.startsWith('move 1'))
      .map((item) => item.part),
  );
  assert.deepEqual(foe, new Set(['move 1 +1', 'move 1 +2']));
  moves[0]!.target = 'adjacentAllyOrSelf';
  const ally = new Set(
    buildMenus(request)[0]!
      .filter((item) => item.part.startsWith('move 1'))
      .map((item) => item.part),
  );
  assert.ok(ally.has('move 1 -1'));
  assert.ok(ally.has('move 1 -2'));
});

test('target names change labels but not commands', () => {
  const request = fixture('turn.json');
  (request.active![0]!.moves as Array<Record<string, unknown>>)[0]!.target = 'normal';
  const plain = buildMenus(request)[0]!;
  const named = buildMenus(request, {
    foe: { 1: 'Charizard', 2: 'Pelipper' },
    ally: { 1: 'Whimsicott', 2: 'Basculegion' },
  })[0]!;
  assert.deepEqual(
    named.map((item) => item.part),
    plain.map((item) => item.part),
  );
  assert.match(named.find((item) => item.part === 'move 1 +1')!.label, /Charizard/);
  assert.match(named.find((item) => item.part === 'move 1 -2')!.label, /Basculegion/);
});

test('disabled moves offer Struggle and Mega is exclusive', async () => {
  const request = fixture('turn.json');
  for (const active of request.active ?? []) {
    if (!active) continue;
    active.canMegaEvo = true;
  }
  const moves = request.active![0]!.moves as Array<Record<string, unknown>>;
  for (const move of moves) move.disabled = true;
  const first = buildMenus(request)[0]!;
  assert.deepEqual(new Set(first.filter((item) => item.kind === 'move').map((item) => item.part)), new Set(['move 1']));
  assert.ok(first.some((item) => item.kind === 'switch'));

  for (const move of moves) move.disabled = false;
  class MegaEngine extends BaseEngine {
    protected decideJoint(menus: SlotMenu[]): number[] {
      const parts: string[] = [];
      return menus.map((menu) => {
        const remaining = BaseEngine.remaining(menu, parts);
        const item = remaining.find((candidate) => candidate.part.endsWith(' mega')) ?? remaining[0]!;
        parts.push(item.part);
        return menu.indexOf(item);
      });
    }
  }
  const choice = await new MegaEngine('p1').act(request, { povLines: [] });
  assert.equal(choice.match(/ mega/g)?.length, 1);
});
