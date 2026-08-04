import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBoardSearch } from '../src/board-search.js';
import type { DraftBoardMon, DraftState } from '../src/draft.js';
import {
  boardInfo,
  draftBoardTable,
  draftScaffoldRevision,
  draftUserPrompt,
  legalPicks,
  loadBoard,
  maxAffordable,
  parsePick,
  runDraft,
  snakeOrder,
} from '../src/draft.js';
import type { DraftLeagueEvent } from '../src/draftleague.js';
import { DRAFT_PROTOCOL_VERSION, roundRobinWeeks, runDraftLeague } from '../src/draftleague.js';
import { scaffoldRevision } from '../src/llm-engine.js';
import { defaultPsDir } from '../src/paths.js';
import { ApiError } from '../src/providers.js';
import { seededRng } from '../src/random.js';
import { loadRows } from '../src/records.js';
import { RecoveryGate } from '../src/recovery.js';
import { parseSeasonReview, readSeasonReviews, runSeasonReview, type SeasonReviewState } from '../src/season-review.js';
import { loadShowdown } from '../src/showdown.js';
import { runTeambuild, teambuildScaffoldRevision } from '../src/teambuild.js';
import {
  applyTradeDecision,
  parseTradeDecision,
  runTradeWindow,
  type TradeWindowState,
  tradeWindowScaffoldRevision,
} from '../src/trade-window.js';
import type { Completion, Provider, ProviderMessage } from '../src/types.js';

const BOARD = loadBoard('regmb-202607');
const mon = (id: string): DraftBoardMon => {
  const found = BOARD.mons.find((candidate) => candidate.id === id);
  assert.ok(found, `board is missing ${id}`);
  return found;
};

function freshState(overrides: Partial<DraftState> = {}): DraftState {
  return {
    board: BOARD,
    taken: new Map(),
    rosters: [[], []],
    budgets: [BOARD.budget, BOARD.budget],
    teamNames: ['', ''],
    ...overrides,
  };
}

test('scaffold identities are distinct and stable', () => {
  for (const revision of [draftScaffoldRevision(), teambuildScaffoldRevision(), tradeWindowScaffoldRevision()]) {
    assert.match(revision, /^[0-9a-f]{12}$/);
  }
  assert.equal(draftScaffoldRevision(), draftScaffoldRevision());
  assert.notEqual(draftScaffoldRevision(), scaffoldRevision());
  assert.notEqual(draftScaffoldRevision(), teambuildScaffoldRevision());
  assert.notEqual(tradeWindowScaffoldRevision(), draftScaffoldRevision());
});

test('the bundled board fits eight coaches', () => {
  assert.equal(BOARD.format, 'gen9championsvgc2026regmbbo3');
  assert.equal(BOARD.budget, 100);
  assert.equal(BOARD.picks, 10);
  assert.equal(new Set(BOARD.mons.map((entry) => entry.id)).size, BOARD.mons.length);
  const info = boardInfo(BOARD);
  assert.ok(info.maxEntrants >= 8, `board must seat eight coaches, seats ${info.maxEntrants}`);
  assert.ok(
    new Set(BOARD.mons.map((entry) => entry.base)).size >= 8 * BOARD.picks,
    'exclusivity needs one distinct species per pick across the field',
  );
});

test('mega entries register the base forme and lock their stone', () => {
  const { Dex } = loadShowdown();
  const dex = Dex.mod('champions');
  const megas = BOARD.mons.filter((entry) => entry.item);
  assert.ok(megas.length > 60, 'the board should carry the Champions mega roster');
  for (const entry of megas) {
    const registered = dex.species.get(entry.species);
    assert.ok(registered.exists && !registered.name.includes('-Mega'), `${entry.id} registers a base forme`);
    const stone = dex.items.get(entry.item!);
    assert.ok(stone.exists, `${entry.id} names a real stone`);
    const megaStone = stone.megaStone;
    const target = typeof megaStone === 'string' ? megaStone : megaStone?.[registered.name];
    assert.equal(target, entry.forme, `${entry.id} stone must produce its forme`);
  }
  const zard = mon('charizard-mega-y');
  assert.equal(zard.species, 'Charizard');
  assert.equal(zard.item, 'Charizardite Y');
  assert.equal(mon('charizard').item, undefined, 'the base entry may never hold a stone');
  assert.equal(mon('charizard').base, zard.base, 'base and mega share a species-clause key');
});

test('re-priced entries keep the prior listing and the usage that moved it', () => {
  const adjusted = BOARD.mons.filter((entry) => entry.usage);
  assert.ok(adjusted.length > 40, 'the usage pass should have moved a meaningful share of the board');
  for (const entry of adjusted) {
    assert.ok(typeof entry.listed === 'number' && entry.listed !== entry.cost);
    assert.match(entry.usage!, /^#\d+ at [\d.]+%$/);
  }
  assert.equal(mon('farigiraf').cost, 18, 'a Reg M-B staple should not stay at its Reg M-A price');
  assert.equal(mon('toxapex').listed, 3, 'Toxapex was exploitably cheap on the prior board');
  assert.ok(mon('toxapex').cost > 3);
});

test('a board id must match its filename', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-board-id-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'foo.json'), JSON.stringify({ ...BOARD, id: 'bar' }));
  assert.throws(() => loadBoard('foo', directory), /id must match its filename/);
});

test('a board entry naming an unknown species is rejected', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-board-species-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mons = BOARD.mons.map((entry, index) => (index === 0 ? { ...entry, species: 'Missingno' } : entry));
  fs.writeFileSync(path.join(directory, 'bad.json'), JSON.stringify({ ...BOARD, id: 'bad', mons }));
  assert.throws(() => loadBoard('bad', directory), /not a legal species/);
});

test('a board rejects inconsistent battle metadata and an unaffordable budget', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-board-invariants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (id: string, mons: DraftBoardMon[], budget = BOARD.budget) => {
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ ...BOARD, id, budget, mons }));
  };

  write(
    'bad-base',
    BOARD.mons.map((entry, index) => (index ? entry : { ...entry, base: 'Missing' })),
  );
  assert.throws(() => loadBoard('bad-base', directory), /wrong base species/);

  const mega = BOARD.mons.findIndex((entry) => entry.item);
  write(
    'bad-mega',
    BOARD.mons.map((entry, index) => (index === mega ? { ...entry, item: 'Leftovers' } : entry)),
  );
  assert.throws(() => loadBoard('bad-mega', directory), /invalid Mega forme or stone/);

  write('bad-budget', BOARD.mons, 1);
  assert.throws(() => loadBoard('bad-budget', directory), /budget that can afford/);
});

test('snake order reverses on every round', () => {
  assert.deepEqual(snakeOrder(4, 3), [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3]);
  assert.deepEqual(snakeOrder(2, 2), [0, 1, 1, 0]);
});

test('the round robin pairs every coach once and plays one match a week', () => {
  for (const size of [2, 4, 7, 8]) {
    const weeks = roundRobinWeeks(size);
    assert.equal(weeks.length, size % 2 ? size : size - 1, `${size} coaches`);
    const seen = new Set<string>();
    for (const week of weeks) {
      const playing = new Set<number>();
      for (const [home, away] of week) {
        assert.ok(!playing.has(home) && !playing.has(away), `${size}: a coach plays twice in one week`);
        playing.add(home);
        playing.add(away);
        const key = [home, away].sort((a, b) => a - b).join('-');
        assert.ok(!seen.has(key), `${size}: ${key} is scheduled twice`);
        seen.add(key);
      }
    }
    assert.equal(seen.size, (size * (size - 1)) / 2, `${size}: every pair meets exactly once`);
  }
});

test('trade-window swaps are atomic and may upgrade a base entry to its Mega', () => {
  const tyranitar = mon('tyranitar');
  const megaTyranitar = mon('tyranitar-mega');
  const mrRime = mon('mr-rime');
  const absol = mon('absol');
  const excluded = new Set([tyranitar.base, mrRime.base, absol.base]);
  const support: DraftBoardMon[] = [];
  for (const candidate of [...BOARD.mons].sort((a, b) => a.cost - b.cost)) {
    if (excluded.has(candidate.base)) continue;
    excluded.add(candidate.base);
    support.push(candidate);
    if (support.length === 8) break;
  }
  const roster = [tyranitar, mrRime, ...support];
  const spent = roster.reduce((sum, entry) => sum + entry.cost, 0);
  const state: TradeWindowState = {
    board: { ...BOARD, budget: spent },
    models: ['openrouter:opus', 'random'],
    teamNames: ['Opus', 'Rival'],
    rosters: [roster, []],
    budgets: [0, spent],
    notebooks: ['Tyranitar is the endgame.', ''],
    standings: [
      { entrant: 1, w: 2, l: 0, gw: 4, gl: 1 },
      { entrant: 0, w: 0, l: 2, gw: 1, gl: 4 },
    ],
    results: [[], []],
    reflections: [[], []],
  };

  const overBudget = parseTradeDecision(
    JSON.stringify({
      swaps: [{ drop: tyranitar.id, add: megaTyranitar.id }],
      reasoning: 'Upgrade Tyranitar.',
      notebook: 'Mega Tyranitar is the endgame.',
    }),
    state,
    0,
  );
  assert.match(String(overBudget), /above the .* budget/);
  assert.ok(state.rosters[0]!.includes(tyranitar), 'a rejected list mutates nothing');

  const parsed = parseTradeDecision(
    JSON.stringify({
      swaps: [
        { drop: tyranitar.id, add: megaTyranitar.id },
        { drop: mrRime.id, add: absol.id },
      ],
      reasoning: 'Trade depth for the Mega upgrade.',
      notebook: 'Mega Tyranitar is now the endgame.',
    }),
    state,
    0,
  );
  assert.notEqual(typeof parsed, 'string', String(parsed));
  if (typeof parsed === 'string') return;
  applyTradeDecision(state, 0, parsed);
  assert.equal(state.rosters[0]!.length, BOARD.picks);
  assert.equal(state.budgets[0], 0);
  assert.ok(state.rosters[0]!.some((entry) => entry.id === megaTyranitar.id));
  assert.ok(state.rosters[0]!.some((entry) => entry.id === absol.id));
  assert.ok(!state.rosters[0]!.some((entry) => entry.id === tyranitar.id || entry.id === mrRime.id));
});

test('the trade window runs lowest seed first and replays completed seats', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-trade-window-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cheap: DraftBoardMon[] = [];
  const bases = new Set<string>();
  for (const candidate of BOARD.mons) {
    if (candidate.cost !== 1 || bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    cheap.push(candidate);
    if (cheap.length === 31) break;
  }
  assert.equal(cheap.length, 31);
  const initial = [cheap.slice(0, 10), cheap.slice(10, 20), cheap.slice(20, 30)];
  const freeAgent = cheap[30]!;
  const models = ['test:best', 'test:middle', 'test:worst'];
  const responses = new Map([
    [
      models[2]!,
      {
        swaps: [{ drop: initial[2]![0]!.id, add: freeAgent.id }],
        reasoning: 'Use the first claim.',
        notebook: 'Updated worst-seed plan.',
      },
    ],
    [
      models[1]!,
      {
        swaps: [{ drop: initial[1]![0]!.id, add: initial[2]![0]!.id }],
        reasoning: 'Claim the newly released option.',
        notebook: 'Updated middle-seed plan.',
      },
    ],
    [models[0]!, { swaps: [], reasoning: 'The roster is sound.', notebook: 'Keep the best-seed plan.' }],
  ]);
  const createState = (): TradeWindowState => ({
    board: BOARD,
    models,
    teamNames: ['Best', 'Middle', 'Worst'],
    rosters: initial.map((roster) => [...roster]),
    budgets: [90, 90, 90],
    notebooks: ['best plan', 'middle plan', 'worst plan'],
    standings: [
      { entrant: 0, w: 2, l: 0, gw: 4, gl: 0 },
      { entrant: 1, w: 1, l: 1, gw: 2, gl: 2 },
      { entrant: 2, w: 0, l: 2, gw: 0, gl: 4 },
    ],
    results: [[], [], []],
    reflections: [[], [], []],
  });
  const calls: string[] = [];
  const systems = new Map<string, string>();
  const firstState = createState();
  const artifact = await runTradeWindow(firstState, {
    runDir: directory,
    psDir: defaultPsDir(),
    afterWeek: 2,
    makeTradeProvider: (spec) => ({
      complete(system: string): Promise<Completion> {
        calls.push(spec);
        systems.set(spec, system);
        return Promise.resolve({ text: JSON.stringify(responses.get(spec)), usage: {}, toolCalls: [] });
      },
    }),
  });
  assert.deepEqual(artifact.order, [2, 1, 0]);
  assert.match(
    systems.get(models[2]!) ?? '',
    /coaching Worst /,
    'a coach is named its own team, so it can find its row in the standings',
  );
  assert.deepEqual(calls, [models[2], models[1], models[0]]);
  assert.equal(firstState.rosters[1]![9]?.id, initial[2]![0]!.id, 'an earlier drop becomes available immediately');
  assert.ok(fs.existsSync(path.join(directory, 'window.json')));
  assert.equal(loadRows(path.join(directory, 'window.jsonl')).length, 3);

  let replayCalls = 0;
  const replayed = await runTradeWindow(createState(), {
    runDir: directory,
    psDir: defaultPsDir(),
    afterWeek: 2,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        replayCalls += 1;
        throw new Error('replayed decisions must not call a provider');
      },
    }),
  });
  assert.equal(replayCalls, 0);
  assert.deepEqual(replayed.decisions, artifact.decisions);
});

test('legal picks enforce exclusivity and one entry per base species', () => {
  const state = freshState();
  const zardY = mon('charizard-mega-y');
  state.taken.set(zardY.id, 0);
  state.rosters[0] = [zardY];
  state.budgets[0] = BOARD.budget - zardY.cost;

  const legalIds = new Set(legalPicks(state, 0).map((entry) => entry.id));
  assert.ok(!legalIds.has('charizard-mega-y'), 'a taken entry is gone');
  assert.ok(!legalIds.has('charizard'), 'the base forme shares a species with the drafted mega');
  assert.ok(!legalIds.has('charizard-mega-x'), 'the other mega shares that species too');
  assert.ok(legalIds.has('garchomp'));

  const rival = legalPicks(state, 1).map((entry) => entry.id);
  assert.ok(!rival.includes('charizard-mega-y'), 'exclusivity applies across rosters');
  assert.ok(rival.includes('charizard'), 'but a rival may still take the base forme');
});

test('a pick must leave enough budget to finish the roster', () => {
  const state = freshState();
  state.budgets[0] = 25;
  const legal = legalPicks(state, 0);
  const cheapestNine = [...new Set(BOARD.mons.map((entry) => entry.base))]
    .map((base) => Math.min(...BOARD.mons.filter((entry) => entry.base === base).map((entry) => entry.cost)))
    .sort((a, b) => a - b)
    .slice(0, BOARD.picks - 1)
    .reduce((sum, cost) => sum + cost, 0);
  assert.ok(legal.length > 0);
  for (const entry of legal) assert.ok(entry.cost <= 25 - cheapestNine, `${entry.id} leaves the roster unfinishable`);
  assert.equal(maxAffordable(legal), Math.max(...legal.map((entry) => entry.cost)));
});

test('the last pick may spend everything that is left', () => {
  const state = freshState();
  const roster = BOARD.mons.filter((entry) => entry.cost === 1).slice(0, BOARD.picks - 1);
  state.rosters[0] = roster;
  for (const entry of roster) state.taken.set(entry.id, 0);
  state.budgets[0] = 20;
  const legal = legalPicks(state, 0);
  assert.ok(
    legal.some((entry) => entry.cost === 20),
    'with one slot left the whole remaining budget is spendable',
  );
  assert.ok(legal.every((entry) => entry.cost <= 20));
});

function scriptedProvider(responses: string[], onComplete?: (messages: ProviderMessage[]) => void): Provider {
  let call = 0;
  return {
    complete(_system, messages): Promise<Completion> {
      onComplete?.(messages);
      const text = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return Promise.resolve({ text, usage: { total_tokens: 10 }, toolCalls: [] });
    },
  };
}

test('drafters get retries with feedback, and name their franchise on the first pick', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-logs-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let receivedReasoning = '';
  const prompts: string[] = [];
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(1),
      reasoningByModel: { 'fake:model': 'high' },
      makeDraftProvider: (_spec, _apiKey, reasoning) => {
        receivedReasoning = reasoning ?? '';
        return scriptedProvider(
          [
            'I will take {"pick": "not-a-mon", "team_name": "Nowhere Nidokings", "reasoning": "bad id", "notebook": "bad"}',
            '{"pick": "garchomp", "team_name": "Route 210 Garchomps", "reasoning": "Best ground type available.", "notebook": "Build around Garchomp; add Fake Out and speed control."}',
            '{"pick": "incineroar", "reasoning": "Fake Out support.", "notebook": "Garchomp plus Incineroar; add speed control and redirection."}',
            '{"pick": "sinistcha", "reasoning": "Redirection.", "notebook": "Ground offense with pivoting and redirection; add speed control."}',
            '{"pick": "farigiraf", "reasoning": "Trick Room insurance.", "notebook": "Complete flexible Ground offense with priority denial and Trick Room."}',
          ],
          (messages) => prompts.push(String(messages.at(-1)?.content ?? '')),
        );
      },
    },
  );

  assert.equal(receivedReasoning, 'high');
  assert.equal(outcome.teamNames[0], 'Route 210 Garchomps');
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');
  assert.equal(outcome.picks[0]!.fallback, false);
  assert.match(outcome.picks[0]!.rationale, /Best ground type/);
  assert.ok(
    prompts.some((prompt) => prompt.includes('Build around Garchomp; add Fake Out and speed control.')),
    'the accepted private draft note reaches the next pick',
  );

  const rows = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.match(String(rows[0]!.error), /is not a board id/);
  assert.ok(String(rows[0]!.system).includes('DRAFT BOARD'), 'the board rides in the cacheable system prompt');

  const transcript = fs
    .readFileSync(path.join(logDir, 'draft.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(transcript[0]!.team_name, 'Route 210 Garchomps');
  assert.equal(transcript[0]!.rationale, 'Best ground type available.');
});

test('a rejected pick is told which rule it broke', () => {
  const state = freshState();
  const zardY = mon('charizard-mega-y');
  state.teamNames[1] = 'Rival Rotoms';
  state.taken.set(zardY.id, 1);
  state.rosters[1] = [zardY];
  const garchomp = mon('garchomp');
  state.taken.set(garchomp.id, 0);
  state.rosters[0] = [garchomp];
  state.budgets[0] = BOARD.budget - garchomp.cost;

  const reasons = ['nonsense-id', 'charizard-mega-y', 'garchomp-mega', 'basculegion'].map((id) => {
    const legal = legalPicks(state, 0);
    const parsed = parsePick(JSON.stringify({ pick: id, reasoning: 'x', notebook: 'plan' }), legal, state, 0);
    return typeof parsed === 'string' ? parsed : 'accepted';
  });

  assert.match(reasons[0]!, /is not a board id/);
  assert.match(reasons[1]!, /already drafted by Rival Rotoms/);
  assert.match(reasons[2]!, /shares the species Garchomp with your Garchomp/);
  assert.equal(reasons[3], 'accepted', 'an affordable, untaken, unclashing pick is fine');

  state.budgets[0] = 12;
  const tight = legalPicks(state, 0);
  const denied = parsePick(JSON.stringify({ pick: 'basculegion', reasoning: 'x', notebook: 'plan' }), tight, state, 0);
  assert.match(String(denied), /costs 19, but you can spend at most \d+ points?/);
});

test('the first pick requires a franchise name', () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  assert.match(String(parsePick('{"pick":"garchomp"}', legal, state, 0)), /team_name/);
  assert.notEqual(
    typeof parsePick(
      '{"pick":"garchomp","team_name":"Route 210 Garchomps","notebook":"Build around Garchomp"}',
      legal,
      state,
      0,
    ),
    'string',
  );
});

test('a pick may be written as the board id or the name shown beside it', () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  for (const spelling of ['lucario-mega', 'Mega Lucario', 'mega-lucario', 'MEGA LUCARIO']) {
    const parsed = parsePick(
      JSON.stringify({ pick: spelling, team_name: 'Mega Evolutions', reasoning: 'x', notebook: 'plan' }),
      legal,
      state,
      0,
    );
    assert.notEqual(typeof parsed, 'string', `${spelling} should resolve`);
    assert.equal(typeof parsed === 'string' ? '' : parsed.mon.id, 'lucario-mega');
  }
});

test('drafters can look up the dex before committing a pick', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-tools-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let offered: string[] = [];
  let toolResult = '';
  let call = 0;
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(7),
      makeDraftProvider: () => ({
        complete(_system, messages, options): Promise<Completion> {
          call += 1;
          offered = (options?.tools ?? []).map((tool) => tool.name);
          if (call === 1) {
            return Promise.resolve({
              text: '',
              usage: { total_tokens: 5 },
              toolCalls: [
                { id: 'c1', name: 'lookup_species', arguments: { name: 'Blastoise', item: 'Blastoisinite' } },
              ],
            });
          }
          if (call === 2) toolResult = String(messages[messages.length - 1]?.content ?? '');
          const picks = ['garchomp', 'incineroar', 'sinistcha', 'farigiraf'];
          return Promise.resolve({
            text: `{"pick": "${picks[Math.min(call - 2, picks.length - 1)]}", "team_name": "Calc Chompers", "reasoning": "Checked the Mega first.", "notebook": "Keep checking exact mechanics."}`,
            usage: { total_tokens: 9 },
            toolCalls: [],
          });
        },
      }),
    },
  );

  assert.ok(offered.includes('lookup_species'), 'the dex tools are offered while drafting');
  assert.ok(offered.includes('estimate_damage'), 'including the damage calculator, for counter-picking');
  assert.match(toolResult, /Blastoise-Mega/, 'the lookup is resolved against the simulator and fed back');
  assert.equal(outcome.picks[0]!.fallback, false);
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');

  const rows = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const lookups = rows[0]!.tool_lookups as Array<Record<string, unknown>>;
  assert.equal(lookups.length, 1, 'lookups are logged for the audit trail');
  assert.equal(lookups[0]!.name, 'lookup_species');
  assert.match(String(lookups[0]!.result), /Blastoise-Mega/, 'the result content is preserved for audits');
});

test('teambuilders can look up the dex while writing sets', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-tools-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let offered: string[] = [];
  let toolResult = '';
  let call = 0;
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(7),
    makeTeambuildProvider: () => ({
      complete(_system, messages, options): Promise<Completion> {
        call += 1;
        offered = (options?.tools ?? []).map((tool) => tool.name);
        if (call === 1) {
          return Promise.resolve({
            text: '',
            usage: { total_tokens: 5 },
            toolCalls: [
              {
                id: 'c1',
                name: 'estimate_damage',
                arguments: { attacker: 'Garchomp', defender: 'Incineroar', move: 'Earthquake' },
              },
            ],
          });
        }
        toolResult = String(messages[messages.length - 1]?.content ?? '');
        return Promise.resolve({ text: GOOD_TEAM, usage: { total_tokens: 9 }, toolCalls: [] });
      },
    }),
  });

  assert.ok(offered.includes('estimate_damage'), 'the calculator is offered while building spreads');
  assert.match(toolResult, /Earthquake/, 'the calc is resolved and fed back');
  assert.equal(view.attempts, 1, 'a tool round is not a failed attempt');
});

test('a pick cut off by its token budget is told so, not blamed for formatting', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-truncated-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const long = 'y'.repeat(4_000);
  let secondPrompt = '';
  let call = 0;
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(8),
      makeDraftProvider: () => ({
        complete(_system, messages, options): Promise<Completion> {
          call += 1;
          if (call === 1) {
            return Promise.resolve({
              text: `Weighing the board ${long}`,
              usage: { output_tokens: options?.maxTokens ?? 0 },
              toolCalls: [],
            });
          }
          if (call === 2) secondPrompt = messages.map((message) => String(message.content ?? '')).join('\n');
          const picks = ['garchomp', 'incineroar', 'sinistcha', 'farigiraf'];
          return Promise.resolve({
            text: `{"pick": "${picks[Math.min(call - 2, picks.length - 1)]}", "team_name": "Budget Chompers", "reasoning": "Kept it short.", "notebook": "Build balanced offense."}`,
            usage: { output_tokens: 40 },
            toolCalls: [],
          });
        },
      }),
    },
  );

  assert.ok(!secondPrompt.includes(long), 'the overrun reasoning must not be replayed into the retry');
  assert.match(secondPrompt, /used the whole 32768-token budget before naming a pick/);
  assert.equal(outcome.picks[0]!.fallback, false, 'the model still gets to make its own pick');

  const rows = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.match(String(rows[0]!.error), /whole token budget before naming a pick/);
});

test('a teambuild cut off by its token budget is told so', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-truncated-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const long = 'z'.repeat(4_000);
  let secondPrompt = '';
  let call = 0;
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(8),
    makeTeambuildProvider: () => ({
      complete(_system, messages, options): Promise<Completion> {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            text: `Considering the matchup ${long}`,
            usage: { output_tokens: options?.maxTokens ?? 0 },
            toolCalls: [],
          });
        }
        secondPrompt = messages.map((message) => String(message.content ?? '')).join('\n');
        return Promise.resolve({ text: GOOD_TEAM, usage: { output_tokens: 60 }, toolCalls: [] });
      },
    }),
  });

  assert.ok(!secondPrompt.includes(long), 'the overrun reasoning must not be replayed into the retry');
  assert.match(secondPrompt, /used the whole 65536-token budget before finishing the team/);
  assert.equal(view.attempts, 2);
  assert.ok(
    view.sets.every((set) => !set.repaired),
    'the model still writes its own team once it fits inside the budget',
  );
});

test('a drafter that never answers falls back to a random legal pick', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-fallback-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(3),
      makeDraftProvider: () => scriptedProvider(['no json here']),
    },
  );
  assert.equal(outcome.picks[0]!.fallback, true);
  assert.match(outcome.picks[0]!.rationale, /random legal pick after 3 rejected replies/);
  assert.match(outcome.notebooks[0]!, /Harness note: every reply for pick 1 was rejected/);
  const seatLog = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { pick: number; attempt: number; user: string });
  const laterFirstAttempt = seatLog.find((row) => row.pick > 1 && row.attempt === 1);
  assert.match(
    laterFirstAttempt!.user,
    /Harness note: every reply for pick 1 was rejected/,
    'the fallback note reaches the next pick through the notebook',
  );
});

test('a credential failure stops the draft instead of making random picks', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-terminal-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  await assert.rejects(
    runDraft(
      ['google:gemini-test', 'random'],
      { ...BOARD, picks: 4 },
      {
        logDir,
        rng: seededRng(2),
        makeDraftProvider: () => ({
          complete: () => Promise.reject(new ApiError(401, 'invalid api key')),
        }),
      },
    ),
    /credentials/i,
  );
});

test('transient upstream failures never spend a compliance attempt', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-transient-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let calls = 0;
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(5),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          calls += 1;
          if (calls <= 3) return Promise.reject(new ApiError(503, 'overloaded'));
          return Promise.resolve({
            text: '{"pick": "garchomp", "team_name": "Backoff Braviaries", "reasoning": "Survived the outage.", "notebook": "Build around Garchomp."}',
            usage: { total_tokens: 10 },
            toolCalls: [],
          });
        },
      }),
    },
  );
  assert.equal(outcome.picks[0]!.fallback, false, 'three 503s must not exhaust the model’s three attempts');
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');
});

test('a pick written only in the reasoning channel is salvaged without another attempt', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-salvage-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let calls = 0;
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(4),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          calls += 1;
          return Promise.resolve({
            text: '',
            reasoning:
              'Garchomp anchors the roster. Committing: {"pick": "garchomp", "team_name": "Salvage Sneaslers", "reasoning": "Best value.", "notebook": "Build around Garchomp."}',
            usage: { total_tokens: 400 },
            toolCalls: [],
          });
        },
      }),
    },
  );
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');
  assert.equal(outcome.picks[0]!.fallback, false, 'the pick inside the reasoning is used directly');
  assert.equal(calls, 10, 'the first pick salvages in one call; later picks reject the taken mon as usual');
});

test('a quota failure pauses for recovery and resumes where it left off', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-recovery-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const recovery = new RecoveryGate();
  const paused = Promise.withResolvers<void>();
  const removeListener = recovery.onChange((pause) => {
    if (pause) paused.resolve();
  });
  let calls = 0;
  const pending = runDraft(
    ['google:gemini-test', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(4),
      recovery,
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          calls += 1;
          if (calls === 1) return Promise.reject(new ApiError(429, 'exceeded your current quota'));
          return Promise.resolve({
            text: '{"pick": "garchomp", "team_name": "Patient Piplups", "reasoning": "Waited it out.", "notebook": "Build around Garchomp."}',
            usage: { total_tokens: 10 },
            toolCalls: [],
          });
        },
      }),
    },
  );

  await paused.promise;
  assert.equal(recovery.paused?.kind, 'quota');
  recovery.resume();

  const outcome = await pending;
  assert.equal(outcome.picks[0]!.fallback, false, 'the draft resumes rather than randomising');
  assert.equal(outcome.rosters[0]![0]!.id, 'garchomp');
  removeListener();
});

test('a resumed draft replays its transcript and continues from the next pick', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-replay-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const garchomp = mon('garchomp');
  const incineroar = mon('incineroar');
  const whimsicott = mon('whimsicott');
  const stored = [
    {
      pick: 1,
      model: 'fake:model',
      team_name: 'Replayed Rotoms',
      mon: garchomp.id,
      name: garchomp.name,
      cost: garchomp.cost,
      budget_left: BOARD.budget - garchomp.cost,
      rationale: 'Original pick before the crash.',
      notebook: 'Carry this plan across the resume.',
      fallback: false,
    },
    {
      pick: 2,
      model: 'random',
      team_name: 'Random Coach 2',
      mon: incineroar.id,
      name: incineroar.name,
      cost: incineroar.cost,
      budget_left: BOARD.budget - incineroar.cost,
      rationale: 'random baseline pick',
      fallback: false,
    },
    {
      pick: 3,
      model: 'random',
      team_name: 'Random Coach 2',
      mon: whimsicott.id,
      name: whimsicott.name,
      cost: whimsicott.cost,
      budget_left: BOARD.budget - incineroar.cost - whimsicott.cost,
      rationale: 'random baseline pick',
      fallback: false,
    },
  ];
  fs.writeFileSync(
    path.join(logDir, 'draft.jsonl'),
    `${stored.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  let calls = 0;
  const prompts: string[] = [];
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 3 },
    {
      logDir,
      rng: seededRng(9),
      makeDraftProvider: () => ({
        complete(_system, messages): Promise<Completion> {
          calls += 1;
          prompts.push(String(messages.at(-1)?.content ?? ''));
          const text =
            calls === 1
              ? '{"pick": "sinistcha", "reasoning": "Resume pick.", "notebook": "Updated plan."}'
              : '{"pick": "farigiraf", "reasoning": "Final pick.", "notebook": "Done."}';
          return Promise.resolve({ text, usage: { total_tokens: 10 }, toolCalls: [] });
        },
      }),
    },
  );

  assert.equal(calls, 2, 'replayed picks consume no provider calls');
  assert.equal(outcome.teamNames[0], 'Replayed Rotoms');
  assert.deepEqual(
    outcome.rosters[0]!.map((entry) => entry.id),
    [garchomp.id, 'sinistcha', 'farigiraf'],
  );
  assert.deepEqual(
    outcome.rosters[1]!.map((entry) => entry.id),
    [incineroar.id, whimsicott.id, outcome.rosters[1]![2]!.id],
  );
  assert.equal(outcome.picks[0]!.rationale, 'Original pick before the crash.');
  assert.equal(outcome.picks.length, 6);
  assert.ok(
    prompts[0]!.includes('Carry this plan across the resume.'),
    'the replayed notebook reaches the first live pick',
  );
  const transcript = fs
    .readFileSync(path.join(logDir, 'draft.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  assert.equal(transcript.length, 6, 'replayed picks are not rewritten to the transcript');
});

const TEAMBUILD_ROSTER = [
  'garchomp',
  'incineroar',
  'sinistcha',
  'farigiraf',
  'whimsicott',
  'pelipper',
  'charizard-mega-y',
  'toxapex',
  'grimmsnarl',
  'gholdengo',
].map(mon);

function teambuildRequest(overrides: Record<string, unknown> = {}) {
  return {
    seriesIndex: 0,
    entrant: 0,
    opponent: 1,
    stage: 'roundrobin' as const,
    model: 'fake:model',
    opponentModel: 'fake:rival',
    teamName: 'Test Tauros',
    opponentTeamName: 'Rival Rotoms',
    roster: TEAMBUILD_ROSTER,
    opponentRoster: TEAMBUILD_ROSTER.slice(0, 10),
    draftNote: 'Flexible Ground offense with two speed-control modes.',
    playoffContext: [],
    format: BOARD.format,
    ...overrides,
  };
}

const GOOD_TEAM = JSON.stringify({
  team_plan: 'Rain beats their sun core, so Pelipper leads with Charizard held back.',
  sets: [
    {
      id: 'garchomp',
      item: 'Life Orb',
      ability: 'Rough Skin',
      nature: 'Jolly',
      moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'],
      evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
    },
    {
      id: 'incineroar',
      item: 'Sitrus Berry',
      ability: 'Intimidate',
      nature: 'Impish',
      moves: ['Fake Out', 'Flare Blitz', 'Parting Shot', 'Darkest Lariat'],
      evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
    },
    {
      id: 'sinistcha',
      item: 'Leftovers',
      ability: 'Hospitality',
      nature: 'Bold',
      moves: ['Matcha Gotcha', 'Rage Powder', 'Life Dew', 'Protect'],
      evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
    },
    {
      id: 'farigiraf',
      item: 'Colbur Berry',
      ability: 'Armor Tail',
      nature: 'Relaxed',
      moves: ['Psychic', 'Trick Room', 'Helping Hand', 'Protect'],
      evs: { hp: 32, atk: 0, def: 20, spa: 14, spd: 0, spe: 0 },
    },
    {
      id: 'whimsicott',
      item: 'Focus Sash',
      ability: 'Prankster',
      nature: 'Timid',
      moves: ['Tailwind', 'Encore', 'Moonblast', 'Protect'],
      evs: { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 },
    },
    {
      id: 'charizard-mega-y',
      item: 'Charizardite Y',
      ability: 'Blaze',
      nature: 'Modest',
      moves: ['Heat Wave', 'Solar Beam', 'Weather Ball', 'Protect'],
      evs: { hp: 20, atk: 0, def: 0, spa: 32, spd: 0, spe: 14 },
    },
  ],
});

test('a legal teambuild is accepted as written and packs the base forme', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => scriptedProvider([GOOD_TEAM]),
  });

  assert.equal(view.attempts, 1);
  assert.equal(view.brought.length, 6);
  assert.ok(
    view.sets.every((set) => !set.repaired),
    `no set should need repair: ${JSON.stringify(view.sets)}`,
  );
  assert.match(view.rationale, /Rain beats their sun core/);
  assert.ok(packed.includes('Charizard|'), 'the mega registers as its base forme');
  assert.ok(packed.includes('CharizarditeY'), 'holding its stone');

  const { Teams } = loadShowdown();
  assert.equal((Teams.unpack(packed) ?? []).length, 6);
});

test('an accepted teambuild preserves fewer than four legal moves', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-three-moves-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const team = JSON.parse(GOOD_TEAM) as { sets: Array<{ moves: string[] }> };
  team.sets[0]!.moves = team.sets[0]!.moves.slice(0, 3);
  const { view } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(team)]),
  });
  assert.deepEqual(view.sets[0]!.moves, team.sets[0]!.moves);
  assert.equal(view.sets[0]!.repaired, false);
});

test('the teambuild prompt carries the roster, the opponent, and only legal moves', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-prompt-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = '';
  await runTeambuild(teambuildRequest({ stage: 'playoff', playoffContext: ['Week 1: beat Rival Rotoms 2-0'] }), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () =>
      scriptedProvider([GOOD_TEAM], (messages) => {
        prompt = messages[0]!.content ?? '';
      }),
  });
  assert.ok(prompt.includes('YOUR ROSTER'), 'the model sees its roster');
  assert.ok(prompt.includes('Rival Rotoms'), 'and who it is playing');
  assert.ok(prompt.includes('Flexible Ground offense'), 'and its final private draft note');
  assert.ok(prompt.includes('Week 1: beat Rival Rotoms 2-0'), 'playoff builders receive earlier match context');
  assert.ok(prompt.includes('MUST hold Charizardite Y'), 'the mega lock is stated');
  assert.match(
    prompt,
    /set "ability" to one of Blaze or Solar Power, NOT its Mega ability/,
    'a Mega entry registers its pre-Mega ability, which models otherwise get wrong',
  );
  assert.ok(prompt.includes('cannot hold a Mega Stone'), 'and so is its inverse');
  assert.ok(!/moves:.*\bBounce\b/.test(prompt), 'the movepool must not offer moves the validator rejects');
});

test('round-robin teambuilds do not receive other round-robin match context', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-blind-round-robin-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = '';
  await runTeambuild(teambuildRequest({ playoffContext: ['Prior round-robin scouting that must stay blind'] }), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () =>
      scriptedProvider([GOOD_TEAM], (messages) => {
        prompt = messages[0]!.content ?? '';
      }),
  });
  assert.doesNotMatch(prompt, /Prior round-robin scouting/);
});

test('the system prompt lists the Champions item list, which Gen 9 knowledge gets wrong', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-items-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let system = '';
  await runTeambuild(teambuildRequest({ roster: [...TEAMBUILD_ROSTER, mon('annihilape')] }), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => ({
      complete(prompt): Promise<Completion> {
        system = prompt;
        return Promise.resolve({ text: GOOD_TEAM, usage: { total_tokens: 10 }, toolCalls: [] });
      },
    }),
  });

  for (const item of ['Leftovers', 'Life Orb', 'Focus Sash', 'Light Clay']) {
    assert.ok(system.includes(item), `${item} is legal here and must be offered`);
  }
  for (const absent of ['Assault Vest', 'Rocky Helmet', 'Safety Goggles', 'Booster Energy', 'Eviolite']) {
    assert.ok(!system.includes(absent), `${absent} does not exist in Champions and must not be offered`);
  }
  assert.ok(!system.includes('Charizardite'), 'Mega Stones are locked or banned per entry, never a free choice');
  assert.ok(!system.includes('Final Gambit'), 'Annihilape does not learn Final Gambit in Champions');
  assert.ok(!system.includes('Knock Off'), 'Incineroar does not learn Knock Off in Champions');
});

test('an illegal team is rejected with Showdown’s own errors, then repaired', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-repair-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const broken = JSON.parse(GOOD_TEAM) as { sets: Array<Record<string, unknown>> };
  broken.sets[0]!.moves = ['Earthquake', 'Bounce', 'Rock Slide', 'Protect'];
  broken.sets[0]!.evs = { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 };
  broken.sets[5]!.item = 'Leftovers';

  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(9),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(broken)]),
  });

  assert.equal(view.attempts, 5, 'the model gets its retries before anything is repaired');
  const zard = view.sets.find((set) => set.species.includes('Charizard'))!;
  assert.equal(zard.item, 'Charizardite Y', 'the mega lock is restored');
  assert.ok(zard.repairs.some((repair) => repair.includes('locked to')));
  const chomp = view.sets.find((set) => set.species === 'Garchomp')!;
  assert.ok(!chomp.moves.includes('Bounce'), 'the illegal move is dropped');
  assert.ok(chomp.repairs.some((repair) => repair.includes('Bounce')));
  assert.ok(
    Object.values(chomp.evs).reduce((sum, value) => sum + value, 0) <= 66,
    'EVs are brought inside the Champions budget',
  );

  const errors = fs
    .readFileSync(path.join(logDir, 'series-1-e0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.match(String(errors[0]!.error), /Bounce|Stat Points|Charizardite/);

  const { Teams } = loadShowdown();
  assert.equal((Teams.unpack(packed) ?? []).length, 6, 'the repaired team still packs');
});

test('a team that survives repair still illegal is rebuilt rather than aborting the league', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-rebuild-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const broken = JSON.parse(GOOD_TEAM) as { sets: Array<Record<string, unknown>> };
  for (const set of broken.sets) {
    set.moves = [];
    set.evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    set.nature = 'Serious';
  }

  const { view, packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(4),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(broken)]),
  });

  const { Teams } = loadShowdown();
  const unpacked = Teams.unpack(packed) ?? [];
  assert.equal(unpacked.length, 6);
  for (const set of unpacked) assert.ok((set.moves ?? []).length > 0, `${set.species} must end with moves`);
  assert.ok(
    view.sets.every((set) => set.repaired),
    'every set needed repair here',
  );
});

test('a teambuild quota failure pauses instead of shipping a repaired team', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-recovery-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const recovery = new RecoveryGate();
  const paused = Promise.withResolvers<void>();
  const removeListener = recovery.onChange((pause) => {
    if (pause) paused.resolve();
  });
  let calls = 0;
  const pending = runTeambuild(teambuildRequest({ model: 'google:gemini-test' }), {
    logDir,
    rng: seededRng(2),
    recovery,
    makeTeambuildProvider: () => ({
      complete(): Promise<Completion> {
        calls += 1;
        if (calls === 1) return Promise.reject(new ApiError(429, 'exceeded your current quota'));
        return Promise.resolve({ text: GOOD_TEAM, usage: { total_tokens: 10 }, toolCalls: [] });
      },
    }),
  });

  await paused.promise;
  assert.equal(recovery.paused?.kind, 'quota');
  recovery.resume();

  const { view } = await pending;
  assert.ok(
    view.sets.every((set) => !set.repaired),
    'the model still got to write its own team',
  );
  removeListener();
});

test('a full draft league drafts, plays weekly rounds, and crowns a champion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const events: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(['random', 'random', 'random', 'random'], directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    onEvent: (event) => events.push(event),
  });

  assert.equal(rows.length, 6 + 1, 'a four-coach round robin is six series, plus a top-two final');
  for (const row of rows) {
    assert.equal(row.mode, 'draft');
    assert.equal(row.protocol_version, DRAFT_PROTOCOL_VERSION);
    assert.equal(row.board, 'regmb-202607');
    assert.equal(row.draft_scaffold, draftScaffoldRevision());
    assert.equal(row.teambuild_scaffold, teambuildScaffoldRevision());
    assert.equal(row.window_scaffold, tradeWindowScaffoldRevision());
    assert.deepEqual(row.trade_window, { after_week: 3 });
  }

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.mode, 'draft');
  assert.equal(config.weeks, 3);
  assert.equal(config.sequential_weeks, false, 'round-robin series run concurrently by default');
  assert.equal(config.closed_sheets, false, 'the stock format keeps its open team sheets by default');
  assert.deepEqual(config.trade_window, { after_week: 3 }, 'mid-season free agency is the default');
  assert.deepEqual(config.draft_notes, ['', '', '', '']);
  const rosters = config.rosters as string[][];
  assert.equal(rosters.length, 4);
  for (const roster of rosters) assert.equal(roster.length, 10);
  assert.equal(new Set(rosters.flat()).size, 40, 'no entry is drafted twice');

  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'rosters.json'), 'utf8')) as Array<
    Record<string, unknown>
  >;
  for (const entry of stored) assert.ok((entry.spent as number) <= 100, 'no coach overspends');
  const window = JSON.parse(fs.readFileSync(path.join(directory, 'window.json'), 'utf8')) as {
    after_week: number;
    order: number[];
    decisions: Array<{ swaps: unknown[] }>;
  };
  assert.equal(window.after_week, 3);
  assert.equal(window.decisions.length, 4);
  assert.ok(window.decisions.every((decision) => decision.swaps.length === 0));
  assert.equal(window.order.length, 4);

  const teambuilds = fs
    .readFileSync(path.join(directory, 'teambuild', 'teambuild.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(teambuilds.length, rows.length * 2, 'both coaches build before every series');
  for (const build of teambuilds) assert.equal((build.brought as string[]).length, 6);
  const coaching = fs
    .readFileSync(path.join(directory, 'coaching.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(coaching.length, rows.length * 2, 'each coach receives resumable private playoff context');
  assert.ok(coaching.every((entry) => String(entry.context).includes('Registered sets:')));

  const draftEvents = events.filter(
    (event): event is Extract<DraftLeagueEvent, { type: 'draft' }> => event.type === 'draft',
  );
  assert.ok(
    draftEvents.some((event) => event.draft.phase === 'window'),
    'the live UI exposes the barrier',
  );
  const finalDraft = draftEvents[draftEvents.length - 1]!.draft;
  assert.equal(finalDraft.phase, 'done');
  assert.equal(finalDraft.weeks, 3);
  assert.ok(finalDraft.teambuilds.length > 0);
  assert.equal(loadRows(recordsPath).length, rows.length);
});

test('a draft league checkpoints after a week and resumes to a champion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = ['random', 'random', 'random', 'random'];
  const first = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    throughWeek: 1,
  });
  assert.equal(first.length, 2, 'week one is two series');
  assert.ok(first.every((row) => row.stage === 'roundrobin' && row.round === 1));
  assert.ok(!fs.existsSync(path.join(directory, 'window.jsonl')), 'pausing before the barrier does not open it');

  const teambuildLog = path.join(directory, 'teambuild', 'teambuild.jsonl');
  const storedBuilds = fs
    .readFileSync(teambuildLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (let entrant = 0; entrant < 4; entrant += 1) {
    const donor = storedBuilds.find((row) => row.entrant === entrant)!;
    fs.appendFileSync(
      teambuildLog,
      `${JSON.stringify({ ...donor, seriesIndex: 2, opponent: (entrant + 1) % 4, rationale: 'prebuilt before the crash' })}\n`,
    );
  }

  const resumed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    resume: true,
  });
  assert.equal(resumed.length, 6 + 1, 'the resumed league finishes the round robin and the final');
  assert.equal(new Set(resumed.map((row) => row.series_index)).size, 7, 'no series repeats');
  assert.equal(loadRows(recordsPath).length, 7, 'each series is recorded exactly once');
  const final = resumed[resumed.length - 1]!;
  assert.equal(final.stage, 'playoff');
  assert.ok(final.advanced, 'the resumed league crowns a champion');
  assert.ok(fs.existsSync(path.join(directory, 'window.json')), 'resume completes the default trade window');

  const buildsAfter = fs
    .readFileSync(teambuildLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    buildsAfter.filter((row) => row.seriesIndex === 2).length,
    4,
    'series with stored teambuilds reuse them instead of rebuilding',
  );
});

test('a two-coach league plays one week and a single final', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-two-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rows = await runDraftLeague(['random', 'random'], directory, {
    recordsPath: path.join(directory, 'results.jsonl'),
    seed: 5,
    concurrency: 1,
    sequentialWeeks: true,
    closedSheets: true,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.stage, 'roundrobin');
  assert.equal(rows[1]!.stage, 'playoff');
  assert.ok(rows[1]!.winner, 'a playoff series must produce a winner');
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.sequential_weeks, true);
  assert.equal(config.closed_sheets, true);
  assert.deepEqual(config.trade_window, { after_week: 1 }, 'short leagues clamp the default to their final week');
  for (const row of rows) assert.equal(row.closed_sheets, true, 'series records carry the sheet rule');
  const gameLog = fs.readFileSync(path.join(directory, 'series', String(rows[0]!.series_id), 'game-1.log'), 'utf8');
  assert.ok(!gameLog.includes('|showteam|'), 'closed-sheet games publish no team sheets');
});

test('a draft-only league stops at the rosters and resumes into a full season', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-only-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const drafted = await runDraftLeague(['random', 'random'], directory, {
    recordsPath,
    seed: 5,
    concurrency: 1,
    draftOnly: true,
  });
  assert.deepEqual(drafted, [], 'a draft-only league plays no series');
  assert.ok(!fs.existsSync(path.join(directory, 'series')), 'no series directory is created');
  assert.ok(!fs.existsSync(recordsPath), 'no rows reach the records file');

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.draft_only, true);
  assert.equal(config.trade_window, null, 'a league that plays no games holds no free-agency window');
  const rosters = JSON.parse(fs.readFileSync(path.join(directory, 'rosters.json'), 'utf8')) as Array<
    Record<string, unknown>
  >;
  assert.equal(rosters.length, 2);

  const played = await runDraftLeague(['random', 'random'], directory, {
    recordsPath,
    seed: 5,
    concurrency: 1,
    resume: true,
  });
  assert.equal(played.length, 2, 'resuming a draft-only run plays the season it skipped');
  const promoted = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(promoted.rosters, config.rosters, 'the drafted rosters carry into the season');
  assert.equal(played[0]!.stage, 'roundrobin');
  assert.equal(played[1]!.stage, 'playoff');
});

test('the board is published price-descending the way a draft league publishes one', () => {
  const costs = draftBoardTable(BOARD, defaultPsDir())
    .split('\n')
    .slice(1)
    .map((line) => Number(line.split(' | ')[1]));
  assert.ok(costs.length > 1, 'the board renders rows');
  assert.ok(
    costs.every((cost, index) => index === 0 || cost <= costs[index - 1]!),
    'contested premium entries are listed first',
  );
});

test('the draft prompt states budget rules without computing a ceiling for the coach', () => {
  const state = freshState();
  const prompt = draftUserPrompt(state, 0, ['fake:model', 'random'], 0, '');
  assert.ok(!/most you can spend/.test(prompt), 'the harness does not compute an affordable ceiling');
  assert.match(prompt, /every remaining slot has to be filled/, 'the budget rule is still stated');
  assert.ok(
    prompt.indexOf('YOUR ROSTER') < prompt.lastIndexOf('You have'),
    'roster context comes before the budget line',
  );
  assert.ok(!/roster plan and needs/.test(prompt), 'the notebook does not prescribe a needs list');
});

test('season reviews are written once per coach and replayed on resume', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-season-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = ['test:champion', 'test:eliminated'];
  const state: SeasonReviewState = {
    board: BOARD,
    models,
    teamNames: ['Champion', 'Eliminated'],
    picks: [
      { pick: 0, entrant: 0, mon: mon('charizard-mega-y').id, rationale: 'Sun opener.', fallback: false },
      { pick: 1, entrant: 1, mon: mon('tyranitar').id, rationale: 'Sand anchor.', fallback: false },
    ],
    rosters: [[mon('charizard-mega-y')], [mon('tyranitar')]],
    window: {
      after_week: 3,
      order: [1, 0],
      decisions: [
        { entrant: 1, model: models[1]!, swaps: [], reasoning: 'Kept it.', notebook: '', fallback: false },
        {
          entrant: 0,
          model: models[0]!,
          swaps: [{ drop: mon('venusaur').id, add: mon('absol').id }],
          reasoning: 'Traded up.',
          notebook: '',
          fallback: false,
        },
      ],
      rosters: [],
    },
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    series: [['Round-robin week 1: beat Eliminated 2-0'], ['Round-robin week 1: lost to Champion 0-2']],
    notebooks: ['champion plan', 'eliminated plan'],
  };
  const prompts = new Map<string, string>();
  const reply = JSON.stringify({
    summary: 'It went as the record says.',
    did_well: 'The draft covered rain.',
    did_poorly: 'The mega slot was idle.',
    would_change: 'Buy the backup mega.',
  });
  const reviews = await runSeasonReview(
    [
      { entrant: 1, outcome: 'You missed the playoffs.' },
      { entrant: 0, outcome: 'You won the final.' },
    ],
    state,
    {
      runDir: directory,
      psDir: defaultPsDir(),
      makeReviewProvider: (spec) => ({
        complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
          prompts.set(spec, `${system}\n${messages[0]?.content ?? ''}`);
          return Promise.resolve({ text: reply, usage: {}, toolCalls: [] });
        },
      }),
    },
  );
  assert.deepEqual(
    reviews.map((review) => review.entrant),
    [1, 0],
  );
  assert.ok(reviews.every((review) => !review.fallback));
  assert.match(prompts.get(models[0]!) ?? '', /Traded up\./);
  assert.match(
    prompts.get(models[1]!) ?? '',
    /coaching Eliminated /,
    'a coach is named its own team, so it can find its row in the standings',
  );
  assert.match(prompts.get(models[1]!) ?? '', /You made no swaps/);
  assert.match(prompts.get(models[1]!) ?? '', /Sand anchor\./);
  assert.equal(loadRows(path.join(directory, 'season.jsonl')).length, 2);

  const replayed = await runSeasonReview([{ entrant: 0, outcome: 'You won the final.' }], state, {
    runDir: directory,
    psDir: defaultPsDir(),
    makeReviewProvider: () => ({
      complete(): Promise<Completion> {
        throw new Error('a replayed season review must not call a provider');
      },
    }),
  });
  const byEntrant = (rows: typeof reviews) => [...rows].sort((a, b) => a.entrant - b.entrant);
  assert.deepEqual(byEntrant(replayed), byEntrant(reviews));
  assert.equal(readSeasonReviews(directory).length, 2);

  const started: number[] = [];
  let releaseFirst: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve, reject) => {
    releaseFirst = resolve;
    setTimeout(
      () => reject(new Error('the second seat never started: season reviews ran one at a time')),
      5_000,
    ).unref();
  });
  const concurrent = await runSeasonReview(
    [
      { entrant: 0, outcome: 'You won the final.' },
      { entrant: 1, outcome: 'You missed the playoffs.' },
    ],
    state,
    {
      runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-season-review-parallel-')),
      psDir: defaultPsDir(),
      makeReviewProvider: (spec) => ({
        async complete(): Promise<Completion> {
          const entrant = models.indexOf(spec);
          started.push(entrant);
          if (started.length === 1) await bothStarted;
          else releaseFirst?.();
          return { text: reply, usage: {}, toolCalls: [] };
        },
      }),
    },
  );
  assert.deepEqual(
    concurrent.map((review) => review.entrant),
    [0, 1],
    'reviews return in the order the seats finished their seasons, whatever order they answer in',
  );
  assert.ok(
    concurrent.every((review) => !review.fallback),
    'both seats were in flight at once',
  );
});

test('a season review must fill every field', () => {
  assert.equal(typeof parseSeasonReview('no json here'), 'string');
  assert.equal(
    typeof parseSeasonReview(JSON.stringify({ summary: 'a', did_well: 'b', did_poorly: 'c', would_change: '  ' })),
    'string',
  );
  const parsed = parseSeasonReview(
    JSON.stringify({ summary: 'a', did_well: 'b', did_poorly: 'c', would_change: 'd', extra: 1 }),
  );
  assert.notEqual(typeof parsed, 'string');
});

test('search_board filters the board by price, type, ability, and legal movepool', () => {
  const search = createBoardSearch(BOARD, defaultPsDir());
  const ids = (result: string): string[] =>
    result
      .split('\n')
      .slice(1)
      .map((line) => line.slice(2).split(' | ')[0]!);

  const cheapFire = search.run({ types: ['fire'], max_cost: 10, limit: 100 });
  const cheapFireIds = ids(cheapFire);
  assert.ok(cheapFireIds.length > 0, 'the board has cheap Fire types');
  for (const id of cheapFireIds) {
    const entry = mon(id);
    assert.ok(entry.cost <= 10, `${id} respects max_cost`);
    assert.ok(entry.types.some((type) => type.toLowerCase() === 'fire'), `${id} is Fire`);
  }

  const fakeOut = ids(search.run({ learns: 'Fake Out', limit: 100 }));
  assert.ok(fakeOut.includes('incineroar'), 'Incineroar learns Fake Out');
  assert.ok(!fakeOut.includes('archaludon'), 'Archaludon does not learn Fake Out');

  const intimidate = ids(search.run({ ability: 'Intimidate', limit: 100 }));
  assert.ok(intimidate.includes('incineroar'), 'Incineroar has Intimidate');

  const dual = ids(search.run({ types: ['Fire', 'Flying'], limit: 100 }));
  assert.ok(dual.includes('charizard-mega-y'), 'both listed types must match');
  assert.ok(!dual.includes('incineroar'), 'a Fire/Dark entry does not match Fire/Flying');

  assert.match(search.run({ learns: 'Nonexistent Move' }), /No move data/);
  assert.match(search.run({ max_cost: 0 }), /No board entries match/);
});

test('search_board sorts by price by default and reaches entries the board buries', () => {
  const search = createBoardSearch(BOARD, defaultPsDir());
  const rows = search.run({ limit: 100 }).split('\n').slice(1);
  const costs = rows.map((line) => Number(line.split(' | ')[1]));
  assert.ok(
    costs.every((cost, index) => index === 0 || cost <= costs[index - 1]!),
    'default sort is price-descending',
  );

  const byName = search.run({ sort: 'name', limit: 100 }).split('\n').slice(1);
  const names = byName.map((line) => line.split(' | ')[2]!);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'name sort is alphabetical');

  const bst = search.run({ min_bst: 600, limit: 100 });
  assert.ok(ids(bst).length > 0, 'the base stat filter returns entries');
  function ids(result: string): string[] {
    return result
      .split('\n')
      .slice(1)
      .map((line) => line.slice(2).split(' | ')[0]!);
  }
});
