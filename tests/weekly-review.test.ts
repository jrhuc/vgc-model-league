import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MockLanguageModelV4 } from 'ai/test';

import { loadBoard } from '../src/draft.js';
import { readJsonlObjects } from '../src/jsonl.js';
import { defaultPsDir } from '../src/paths.js';
import {
  notebookDigest,
  readWeeklyReviews,
  renderWeeklyReviewPrompt,
  runWeeklyReview,
  type WeeklyReviewState,
} from '../src/weekly-review.js';

const BOARD = loadBoard('regmb-202607');
const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function reply(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function toolCall(toolName: string, input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function scripted(steps: Array<ReturnType<typeof reply> | ReturnType<typeof toolCall>>) {
  const calls: Parameters<MockLanguageModelV4['doGenerate']>[0][] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      const step = steps.shift();
      assert.ok(step, 'the scripted model ran out of replies');
      return step;
    },
  });
  return { model, calls, agentModel: { model, reasoning: undefined, redact: (error: unknown) => error as Error } };
}

function writeRun(): { runDir: string; state: WeeklyReviewState } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-weekly-review-'));
  const seriesDir = path.join(runDir, 'series', 'abc123');
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'game-1.log'),
    [
      '|gametype|doubles',
      '|poke|p1|Garchomp, L50, M|',
      '|poke|p2|Altaria, L50, M|',
      '|start',
      '|switch|p1a: Garchomp|Garchomp, L50, M|100/100',
      '|switch|p2a: Altaria|Altaria, L50, M|100/100',
      '|turn|1',
      '|move|p1a: Garchomp|Earthquake|p2a: Altaria',
      '|win|p1-test:alpha',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(seriesDir, 'p1-decisions.jsonl'),
    `${JSON.stringify({ kind: 'decision', game_number: 1, turn: 1, phase: 'move', action: 'move 1, move 1', rationale: 'Pressure early.' })}\n${JSON.stringify({ kind: 'game_reflection', game_number: 1, result: 'won', summary: 'Earthquake landed.', adjustment: 'Keep it.' })}\n`,
  );
  const rosters = [BOARD.mons.slice(0, 10), BOARD.mons.slice(10, 20)];
  const state: WeeklyReviewState = {
    board: BOARD,
    models: ['test:alpha', 'random'],
    stage: 'week',
    week: 1,
    weeks: 3,
    rosterVersion: 0,
    rosters,
    notebooks: ['Start with Garchomp.', ''],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    series: [
      {
        index: 0,
        week: 1,
        seriesId: 'abc123',
        entrants: [0, 1],
        score: [2, 0],
        winner: 0,
        context: {
          0: 'Round-robin week 1: beat random 2-0. Plan: lead Garchomp.',
          1: 'Round-robin week 1: lost to test:alpha 0-2.',
        },
        builds: {
          0: {
            seriesIndex: 0,
            entrant: 0,
            opponent: 1,
            brought: [rosters[0]![0]!.id],
            sets: [
              {
                species: rosters[0]![0]!.name,
                item: 'Life Orb',
                ability: 'Rough Skin',
                nature: 'Jolly',
                moves: ['Earthquake'],
                evs: { hp: 0, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
                note: '',
                spriteId: rosters[0]![0]!.id,
                repaired: false,
                repairs: [],
              },
            ],
            rationale: 'Lead Garchomp.',
            attempts: 1,
          },
          1: undefined,
        },
      },
    ],
    period: [0],
    schedule: [
      { index: 0, week: 1, entrants: [0, 1] },
      { index: 1, week: 2, entrants: [1, 0] },
    ],
    transactions: [],
    nextWindowWeek: 1,
  };
  return { runDir, state };
}

test('the weekly review prompt states the barrier, the period, the schedule, and the window ahead', () => {
  const { runDir, state } = writeRun();
  try {
    const prompt = renderWeeklyReviewPrompt(state, 0);
    assert.match(prompt, /week 1 of 3 is complete/);
    assert.match(prompt, /A transaction window opens as soon as this review closes/);
    assert.match(prompt, /YOUR SERIES THIS PERIOD:\n- Series 0, week 1: Round-robin week 1: beat random 2-0/);
    assert.match(prompt, /YOUR REMAINING SCHEDULE[^\n]*\n- Week 2 \| random \|/);
    assert.match(prompt, /YOUR CURRENT NOTEBOOK:\nStart with Garchomp\./);
    assert.match(renderWeeklyReviewPrompt({ ...state, nextWindowWeek: null }, 0), /Rosters are now locked/);
    assert.match(
      renderWeeklyReviewPrompt({ ...state, nextWindowWeek: 3 }, 0),
      /next transaction window opens after week 3/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('a reconciliation reviews only the changed seats against both rosters', async (t) => {
  const { runDir, state } = writeRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const previousRosters = state.rosters.map((roster) => [...roster]);
  const swapped = BOARD.mons[20]!;
  state.rosters[0] = [...state.rosters[0]!.slice(1), swapped];
  const reconcile: WeeklyReviewState = {
    ...state,
    stage: 'transactions',
    rosterVersion: 1,
    previousRosters,
    seats: [0],
    nextWindowWeek: 2,
  };
  const prompt = renderWeeklyReviewPrompt(reconcile, 0);
  assert.match(prompt, /window after round-robin week 1 of 3 has closed and your roster changed/);
  assert.match(prompt, new RegExp(`YOUR ROSTER BEFORE THE WINDOW: ${previousRosters[0]![0]!.name}`));
  assert.match(prompt, new RegExp(`YOUR ROSTER NOW: .*${swapped.name}`));
  assert.doesNotMatch(prompt, /YOUR SERIES THIS PERIOD/);
  assert.match(prompt, /next transaction window opens after week 2/);
  const script = scripted([reply('{"notebook":"Rebuilt around the new six."}')]);
  const reviews = await runWeeklyReview(reconcile, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewModel: () => script.agentModel,
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.stage, 'transactions');
  assert.equal(reviews[0]!.roster_version, 1);
  assert.ok(fs.existsSync(path.join(runDir, 'reviews', 'week-1-transactions.jsonl')));
  assert.deepEqual(readWeeklyReviews(runDir, 1), [], 'the week review file is untouched');
  assert.equal(state.notebooks[0], 'Rebuilt around the new six.');
});

test('a coach reads a series through its tools, replaces its notebook, and the row replays without a model', async (t) => {
  const { runDir, state } = writeRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const script = scripted([
    toolCall('read_public_series', { series_index: 0 }),
    toolCall('read_own_series', { series_index: 0 }),
    reply('{"notebook":"Garchomp leads work; keep it.","reasoning":"Won cleanly."}'),
  ]);
  const reviews = await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewModel: () => script.agentModel,
  });
  assert.equal(script.calls.length, 3, 'two tool steps then the answer');
  assert.equal(reviews.length, 2);
  const alpha = reviews.find((review) => review.entrant === 0)!;
  assert.equal(alpha.notebook, 'Garchomp leads work; keep it.');
  assert.equal(alpha.reasoning, 'Won cleanly.');
  assert.deepEqual(alpha.evidence_supplied, { rationale: true, notebookUpdate: true });
  assert.equal(alpha.previous_digest, notebookDigest('Start with Garchomp.'));
  assert.equal(alpha.digest, notebookDigest(alpha.notebook));
  assert.equal(alpha.fallback, false);
  const random = reviews.find((review) => review.entrant === 1)!;
  assert.equal(random.notebook, '');
  assert.equal(random.fallback, false, 'a random seat files no review and is not a fallback');
  assert.deepEqual(state.notebooks, ['Garchomp leads work; keep it.', '']);

  const seatLog = readJsonlObjects(path.join(runDir, 'reviews', 'week-1', 'seat-0-test-alpha.jsonl'));
  assert.equal(seatLog.length, 1);
  const lookups = seatLog[0]!.tool_lookups as Array<{ name: string; result: string }>;
  assert.deepEqual(
    lookups.map((lookup) => lookup.name),
    ['read_public_series', 'read_own_series'],
  );
  assert.match(lookups[0]!.result, /test:alpha beat random 2-0/);
  assert.match(lookups[0]!.result, /registers Garchomp/);
  assert.match(lookups[0]!.result, /T1 Garchomp used Earthquake/);
  assert.match(lookups[1]!.result, /T1: move 1, move 1 — Pressure early\./);
  assert.match(lookups[1]!.result, /After the game \(won\): Earthquake landed\. Adjustment: Keep it\./);
  assert.deepEqual(seatLog[0]!.usage, { input_tokens: 30, output_tokens: 15 });

  const replayed = await runWeeklyReview(
    { ...state, notebooks: ['Start with Garchomp.', ''] },
    { runDir, psDir: defaultPsDir(), makeReviewModel: () => scripted([]).agentModel },
  );
  assert.deepEqual(replayed, reviews, 'a completed review replays from its rows');
});

test('a rejected reply is re-prompted with the reason and the attempt is logged', async (t) => {
  const { runDir, state } = writeRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const script = scripted([reply('I would keep my plan.'), reply('{"notebook":"Keep the plan."}')]);
  await runWeeklyReview(state, { runDir, psDir: defaultPsDir(), makeReviewModel: () => script.agentModel });
  assert.equal(script.calls.length, 2);
  const second = script.calls[1]!.prompt.at(-1)!;
  assert.equal(second.role, 'user');
  assert.match(JSON.stringify(second.content), /That review was rejected: the reply contained no JSON object/);
  const seatLog = readJsonlObjects(path.join(runDir, 'reviews', 'week-1', 'seat-0-test-alpha.jsonl'));
  assert.equal(seatLog.length, 2);
  assert.equal(seatLog[0]!.error, 'the reply contained no JSON object');
  assert.equal(seatLog[1]!.error, undefined);
  assert.equal(state.notebooks[0], 'Keep the plan.');
});

test('a stored review must continue the notebook the league holds', async (t) => {
  const { runDir, state } = writeRun();
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  await runWeeklyReview(state, {
    runDir,
    psDir: defaultPsDir(),
    makeReviewModel: () => scripted([reply('{"notebook":"Next."}')]).agentModel,
  });
  await assert.rejects(
    runWeeklyReview(
      { ...state, notebooks: ['A different notebook.', ''] },
      { runDir, psDir: defaultPsDir(), makeReviewModel: () => scripted([]).agentModel },
    ),
    /does not continue the current notebook/,
  );
});
