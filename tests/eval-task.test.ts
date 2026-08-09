import assert from 'node:assert/strict';
import test from 'node:test';
import type { Battle } from 'pokemon-showdown';

import { requestActionCandidateEntries } from '../src/eval/fork.js';
import { POSITION_TASK_PROTOCOL, renderPositionTask, validateTaskScoreJoin } from '../src/eval/task.js';
import { loadPool } from '../src/teams.js';
import type { BattleRequest } from '../src/types.js';

function request(): BattleRequest {
  return {
    active: [
      {
        moves: [
          { move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self', disabled: false },
          { move: 'Thunderbolt', id: 'thunderbolt', pp: 10, maxpp: 10, target: 'normal', disabled: false },
        ],
      },
    ],
    side: {
      pokemon: [
        {
          ident: 'p1: Sparky',
          details: 'Pikachu, L50',
          condition: '100/100',
          active: true,
          stats: { atk: 75, def: 60, spa: 70, spd: 70, spe: 110 },
          moves: ['protect', 'thunderbolt'],
          ability: 'Static',
          item: 'Light Ball',
        },
      ],
    },
  };
}

class AcceptingBattle {
  static fromJSON(): AcceptingBattle {
    return new AcceptingBattle();
  }

  toJSON(): Record<string, never> {
    return {};
  }

  restart(_send: () => void): void {}

  getSide(_pid: string): { activeRequest: BattleRequest; choose(command: string): boolean } {
    return { activeRequest: request(), choose: (command) => command !== 'move 999' };
  }
}

const taskBattle = new AcceptingBattle() as unknown as Battle;

const seen = [
  '|player|p1|Player 1|',
  '|player|p2|Player 2|',
  '|switch|p1a: Sparky|Pikachu, L50|100/100',
  '|switch|p2a: Foe|Pikachu, L50|100/100',
  '|turn|3',
];

test('a canonical task freezes one numbered map of every Showdown-accepted candidate action', () => {
  const format = loadPool().format;
  const task = renderPositionTask({ id: 'task', format, pid: 'p1', battle: taskBattle, request: request(), seen });
  const entries = requestActionCandidateEntries(request());
  assert.deepEqual(
    task.actions.map((entry) => [entry.number, entry.canonicalAction, entry.label]),
    entries.map((entry) => [entry.number, entry.command, entry.label]),
  );
  assert.match(task.prompt, /LEGAL JOINT ACTIONS:/);
  for (const action of task.actions) assert.ok(task.prompt.includes(`${action.number}. ${action.label}`));
  assert.match(task.prompt, /Return exactly one JSON object \{"choice":N\}/);
  assert.equal(task.turn, 3);
  assert.equal(task.phase, 'turn');
  assert.equal(POSITION_TASK_PROTOCOL.action.numberBase, 0);
});

test('task and score resources must join by both number and canonical action', () => {
  const taskActions = [
    { number: 0, canonicalAction: 'move 1', label: 'Protect' },
    { number: 1, canonicalAction: 'move 2 1', label: 'Attack' },
  ];
  assert.throws(() =>
    validateTaskScoreJoin(taskActions, [
      { number: 1, canonicalAction: 'move 2 1', normalizedReward: 1 },
      { number: 0, canonicalAction: 'move 1', normalizedReward: 0 },
    ]),
  );
  assert.throws(() =>
    validateTaskScoreJoin(taskActions, [
      { number: 0, canonicalAction: 'move 1', normalizedReward: 0 },
      { number: 1, canonicalAction: 'move 1', normalizedReward: 1 },
    ]),
  );
  assert.throws(() =>
    validateTaskScoreJoin(taskActions, [
      { number: 0, canonicalAction: 'move 1', normalizedReward: -1 },
      { number: 1, canonicalAction: 'move 2 1', normalizedReward: 1 },
    ]),
  );
});
