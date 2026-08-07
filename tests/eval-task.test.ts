import assert from 'node:assert/strict';
import test from 'node:test';

import { legalActionEntries } from '../src/eval/fork.js';
import {
  POSITION_TASK_PROTOCOL,
  parsePositionResponse,
  renderPositionTask,
  scorePositionResponse,
  validateTaskScoreJoin,
} from '../src/eval/task.js';
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

const seen = [
  '|player|p1|Player 1|',
  '|player|p2|Player 2|',
  '|switch|p1a: Sparky|Pikachu, L50|100/100',
  '|switch|p2a: Foe|Pikachu, L50|100/100',
  '|turn|3',
];

test('a canonical task freezes one numbered map of every legal joint action', () => {
  const format = loadPool().format;
  const task = renderPositionTask({ id: 'task', format, pid: 'p1', request: request(), seen });
  const entries = legalActionEntries(request());
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

test('the static response parser accepts only the exact scored action object', () => {
  const actions = [
    { number: 0, canonicalAction: 'move 1', label: 'Protect' },
    { number: 1, canonicalAction: 'move 2 1', label: 'Thunderbolt into foe 1' },
  ];
  assert.equal(parsePositionResponse('{"choice":1}', actions).canonicalAction, 'move 2 1');
  for (const response of [
    'choose 1',
    '{"choice":1} trailing',
    '{"choice":1,"rationale":"x"}',
    '{"choice":true}',
    '{"choice":1.5}',
    '{"choice":"1"}',
    '{"choice":2}',
  ]) {
    assert.throws(() => parsePositionResponse(response, actions));
  }
});

test('invalid output is separate from the worst legal normalized reward', () => {
  const actions = [
    { number: 0, canonicalAction: 'move 1', label: 'Protect' },
    { number: 1, canonicalAction: 'move 2 1', label: 'Thunderbolt into foe 1' },
  ];
  const rewards = new Map([
    ['move 1', 0],
    ['move 2 1', 1],
  ]);
  assert.deepEqual(scorePositionResponse('{"choice":0}', actions, rewards), {
    reward: 0,
    validOutput: true,
    choice: 0,
    canonicalAction: 'move 1',
    error: null,
  });
  const invalid = scorePositionResponse('{"choice":9}', actions, rewards);
  assert.equal(invalid.reward, -1);
  assert.equal(invalid.validOutput, false);
  assert.equal(invalid.choice, null);
});

test('task and score resources must join by both number and canonical action', () => {
  const taskActions = [
    { number: 0, canonicalAction: 'move 1', label: 'Protect' },
    { number: 1, canonicalAction: 'move 2 1', label: 'Attack' },
  ];
  validateTaskScoreJoin(taskActions, [
    { number: 1, canonicalAction: 'move 2 1', normalizedReward: 1 },
    { number: 0, canonicalAction: 'move 1', normalizedReward: 0 },
  ]);
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
