import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DraftState } from '../src/draft.js';
import { boardInfo, draftScaffoldRevision, legalPicks, loadBoard, runDraft, snakeOrder } from '../src/draft.js';
import type { DraftLeagueEvent } from '../src/draftleague.js';
import { DRAFT_PROTOCOL_VERSION, runDraftLeague } from '../src/draftleague.js';
import { scaffoldRevision } from '../src/engines.js';
import { seededRng } from '../src/random.js';
import { loadRows } from '../src/records.js';
import { loadShowdown } from '../src/showdown.js';
import type { Completion, Provider } from '../src/types.js';

const BOARD = loadBoard('regmb-202607');

test('draft scaffold identity is distinct and stable', () => {
  assert.match(draftScaffoldRevision(), /^[0-9a-f]{12}$/);
  assert.equal(draftScaffoldRevision(), draftScaffoldRevision());
  assert.notEqual(draftScaffoldRevision(), scaffoldRevision());
});

function freshState(): DraftState {
  return {
    board: BOARD,
    taken: new Map(),
    rosters: [[], []],
    budgets: [BOARD.budget, BOARD.budget],
  };
}

test('the bundled board is coherent and sized for a mini league', () => {
  assert.equal(BOARD.format, 'gen9championsvgc2026regmbbo3');
  assert.ok(BOARD.mons.length >= 30);
  assert.equal(new Set(BOARD.mons.map((mon) => mon.id)).size, BOARD.mons.length);
  const info = boardInfo(BOARD);
  assert.ok(info.maxEntrants >= 4, 'the board must support at least a four-coach league');
  const { Teams } = loadShowdown();
  for (const mon of BOARD.mons) {
    assert.equal((Teams.unpack(mon.packed) ?? []).length, 1, `${mon.id} packs exactly one set`);
  }
});

test('snake order reverses on every round', () => {
  assert.deepEqual(snakeOrder(4, 3), [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
  assert.deepEqual(snakeOrder(2, 2), [0, 1, 1, 0]);
});

test('legal picks enforce exclusivity, item clause, and budget feasibility', () => {
  const state = freshState();
  const whimsicott = BOARD.mons.find((mon) => mon.id === 'whimsicott')!;
  const sashHolders = ['lycanroc-dusk', 'mamoswine', 'gholdengo'];
  state.taken.set(whimsicott.id, 0);
  state.rosters[0] = [whimsicott];
  state.budgets[0] = BOARD.budget - whimsicott.cost;

  const legal = legalPicks(state, 0);
  const legalIds = new Set(legal.map((mon) => mon.id));
  assert.ok(!legalIds.has('whimsicott'), 'a taken mon is gone for everyone');
  for (const id of sashHolders) {
    assert.ok(!legalIds.has(id), `${id} shares Focus Sash with the drafted Whimsicott`);
  }
  assert.ok(legalIds.has('garchomp'));

  const rival = legalPicks(state, 1);
  assert.ok(!rival.some((mon) => mon.id === 'whimsicott'), 'exclusivity applies across rosters');
  assert.ok(
    rival.some((mon) => sashHolders.includes(mon.id)),
    'the rival may still draft a Focus Sash holder',
  );

  state.budgets[0] = 20;
  const constrained = legalPicks(state, 0);
  // Five picks remain, so every choice must leave enough for four available sets.
  assert.ok(constrained.every((mon) => mon.cost <= 20 - 3 * 4));
});

test('budget feasibility follows the remaining board instead of a fixed minimum cost', () => {
  const available = new Set(BOARD.mons.slice(0, 6).map((mon) => mon.id));
  const state: DraftState = {
    board: {
      ...BOARD,
      mons: BOARD.mons.map((mon) => (available.has(mon.id) ? { ...mon, cost: 12 } : mon)),
    },
    taken: new Map(BOARD.mons.filter((mon) => !available.has(mon.id)).map((mon) => [mon.id, 1])),
    rosters: [[], []],
    budgets: [65, BOARD.budget],
  };

  assert.deepEqual(legalPicks(state, 0), []);
});

function scriptedProvider(responses: string[]): Provider {
  let call = 0;
  return {
    complete(): Promise<Completion> {
      const text = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return Promise.resolve({ text, usage: { total_tokens: 10 }, toolCalls: [] });
    },
  };
}

test('llm drafters get retries with feedback and their rationale is logged', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-logs-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let receivedReasoning = '';
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(1),
      reasoningByModel: { 'fake:model': 'high' },
      makeDraftProvider: (_spec, _apiKey, reasoning) => {
        receivedReasoning = reasoning ?? '';
        return scriptedProvider([
          'I will take {"pick": "not-a-mon", "reasoning": "bad id"}',
          '{"pick": "garchomp", "reasoning": "Best stats on the board and Life Orb pressure."}',
          '{"pick": "incineroar", "reasoning": "Fake Out support."}',
          '{"pick": "sinistcha", "reasoning": "Redirection and Matcha Gotcha."}',
          '{"pick": "farigiraf", "reasoning": "Trick Room insurance."}',
        ]);
      },
    },
  );
  assert.equal(receivedReasoning, 'high');
  assert.equal(outcome.rosters[0]!.length, 4);
  assert.equal(outcome.rosters[1]!.length, 4);
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');
  const firstPick = outcome.picks[0]!;
  assert.equal(firstPick.fallback, false);
  assert.match(firstPick.rationale, /Life Orb pressure/);

  const seatLog = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(seatLog[0]!.attempt, 1);
  assert.match(String(seatLog[0]!.error), /not an available board id/);
  assert.ok(seatLog[0]!.system, 'the first attempt records the system prompt');
  assert.equal(seatLog[1]!.attempt, 2);
  assert.match(String(seatLog[1]!.user), /rejected/);

  const transcript = fs
    .readFileSync(path.join(logDir, 'draft.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(transcript.length, 8);
  assert.equal(transcript[0]!.mon, 'garchomp');
  assert.match(String(transcript[0]!.rationale), /Life Orb pressure/);
});

test('a drafter that never answers falls back to a random legal pick', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-fallback-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(2),
      makeDraftProvider: () => scriptedProvider(['no json here at all']),
    },
  );
  const llmPicks = outcome.picks.filter((pick) => pick.entrant === 0);
  assert.ok(llmPicks.every((pick) => pick.fallback));
  assert.match(llmPicks[0]!.rationale, /fallback pick/);
});

test('a full draft league drafts, plays a round robin, and crowns a playoff champion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const events: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(['random', 'random', 'random', 'random'], directory, {
    seed: 21,
    concurrency: 2,
    recordsPath,
    onEvent: (event) => events.push(event),
  });

  assert.equal(rows.length, 9, 'six round-robin series and three playoff series');
  assert.equal(rows.filter((row) => row.stage === 'roundrobin').length, 6);
  assert.equal(rows.filter((row) => row.stage === 'playoff').length, 3);
  for (const row of rows) {
    assert.equal(row.mode, 'draft');
    assert.equal(row.protocol_version, DRAFT_PROTOCOL_VERSION);
    assert.equal(row.board, 'regmb-202607');
    assert.equal(row.pool, undefined);
    assert.equal(row.scaffold, scaffoldRevision());
    assert.equal(row.draft_scaffold, draftScaffoldRevision());
  }

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.mode, 'draft');
  assert.equal(config.scaffold, scaffoldRevision());
  assert.equal(config.draft_scaffold, draftScaffoldRevision());
  const rosters = config.rosters as string[][];
  assert.equal(rosters.length, 4);
  const drafted = rosters.flat();
  assert.equal(drafted.length, 24);
  assert.equal(new Set(drafted).size, 24, 'no mon is drafted twice');

  assert.ok(fs.existsSync(path.join(directory, 'draft', 'draft.jsonl')));
  assert.ok(fs.existsSync(path.join(directory, 'teams.json')));

  const draftEvents = events.filter(
    (event): event is Extract<DraftLeagueEvent, { type: 'draft' }> => event.type === 'draft',
  );
  assert.equal(
    draftEvents.filter((event) => event.draft.phase === 'draft').length,
    25,
    'one initial view plus one per pick',
  );
  const finalDraft = draftEvents[draftEvents.length - 1]!.draft;
  assert.equal(finalDraft.phase, 'done');
  assert.ok(finalDraft.table);
  const brackets = events.filter(
    (event): event is Extract<DraftLeagueEvent, { type: 'bracket' }> => event.type === 'bracket',
  );
  const champion = brackets[brackets.length - 1]!.bracket.champion;
  assert.notEqual(champion, null);

  assert.equal(loadRows(recordsPath).length, 9);
});

test('a two-coach league skips semifinals and plays a single playoff final', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-two-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = await runDraftLeague(['random', 'random'], directory, {
    seed: 4,
    concurrency: 1,
    recordsPath: path.join(directory, 'results.jsonl'),
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.stage),
    ['roundrobin', 'playoff'],
  );
});
