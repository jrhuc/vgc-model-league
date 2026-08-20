import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBoardSearch } from '../src/board-search.js';
import type { DraftBoardMon, DraftState } from '../src/draft.js';
import {
  applyDraftPick,
  boardInfo,
  draftBoardTable,
  draftScaffoldRevision,
  draftUserPrompt,
  legalPicks,
  loadBoard,
  maxAffordable,
  parseFranchiseName,
  parsePick,
  runDraft,
  snakeOrder,
} from '../src/draft.js';
import type { DraftLeagueEvent } from '../src/draftleague.js';
import { DRAFT_PROTOCOL_VERSION, runDraftLeague } from '../src/draftleague.js';
import { draftLeagueTopology, roundRobinWeeks } from '../src/draftleague-topology.js';
import { readJsonlObjects } from '../src/jsonl.js';
import { defaultPsDir } from '../src/paths.js';
import { FORMAT_AUTHORITY_NOTICE } from '../src/prompts.js';
import { ApiError } from '../src/providers.js';
import { seededRng, seriesEntropy } from '../src/random.js';
import { loadSeriesRecords } from '../src/records.js';
import { RecoveryGate } from '../src/recovery.js';
import { parseSeasonReview, runSeasonReview, type SeasonReviewState } from '../src/season-review.js';
import { canonicalJson } from '../src/serialization.js';
import { foldSeriesGames } from '../src/series.js';
import { loadShowdown } from '../src/showdown.js';
import { runTeambuild, teambuildScaffoldRevision } from '../src/teambuild.js';
import {
  applyFreeAgency,
  applyTradeOffer,
  describeTransactionHistory,
  MAX_TRADE_OFFERS,
  parseTradeDecision,
  parseTradeOffer,
  parseTradeResponse,
  readValidatedTradeWindow,
  renderFreeAgencyPrompt,
  renderTradeOfferPrompt,
  runTradeWindow,
  type TradeWindowState,
  tradeWindowScaffoldRevision,
} from '../src/trade-window.js';
import type { Completion, Provider, ProviderMessage } from '../src/types.js';
import { runWeeklyReview } from '../src/weekly-review.js';
import { legalTeamResponse } from './fixtures/team-build.js';

const BOARD = loadBoard('regmb-202607');
const mon = (id: string): DraftBoardMon => {
  const found = BOARD.mons.find((candidate) => candidate.id === id);
  assert.ok(found, `board is missing ${id}`);
  return found;
};

function assertFormatAuthority(prompt: string): void {
  assert.equal(prompt.split(FORMAT_AUTHORITY_NOTICE).length - 1, 1);
}

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

function transactionState(entrants = 2): TradeWindowState {
  const rosters = Array.from({ length: entrants }, () => [] as DraftBoardMon[]);
  const bases = new Set<string>();
  let cursor = 0;
  for (const candidate of [...BOARD.mons].sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))) {
    if (bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    rosters[cursor]!.push(candidate);
    if (rosters[cursor]!.length === BOARD.picks) cursor += 1;
    if (cursor === entrants) break;
  }
  assert.equal(cursor, entrants, 'fixture needs enough complete inexpensive rosters');
  return {
    board: BOARD,
    models: Array.from({ length: entrants }, () => 'random'),
    teamNames: Array.from({ length: entrants }, (_, entrant) => `Team ${entrant + 1}`),
    rosters,
    budgets: rosters.map((roster) => BOARD.budget - roster.reduce((sum, mon) => sum + mon.cost, 0)),
    notebooks: Array.from({ length: entrants }, () => ''),
    standings: Array.from({ length: entrants }, (_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 })),
    results: Array.from({ length: entrants }, () => []),
    reflections: Array.from({ length: entrants }, () => []),
    history: [],
  };
}

test('scaffold identities are distinct', () => {
  const revisions = [
    draftScaffoldRevision(),
    teambuildScaffoldRevision(),
    teambuildScaffoldRevision('closed'),
    tradeWindowScaffoldRevision(),
  ];
  for (const revision of revisions) assert.match(revision, /^[0-9a-f]{12}$/);
  assert.equal(new Set(revisions).size, revisions.length);
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

test('draft pick transitions enforce the exact turn without mutating prior state', () => {
  const snapshot = (state: DraftState) => ({
    taken: [...state.taken],
    rosters: state.rosters.map((roster) => roster.map((entry) => entry.id)),
    budgets: [...state.budgets],
    teamNames: [...state.teamNames],
  });
  const initial = freshState();
  const untouched = snapshot(initial);
  const action = { pick: 1, entrant: 0, mon: 'garchomp' };
  const accepted = applyDraftPick(initial, action);

  assert.deepEqual(snapshot(initial), untouched);

  const afterAccepted = snapshot(accepted);
  assert.throws(() => applyDraftPick(accepted, action), /pick 1 is stale; expected pick 2/);
  assert.deepEqual(snapshot(accepted), afterAccepted);
  assert.throws(() => applyDraftPick(initial, { ...action, entrant: 1 }), /pick 1 belongs to entrant 0, not entrant 1/);
  assert.deepEqual(snapshot(initial), untouched);
});

test('draft pick transitions reject unavailable, species-clashing, and over-budget picks atomically', () => {
  const first = applyDraftPick(freshState(), { pick: 1, entrant: 0, mon: 'garchomp' });
  const afterFirst = {
    taken: [...first.taken],
    rosters: first.rosters.map((roster) => [...roster]),
    budgets: [...first.budgets],
  };
  assert.throws(() => applyDraftPick(first, { pick: 2, entrant: 1, mon: 'garchomp' }), /already drafted by coach 1/);
  assert.deepEqual({ taken: [...first.taken], rosters: first.rosters, budgets: first.budgets }, afterFirst);

  const second = applyDraftPick(first, { pick: 2, entrant: 1, mon: 'charizard-mega-y' });
  const beforeClash = structuredClone(second);
  assert.throws(
    () => applyDraftPick(second, { pick: 3, entrant: 1, mon: 'charizard' }),
    /shares the species Charizard/,
  );
  assert.deepEqual(second, beforeClash);

  const tight = freshState({ budgets: [1, BOARD.budget] });
  const beforeBudget = structuredClone(tight);
  assert.throws(
    () => applyDraftPick(tight, { pick: 1, entrant: 0, mon: 'garchomp' }),
    /costs .* but you can spend at most/,
  );
  assert.deepEqual(tight, beforeBudget);
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
    const topology = draftLeagueTopology(size);
    assert.equal(topology.weekCount, weeks.length);
    assert.equal(topology.roundRobinSeries, seen.size);
    assert.equal(topology.playoffSeries, size >= 5 ? 3 : 1);
    assert.equal(topology.totalSeries, seen.size + topology.playoffSeries);
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
    history: [],
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
  const beforeRejected = structuredClone(state);
  assert.throws(
    () => applyFreeAgency(state, 0, [{ drop: tyranitar.id, add: megaTyranitar.id }], 'Mega Tyranitar is the endgame.'),
    /above the .* budget/,
  );
  assert.deepEqual(state, beforeRejected, 'a rejected list mutates nothing');

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
  const accepted = applyFreeAgency(state, 0, parsed.swaps, parsed.notebook);
  assert.deepEqual(state, beforeRejected, 'an accepted transition does not mutate its prior state');
  assert.equal(accepted.rosters[0]!.length, BOARD.picks);
  assert.equal(accepted.budgets[0], 0);
  assert.equal(accepted.notebooks[0], 'Mega Tyranitar is now the endgame.');
  assert.ok(accepted.rosters[0]!.some((entry) => entry.id === megaTyranitar.id));
  assert.ok(accepted.rosters[0]!.some((entry) => entry.id === absol.id));
  assert.ok(!accepted.rosters[0]!.some((entry) => entry.id === tyranitar.id || entry.id === mrRime.id));
});

test('coach trades validate both rosters and apply an accepted exchange atomically', () => {
  const state = {
    board: { ...BOARD, picks: 2 },
    models: ['test:a', 'test:b'],
    teamNames: ['A', 'B'],
    rosters: [
      [mon('charizard-mega-y'), mon('absol')],
      [mon('tyranitar'), mon('mr-rime')],
    ],
    budgets: [79, 83],
    notebooks: ['', ''],
    standings: [],
    results: [[], []],
    reflections: [[], []],
    history: [],
  } satisfies TradeWindowState;
  const parsed = parseTradeOffer(
    JSON.stringify({
      offer: { to: 1, give: 'charizard-mega-y', get: 'tyranitar', message: 'A direct exchange.' },
      reasoning: 'Private valuation.',
      notebook: 'Plan around Tyranitar.',
    }),
    state,
    0,
  );
  assert.match(
    String(
      parseTradeOffer(
        '{"offer":{"to":"1","give":"charizard-mega-y","get":"tyranitar","message":"A direct exchange."},"reasoning":"Private valuation.","notebook":"Plan around Tyranitar."}',
        state,
        0,
      ),
    ),
    /entrant index/,
  );
  assert.notEqual(typeof parsed, 'string', String(parsed));
  assert.deepEqual(parseTradeResponse('{"accept":true,"reasoning":"Worth it.","notebook":"Plan around Charizard."}'), {
    accept: true,
    reasoning: 'Worth it.',
    notebook: 'Plan around Charizard.',
    evidence: {
      rationale: 'Worth it.',
      notebook: 'Plan around Charizard.',
      supplied: { rationale: true, notebookUpdate: true },
    },
  });
  assert.deepEqual(parseTradeResponse('{"accept":true}', 'Keep the old plan.'), {
    accept: true,
    reasoning: '',
    notebook: 'Keep the old plan.',
    evidence: {
      rationale: '',
      notebook: 'Keep the old plan.',
      supplied: { rationale: false, notebookUpdate: false },
    },
  });
  assert.deepEqual(parseTradeResponse('{"accept":false,"notebook":""}', 'Clear this plan.'), {
    accept: false,
    reasoning: '',
    notebook: '',
    evidence: {
      rationale: '',
      notebook: '',
      supplied: { rationale: false, notebookUpdate: true },
    },
  });
  if (typeof parsed === 'string' || !parsed.offer) return;
  const offered = parsed.offer;
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyTradeOffer(state, {
        from: 0,
        to: 1,
        give: offered.give,
        get: 'garchomp',
        accepted: true,
        notebook: parsed.notebook,
        responseNotebook: 'Plan around Charizard.',
      }),
    /is not on test:b's current roster/,
  );
  assert.deepEqual(state, before, 'a rejected offer leaves rosters, budgets, and notebooks untouched');

  const accepted = applyTradeOffer(state, {
    from: 0,
    to: offered.to,
    give: offered.give,
    get: offered.get,
    accepted: true,
    notebook: parsed.notebook,
    responseNotebook: 'Plan around Charizard.',
  });
  assert.deepEqual(state, before, 'an accepted offer does not mutate its prior state');
  assert.deepEqual(
    accepted.rosters[0]!.map((entry) => entry.id),
    ['absol', 'tyranitar'],
  );
  assert.deepEqual(
    accepted.rosters[1]!.map((entry) => entry.id),
    ['mr-rime', 'charizard-mega-y'],
  );
  assert.equal(accepted.budgets[0], 85);
  assert.equal(accepted.budgets[1], 77);
  assert.deepEqual(accepted.notebooks, ['Plan around Tyranitar.', 'Plan around Charizard.']);
});

test('coach offers resolve before free agency and replay without model calls', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-coach-trades-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cheap: DraftBoardMon[] = [];
  const bases = new Set<string>();
  for (const candidate of BOARD.mons) {
    if (candidate.cost !== 1 || bases.has(candidate.base)) continue;
    bases.add(candidate.base);
    cheap.push(candidate);
    if (cheap.length === 20) break;
  }
  assert.equal(cheap.length, 20);
  const models = ['test:best', 'test:worst'];
  const createState = (): TradeWindowState => ({
    board: BOARD,
    models,
    teamNames: ['Best', 'Worst'],
    rosters: [cheap.slice(0, 10), cheap.slice(10, 20)],
    budgets: [90, 90],
    notebooks: ['best', 'worst'],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    results: [[], []],
    reflections: [[], []],
    history: [],
  });
  const queues = new Map<string, string[]>([
    [
      models[1]!,
      [
        JSON.stringify({
          offer: { to: 0, give: cheap[10]!.id, get: cheap[0]!.id, message: 'Swap role players?' },
          reasoning: 'The exchange fits.',
          notebook: 'Use the incoming role player.',
        }),
        JSON.stringify({
          offer: { to: 0, give: cheap[11]!.id, get: cheap[1]!.id, message: 'A separate second offer?' },
        }),
        JSON.stringify({ swaps: [], reasoning: 'Done.', notebook: 'Use the incoming role player.' }),
      ],
    ],
    [
      models[0]!,
      [
        JSON.stringify({
          accept: true,
          reasoning: 'The exchange also fits us.',
          notebook: 'Weighed the incoming offer.',
        }),
        JSON.stringify({ accept: false }),
        JSON.stringify({ offer: null, reasoning: 'No outbound offer.', notebook: 'Keep the trade.' }),
        JSON.stringify({ swaps: [], reasoning: 'Done.', notebook: 'Keep the trade.' }),
      ],
    ],
  ]);
  const prompts = new Map<string, string[]>();
  const systems: string[] = [];
  const liveState = createState();
  const artifact = await runTradeWindow(liveState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 2,
    makeTradeProvider: (spec) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        systems.push(system);
        const response = queues.get(spec)?.shift();
        assert.ok(response, `unexpected call for ${spec}`);
        const asked = prompts.get(spec) ?? [];
        asked.push(messages[messages.length - 1]?.content ?? '');
        prompts.set(spec, asked);
        return Promise.resolve({ text: response, usage: {}, toolCalls: [] });
      },
    }),
  });
  const answering = prompts.get(models[0]!)?.[0] ?? '';
  assert.equal(systems.length, 7);
  for (const system of systems) assertFormatAuthority(system);
  for (const evidence of ['best', models[0]!, models[1]!, cheap[10]!.id]) {
    assert.ok(answering.includes(evidence), `the counterparty answers without ${evidence}`);
  }
  assert.equal(artifact.offers.length, 3, 'the proposer may make multiple independent offers');
  assert.equal(artifact.offers[0]!.accepted, true);
  assert.equal(artifact.offers[0]!.proposerFallback, false);
  assert.equal(artifact.offers[0]!.responderFallback, false);
  assert.equal(artifact.offers[1]!.accepted, false);
  assert.equal(artifact.offers[1]!.proposerFallback, false);
  assert.equal(artifact.offers[1]!.responderFallback, false);
  assert.equal(artifact.offers[2]!.to, null);
  assert.equal(artifact.offers[2]!.proposerFallback, false);
  assert.equal(artifact.offers[2]!.responderFallback, null);
  assert.deepEqual(
    artifact.rosters.map((roster) => roster.entrant),
    [0, 1],
  );
  assert.equal(artifact.rosters[0]!.roster.at(-1)?.id, cheap[10]!.id);
  assert.equal(artifact.rosters[1]!.roster.at(-1)?.id, cheap[0]!.id);
  assert.deepEqual(
    readJsonlObjects(path.join(directory, 'window.jsonl')).map((row) => row.kind),
    ['offer', 'offer', 'offer', 'free_agency', 'free_agency'],
  );

  let replayCalls = 0;
  const replayState = createState();
  const replayed = await runTradeWindow(replayState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 2,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        replayCalls += 1;
        throw new Error('replay must not call providers');
      },
    }),
  });
  assert.equal(replayCalls, 0);
  assert.deepEqual(replayed, artifact);
  assert.deepEqual(replayState, liveState, 'ordered replay and live orchestration apply identical transitions');
});

test('offer artifacts distinguish exhausted parsing from deliberate and random decisions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-trade-fallbacks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = transactionState();
  state.models = ['test:responder', 'test:proposer'];
  const offer = {
    offer: {
      to: 0,
      give: state.rosters[1]![0]!.id,
      get: state.rosters[0]![0]!.id,
      message: 'One independent offer.',
    },
  };
  assert.notEqual(typeof parseTradeOffer(JSON.stringify(offer), state, 1), 'string');
  const calls = new Map<string, number>();
  const artifact = await runTradeWindow(state, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 1,
    makeTradeProvider: (spec) => ({
      complete(): Promise<Completion> {
        const call = (calls.get(spec) ?? 0) + 1;
        calls.set(spec, call);
        if (spec === 'test:proposer') {
          return Promise.resolve({
            text: JSON.stringify(call === 1 ? offer : { swaps: [] }),
            usage: {},
            toolCalls: [],
          });
        }
        return Promise.resolve({
          text: call <= 6 ? 'not json' : JSON.stringify({ swaps: [] }),
          usage: {},
          toolCalls: [],
        });
      },
    }),
  });

  assert.deepEqual(
    artifact.offers.map(({ from, accepted, proposerFallback, responderFallback }) => ({
      from,
      accepted,
      proposerFallback,
      responderFallback,
    })),
    [
      { from: 1, accepted: false, proposerFallback: false, responderFallback: true },
      { from: 0, accepted: null, proposerFallback: true, responderFallback: null },
    ],
  );
  assert.equal(artifact.offers[0]!.responseReasoning, '', 'fallback rejection invents no private rationale');
  assert.equal(artifact.offers[1]!.offerReasoning, '', 'fallback no-offer invents no private rationale');
});

test('trade-offer caps are enforced by direct, fresh-league, and stored-resume ingress', async (t) => {
  const directDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-trade-cap-direct-'));
  const leagueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-trade-cap-league-'));
  t.after(() => fs.rmSync(directDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(leagueDir, { recursive: true, force: true }));
  const invalid = MAX_TRADE_OFFERS + 1;
  await assert.rejects(
    runTradeWindow(transactionState(), {
      epochDir: directDir,
      psDir: defaultPsDir(),
      position: { afterWeek: 1, index: 0, count: 1 },
      tradesAllowed: invalid,
    }),
    /between 0 and 3/,
  );
  assert.throws(
    () => readValidatedTradeWindow(directDir, transactionState(), { afterWeek: 1, tradesAllowed: invalid }),
    /between 0 and 3/,
  );
  await assert.rejects(
    runDraftLeague(['random', 'random'], leagueDir, {
      recordsPath: path.join(leagueDir, 'results.jsonl'),
      seed: 7,
      transactions: [{ afterWeek: 1, tradesAllowed: invalid }],
    }),
    /between 0 and 3/,
  );

  await runDraftLeague(['random', 'random'], leagueDir, {
    recordsPath: path.join(leagueDir, 'results.jsonl'),
    seed: 7,
    draftOnly: true,
  });
  const configFile = path.join(leagueDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  config.draft_only = false;
  config.transactions = [{ after_week: 1, trades_allowed: invalid }];
  fs.writeFileSync(
    configFile,
    `${JSON.stringify(config)}
`,
  );
  await assert.rejects(
    runDraftLeague(['random', 'random'], leagueDir, {
      recordsPath: path.join(leagueDir, 'results.jsonl'),
      seed: 7,
      resume: true,
    }),
    /invalid transaction window/,
  );
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
    history: [],
  });
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const firstState = createState();
  const artifact = await runTradeWindow(firstState, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 2, index: 0, count: 1 },
    tradesAllowed: 0,
    makeTradeProvider: (spec) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        calls.push(spec);
        prompts.set(spec, `${system}\n${messages[0]?.content ?? ''}`);
        return Promise.resolve({ text: JSON.stringify(responses.get(spec)), usage: {}, toolCalls: [] });
      },
    }),
  });
  assert.deepEqual(artifact.order, [2, 1, 0]);
  assert.match(prompts.get(models[2]!) ?? '', /You are test:worst, a coach/);
  assertFormatAuthority(prompts.get(models[2]!) ?? '');
  assert.doesNotMatch(prompts.get(models[2]!) ?? '', /Best|Middle|Worst/);
  assert.deepEqual(calls, [models[2], models[1], models[0]]);
  assert.equal(firstState.rosters[1]![9]?.id, initial[2]![0]!.id, 'an earlier drop becomes available immediately');
  assert.ok(fs.existsSync(path.join(directory, 'window.json')));
  assert.equal(readJsonlObjects(path.join(directory, 'window.jsonl')).length, 3);

  let replayCalls = 0;
  const replayed = await runTradeWindow(createState(), {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 2, index: 0, count: 1 },
    tradesAllowed: 0,
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

test('drafters name their franchise only after every pick is complete', async (t) => {
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
      rosterPolicy: '- A test transaction window opens after week 2.',
      reasoningByModel: { 'fake:model': 'high' },
      makeDraftProvider: (_spec, _apiKey, reasoning) => {
        receivedReasoning = reasoning ?? '';
        return scriptedProvider(
          [
            'I will take {"pick": "not-a-mon", "team_name": "Nowhere Nidokings", "reasoning": "bad id", "notebook": "bad"}',
            '{"pick": "garchomp", "reasoning": "Best ground type available.", "notebook": "Build around Garchomp; add Fake Out and speed control."}',
            '{"pick": "incineroar", "reasoning": "Fake Out support.", "notebook": "Garchomp plus Incineroar; add speed control and redirection."}',
            '{"pick": "sinistcha", "reasoning": "Redirection.", "notebook": "Ground offense with pivoting and redirection; add speed control."}',
            '{"pick": "farigiraf", "reasoning": "Trick Room insurance.", "notebook": "Complete flexible Ground offense with priority denial and Trick Room."}',
            '{"team_name":"Route 210 Garchomps"}',
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
  assertFormatAuthority(String(rows[0]!.system));
  assert.match(String(rows[0]!.system), /test transaction window opens after week 2/);
  assert.doesNotMatch(String(rows[0]!.system), /franchise name|Shadow Cabinet|Drought Dodgers/i);

  const transcript = fs
    .readFileSync(path.join(logDir, 'draft.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(transcript[0]!.team_name, undefined);
  assert.equal(transcript[0]!.rationale, 'Best ground type available.');
  const names = readJsonlObjects(path.join(logDir, 'franchise-names.jsonl'));
  assert.equal(names.find((row) => row.entrant === 0)?.team_name, 'Route 210 Garchomps');
  const namingLog = readJsonlObjects(path.join(logDir, 'namer-0-fake-model.jsonl'));
  assert.match(String(namingLog[0]!.system), /The Shadow Cabinet/);
  assertFormatAuthority(String(namingLog[0]!.system));
  assert.match(String(namingLog[0]!.user), /Garchomp/);
  assert.match(String(namingLog[0]!.user), /Farigiraf/);

  let replayCalls = 0;
  const replayed = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(1),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          replayCalls += 1;
          throw new Error('completed picks and names must replay');
        },
      }),
    },
  );
  assert.equal(replayCalls, 0);
  assert.deepEqual(replayed, outcome, 'transcript replay reconstructs the live draft outcome exactly');
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
    const parsed = parsePick(JSON.stringify({ pick: id, reasoning: 'x', notebook: 'plan' }), legal, state, 0, [
      'fake:model',
      'fake:rival',
    ]);
    return typeof parsed === 'string' ? parsed : 'accepted';
  });

  assert.match(reasons[0]!, /is not a board id/);
  assert.match(reasons[1]!, /already drafted by fake:rival/);
  assert.doesNotMatch(reasons[1]!, /Rival Rotoms/);
  assert.match(reasons[2]!, /shares the species Garchomp with your Garchomp/);
  assert.equal(reasons[3], 'accepted', 'an affordable, untaken, unclashing pick is fine');

  state.budgets[0] = 12;
  const tight = legalPicks(state, 0);
  const denied = parsePick(JSON.stringify({ pick: 'basculegion', reasoning: 'x', notebook: 'plan' }), tight, state, 0);
  assert.match(String(denied), /costs 19, but you can spend at most \d+ points?/);
});

test('picks do not request a franchise name and franchise names normalize separately', () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  assert.notEqual(
    typeof parsePick('{"pick":"garchomp","notebook":"Build around Garchomp"}', legal, state, 0),
    'string',
  );
  assert.deepEqual(parseFranchiseName(JSON.stringify({ team_name: '  Prankster\n  Paradise  ' })), {
    teamName: 'Prankster Paradise',
  });
  assert.match(String(parseFranchiseName('{"team_name":""}')), /non-empty/);
});

test('a legal pick is not rejected when optional evidence is omitted', () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  const id = legal[0]?.id;
  assert.ok(id);
  const parsed = parsePick(JSON.stringify({ pick: id }), legal, state, 0);
  assert.notEqual(typeof parsed, 'string');
  if (typeof parsed !== 'string') {
    assert.equal(parsed.mon.id, id);
    assert.equal(parsed.reasoning, '');
    assert.equal(parsed.notebook, undefined);
    assert.deepEqual(parsed.evidence.supplied, { rationale: false, notebookUpdate: false });
  }
});

test('a pick may be written as the board id or the name shown beside it', () => {
  const state = freshState();
  const legal = legalPicks(state, 0);
  for (const spelling of ['lucario-mega', 'Mega Lucario', 'mega-lucario', 'MEGA LUCARIO']) {
    const parsed = parsePick(JSON.stringify({ pick: spelling, reasoning: 'x', notebook: 'plan' }), legal, state, 0);
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
          if (options?.tools?.length) offered = options.tools.map((tool) => tool.name);
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
  assert.match(secondPrompt, /used the whole \d+-token budget before naming a pick/);
  assert.equal(outcome.picks[0]!.fallback, false, 'the model still gets to make its own pick');

  const rows = fs
    .readFileSync(path.join(logDir, 'drafter-0-fake-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.match(String(rows[0]!.error), /whole 65536-token budget before naming a pick/);
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
      ['openrouter:google/gemini-test', 'random'],
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
  const backoffs: number[] = [];
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(5),
      sleep: (ms) => {
        backoffs.push(ms);
        return Promise.resolve();
      },
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
  assert.deepEqual(backoffs, [2_000, 4_000, 8_000]);
});

test('a pick written only in the reasoning channel is salvaged without another attempt', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-salvage-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const outcome = await runDraft(
    ['fake:model', 'random'],
    { ...BOARD, picks: 4 },
    {
      logDir,
      rng: seededRng(4),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
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
  const firstPickAttempts = readJsonlObjects(path.join(logDir, 'drafter-0-fake-model.jsonl')).filter(
    (row) => row.pick === 1,
  );
  assert.equal(firstPickAttempts.length, 1, 'the first pick salvages in one call');
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
    ['openrouter:google/gemini-test', 'random'],
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
    `${stored.map((row) => JSON.stringify(row)).join('\n')}\n{"pick":`,
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

test('an explicit empty draft notebook survives transcript replay', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-empty-notebook-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const replies: Record<string, string[]> = {
    'fake:a': [
      '{"pick":"garchomp","reasoning":"Start here.","notebook":"Keep this until the final pick."}',
      '{"pick":"incineroar","reasoning":"Roster complete.","notebook":""}',
      '{"team_name":"Empty Notes"}',
    ],
    'fake:b': [
      '{"pick":"sinistcha","reasoning":"Support.","notebook":"Tea mode."}',
      '{"pick":"farigiraf","reasoning":"Speed control.","notebook":"Room mode."}',
      '{"team_name":"Room Notes"}',
    ],
  };
  const calls = new Map<string, number>();
  const first = await runDraft(
    ['fake:a', 'fake:b'],
    { ...BOARD, picks: 2 },
    {
      logDir,
      rng: seededRng(12),
      makeDraftProvider: (spec) => ({
        complete(): Promise<Completion> {
          const call = calls.get(spec) ?? 0;
          calls.set(spec, call + 1);
          return Promise.resolve({ text: replies[spec]![call]!, usage: {}, toolCalls: [] });
        },
      }),
    },
  );
  assert.equal(first.notebooks[0], '');
  const transcript = readJsonlObjects(path.join(logDir, 'draft.jsonl'));
  const cleared = transcript.find((row) => row.model === 'fake:a' && row.mon === 'incineroar')!;
  assert.equal(cleared.notebook, '');
  assert.deepEqual(cleared.evidence_supplied, { rationale: true, notebook_update: true });

  let replayCalls = 0;
  const replayed = await runDraft(
    ['fake:a', 'fake:b'],
    { ...BOARD, picks: 2 },
    {
      logDir,
      rng: seededRng(12),
      makeDraftProvider: () => ({
        complete(): Promise<Completion> {
          replayCalls += 1;
          throw new Error('completed draft must replay without provider calls');
        },
      }),
    },
  );
  assert.equal(replayCalls, 0);
  assert.equal(replayed.notebooks[0], '', 'replay must not resurrect the earlier non-empty notebook');
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
    franchiseName: 'Test Tauros',
    roster: TEAMBUILD_ROSTER,
    opponentRoster: TEAMBUILD_ROSTER.slice(0, 10),
    draftNote: 'Flexible Ground offense with two speed-control modes.',
    playoffContext: [],
    format: BOARD.format,
    ...overrides,
  };
}

const GOOD_TEAM = legalTeamResponse('Rain beats their sun core, so Pelipper leads with Charizard held back.');

test('malformed set shapes and EV values are compliance rejections before a canonical noted team', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-compliance-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const malformed = JSON.parse(GOOD_TEAM) as { sets: unknown[] };
  malformed.sets[0] = null;
  const stringEv = JSON.parse(GOOD_TEAM) as { sets: Array<{ evs: Record<string, unknown> }> };
  stringEv.sets[0]!.evs.hp = '2';
  const floatEv = JSON.parse(GOOD_TEAM) as { sets: Array<{ evs: Record<string, unknown> }> };
  floatEv.sets[0]!.evs.atk = 1.5;
  const negativeEv = JSON.parse(GOOD_TEAM) as { sets: Array<{ evs: Record<string, unknown> }> };
  negativeEv.sets[0]!.evs.def = -1;
  const noted = JSON.parse(GOOD_TEAM) as { sets: Array<Record<string, unknown>> };
  noted.sets[0]!.note = 'Fast Ground pressure and spread damage.';

  const result = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(19),
    makeTeambuildProvider: () =>
      scriptedProvider([
        JSON.stringify(malformed),
        JSON.stringify(stringEv),
        JSON.stringify(floatEv),
        JSON.stringify(negativeEv),
        JSON.stringify(noted),
      ]),
  });

  assert.equal(result.view.attempts, 5);
  assert.equal(result.view.sets[0]!.note, 'Fast Ground pressure and spread damage.');
  assert.ok(result.view.sets.every((set) => !set.repaired));
  assert.equal(result.artifact.validation.repaired, false);
  assert.equal(result.artifact.action?.sets[0]?.note, 'Fast Ground pressure and spread damage.');
  const attempts = readJsonlObjects(path.join(logDir, 'series-1-e0-fake-model.jsonl'));
  assert.equal(attempts.length, 5);
  assert.match(String(attempts[0]!.error), /set 1 must be an object/);
  for (const attempt of attempts.slice(1, 4)) {
    assert.match(String(attempt.error), /finite, safe, non-negative integer/);
  }
  const stored = readJsonlObjects(path.join(logDir, 'teambuild.jsonl'))[0]!;
  const artifact = stored.artifact as Record<string, unknown>;
  const action = artifact.action as Record<string, unknown>;
  assert.equal(action.packed, result.packed);
  assert.deepEqual(Object.keys(stored), ['artifact']);
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

test('canonical packing delegates punctuation handling to Showdown Teams.pack', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-showdown-pack-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const team = JSON.parse(GOOD_TEAM) as { sets: Array<{ moves: string[] }> };
  const { packed } = await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(21),
    makeTeambuildProvider: () => scriptedProvider([JSON.stringify(team)]),
  });

  assert.match(packed, /LifeOrb/);
  assert.doesNotMatch(packed, /Life Orb/);
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

test('the teambuild prompt uses coach identities and never franchise names', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-prompt-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = '';
  await runTeambuild(teambuildRequest({ stage: 'playoff', playoffContext: ['Week 1: beat fake:rival 2-0'] }), {
    logDir,
    rng: seededRng(1),
    makeTeambuildProvider: () => ({
      complete(system, messages): Promise<Completion> {
        prompt = `${system}\n${messages[0]!.content ?? ''}`;
        return Promise.resolve({ text: GOOD_TEAM, usage: {}, toolCalls: [] });
      },
    }),
  });
  assert.match(prompt, /team sheets are open/, 'the prompt states the configured open-sheet policy');
  assertFormatAuthority(prompt);
  assert.ok(prompt.includes('YOUR ROSTER'), 'the model sees its roster');
  assert.ok(prompt.includes('fake:rival'), 'and which coach it is playing');
  assert.doesNotMatch(prompt, /Test Tauros|Rival Rotoms/);
  assert.ok(prompt.includes('Flexible Ground offense'), 'and its final private draft note');
  assert.ok(prompt.includes('Week 1: beat fake:rival 2-0'), 'playoff builders receive earlier match context');
  assert.ok(prompt.includes('MUST hold Charizardite Y'), 'the mega lock is stated');
  assert.match(
    prompt,
    /set "ability" to one of Blaze or Solar Power, NOT its Mega ability/,
    'a Mega entry registers its pre-Mega ability, which models otherwise get wrong',
  );
  assert.ok(prompt.includes('cannot hold a Mega Stone'), 'and so is its inverse');
  assert.ok(!/moves:.*\bBounce\b/.test(prompt), 'the movepool must not offer moves the validator rejects');
});

test('closed-sheet teambuilding states and binds the hidden-information policy', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-closed-sheets-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let system = '';
  const result = await runTeambuild(teambuildRequest({ sheetPolicy: 'closed' }), {
    logDir,
    rng: seededRng(20),
    makeTeambuildProvider: () => ({
      complete(prompt): Promise<Completion> {
        system = prompt;
        return Promise.resolve({ text: GOOD_TEAM, usage: {}, toolCalls: [] });
      },
    }),
  });

  assert.match(system, /team sheets are closed/);
  assert.doesNotMatch(system, /team sheets are open/);
  assert.equal(result.artifact.task.sheetPolicy, 'closed');
  assert.equal(result.artifact.scaffold, teambuildScaffoldRevision('closed'));
  assert.notEqual(teambuildScaffoldRevision('closed'), teambuildScaffoldRevision('open'));
});

test('round-robin teambuilds receive the coach’s season so far and the rebuild notice', async (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-teambuild-season-context-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let prompt = '';
  await runTeambuild(
    teambuildRequest({ playoffContext: ['Round-robin week 1: beat fake:other 2-1; registered Garchomp'] }),
    {
      logDir,
      rng: seededRng(1),
      makeTeambuildProvider: () =>
        scriptedProvider([GOOD_TEAM], (messages) => {
          prompt = messages[0]!.content ?? '';
        }),
    },
  );
  assert.match(prompt, /YOUR SEASON SO FAR[^\n]*\n- Round-robin week 1: beat fake:other 2-1; registered Garchomp/);
  assert.match(prompt, /Every coach builds a new six for every matchup/);
  let blank = '';
  await runTeambuild(teambuildRequest(), {
    logDir,
    rng: seededRng(2),
    makeTeambuildProvider: () =>
      scriptedProvider([GOOD_TEAM], (messages) => {
        blank = messages[0]!.content ?? '';
      }),
  });
  assert.doesNotMatch(blank, /YOUR SEASON SO FAR/, 'a first build has no season to show');
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
  const pending = runTeambuild(teambuildRequest({ model: 'openrouter:google/gemini-test' }), {
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
  assert.deepEqual(
    fs
      .readdirSync(path.join(directory, 'reviews'))
      .filter((file) => file.endsWith('.jsonl'))
      .sort(),
    ['week-1.jsonl', 'week-2.jsonl', 'week-3.jsonl'],
    'a parallel league reviews at each window and the end of the round robin',
  );
  for (const row of rows) {
    assert.equal(row.mode, 'draft');
    assert.equal(row.protocol_version, DRAFT_PROTOCOL_VERSION);
    assert.equal(row.board, 'regmb-202607');
    assert.equal(row.draft_scaffold, draftScaffoldRevision());
    assert.equal(row.teambuild_scaffold, teambuildScaffoldRevision());
    assert.equal(row.window_scaffold, tradeWindowScaffoldRevision());
    assert.deepEqual(row.transactions, [
      { after_week: 1, trades_allowed: 1 },
      { after_week: 2, trades_allowed: 1 },
      { after_week: 3, trades_allowed: 1 },
    ]);
    assert.equal(
      row.roster_version,
      row.stage === 'playoff' ? 3 : Number(row.round) - 1,
      'each series binds the roster version it was built on',
    );
  }

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.mode, 'draft');
  assert.equal(config.weeks, 3);
  assert.equal(config.sequential_weeks, false, 'round-robin series run concurrently by default');
  assert.equal(config.closed_sheets, false, 'the stock format keeps its open team sheets by default');
  assert.deepEqual(
    config.transactions,
    [
      { after_week: 1, trades_allowed: 1 },
      { after_week: 2, trades_allowed: 1 },
      { after_week: 3, trades_allowed: 1 },
    ],
    'a window after each of the first three weeks is the default',
  );
  assert.deepEqual(config.draft_notes, ['', '', '', '']);
  const rosters = config.rosters as string[][];
  assert.equal(rosters.length, 4);
  for (const roster of rosters) assert.equal(roster.length, 10);
  assert.equal(new Set(rosters.flat()).size, 40, 'no entry is drafted twice');

  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'rosters.json'), 'utf8')) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    stored.map((entry) => entry.entrant),
    [0, 1, 2, 3],
  );
  for (const entry of stored) assert.ok((entry.spent as number) <= 100, 'no coach overspends');
  const window = JSON.parse(
    fs.readFileSync(path.join(directory, 'transactions', 'after-week-3', 'window.json'), 'utf8'),
  ) as {
    after_week: number;
    order: number[];
    offers: Array<{ to: number | null; proposerFallback: boolean; responderFallback: boolean | null }>;
    decisions: Array<{ swaps: unknown[] }>;
    rosters: Array<{ entrant: number }>;
  };
  assert.equal(window.after_week, 3);
  assert.equal(window.decisions.length, 4);
  assert.equal(window.offers.length, 4);
  assert.ok(
    window.offers.every(
      (offer) => offer.to === null && offer.proposerFallback === false && offer.responderFallback === null,
    ),
  );
  assert.ok(window.decisions.every((decision) => decision.swaps.length === 0));
  assert.deepEqual(
    window.rosters.map((roster) => roster.entrant),
    [0, 1, 2, 3],
  );
  assert.equal(window.order.length, 4);

  const teambuilds = fs
    .readFileSync(path.join(directory, 'teambuild', 'teambuild.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(teambuilds.length, rows.length * 2, 'both coaches build before every series');
  for (const build of teambuilds) {
    const artifact = build.artifact as Record<string, unknown>;
    const action = artifact.action as Record<string, unknown>;
    assert.equal(artifact.status, 'valid');
    assert.equal((action.selected as string[]).length, 6);
    assert.deepEqual(Object.keys(build), ['artifact']);
  }
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
  assert.equal(loadSeriesRecords(recordsPath).length, rows.length);
  const replayEvents: DraftLeagueEvent[] = [];
  const resumed = await runDraftLeague(['random', 'random', 'random', 'random'], directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    resume: true,
    onEvent: (event) => replayEvents.push(event),
  });
  assert.deepEqual(
    resumed.map((row) => row.series_id),
    rows.map((row) => row.series_id),
    'a completed final is adopted only after both exact constructions and series identity replay',
  );
  const liveBracket = events
    .filter((event): event is Extract<DraftLeagueEvent, { type: 'bracket' }> => event.type === 'bracket')
    .at(-1)!.bracket;
  const replayBracket = replayEvents.find(
    (event): event is Extract<DraftLeagueEvent, { type: 'bracket' }> => event.type === 'bracket',
  )!.bracket;
  assert.deepEqual(replayBracket, liveBracket, 'live playoffs and stored adoption produce the same bracket');
});

test('a four-seed draft playoff advances and replays the same exact bracket', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-playoff-bracket-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = Array.from({ length: 5 }, () => 'random');
  const liveEvents: DraftLeagueEvent[] = [];
  const rows = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 17,
    concurrency: 4,
    transactions: null,
    onEvent: (event) => liveEvents.push(event),
  });
  assert.equal(rows.filter((row) => row.stage === 'playoff').length, 3);
  const liveBracket = liveEvents
    .filter((event): event is Extract<DraftLeagueEvent, { type: 'bracket' }> => event.type === 'bracket')
    .at(-1)!.bracket;
  assert.deepEqual(
    liveBracket.rounds[1]![0]!.slots,
    liveBracket.rounds[0]!.map((match) => match.winner),
    'each semifinal advances only into its corresponding final slot',
  );

  const replayEvents: DraftLeagueEvent[] = [];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 17,
    concurrency: 4,
    transactions: null,
    resume: true,
    onEvent: (event) => replayEvents.push(event),
  });
  const replayBracket = replayEvents.find(
    (event): event is Extract<DraftLeagueEvent, { type: 'bracket' }> => event.type === 'bracket',
  )!.bracket;
  assert.deepEqual(replayBracket, liveBracket);
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
  assert.ok(!fs.existsSync(path.join(directory, 'transactions')), 'pausing before the barrier does not open it');

  const resumed = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 11,
    concurrency: 2,
    resume: true,
  });
  assert.equal(resumed.length, 6 + 1, 'the resumed league finishes the round robin and the final');
  assert.equal(new Set(resumed.map((row) => row.series_index)).size, 7, 'no series repeats');
  assert.equal(loadSeriesRecords(recordsPath).length, 7, 'each series is recorded exactly once');
  const final = resumed[resumed.length - 1]!;
  assert.equal(final.stage, 'playoff');
  assert.ok(final.advanced, 'the resumed league crowns a champion');
  for (const week of [1, 2, 3]) {
    assert.ok(
      fs.existsSync(path.join(directory, 'transactions', `after-week-${week}`, 'window.json')),
      `resume completes the week-${week} window`,
    );
  }
});

test('the real league window updates the outer roster used by later construction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-window-outer-roster-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = ['random', 'random'];
  await runDraftLeague(models, directory, {
    recordsPath,
    seed: 41,
    concurrency: 1,
    throughWeek: 1,
    transactions: [{ afterWeek: 1, tradesAllowed: 0 }],
  });

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as {
    entrants: string[];
    team_names: string[];
    rosters: string[][];
    draft_notes: string[];
  };
  const rosters = config.rosters.map((ids) => ids.map((id) => BOARD.mons.find((candidate) => candidate.id === id)!));
  const result = loadSeriesRecords(recordsPath)[0]!;
  const [a, b] = roundRobinWeeks(2)[0]![0]!;
  const score = result.score as Record<'p1' | 'p2', number>;
  const table = [
    {
      entrant: a,
      w: result.winner_side === 'p1' ? 1 : 0,
      l: result.winner_side === 'p2' ? 1 : 0,
      gw: score.p1,
      gl: score.p2,
    },
    {
      entrant: b,
      w: result.winner_side === 'p2' ? 1 : 0,
      l: result.winner_side === 'p1' ? 1 : 0,
      gw: score.p2,
      gl: score.p1,
    },
  ].sort(
    (first, second) =>
      second.w - first.w ||
      second.gw - second.gl - (first.gw - first.gl) ||
      second.gw - first.gw ||
      first.entrant - second.entrant,
  );
  const first = table.at(-1)!.entrant;
  const state: TradeWindowState = {
    board: BOARD,
    models: config.entrants,
    teamNames: config.team_names,
    rosters,
    budgets: rosters.map((roster) => BOARD.budget - roster.reduce((sum, candidate) => sum + candidate.cost, 0)),
    notebooks: config.draft_notes,
    standings: table,
    results: models.map(() => []),
    reflections: models.map(() => []),
    history: [],
  };
  const owned = new Set(rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let replayed:
    | {
        drop: string;
        add: string;
        notebook: string;
        reasoning: string;
        supplied: { rationale: boolean; notebookUpdate: boolean };
      }
    | undefined;
  for (const drop of rosters[first]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      const parsed = parseTradeDecision(
        JSON.stringify({ swaps: [{ drop: drop.id, add: add.id }], notebook: 'replayed roster plan' }),
        state,
        first,
      );
      if (typeof parsed === 'string') continue;
      replayed = {
        drop: parsed.swaps[0]!.drop,
        add: parsed.swaps[0]!.add,
        notebook: parsed.notebook,
        reasoning: parsed.reasoning,
        supplied: parsed.evidence.supplied,
      };
      break;
    }
    if (replayed) break;
  }
  assert.ok(replayed, 'the board must offer one legal post-draft swap');
  await runWeeklyReview(
    {
      board: BOARD,
      models: config.entrants,
      week: 1,
      weeks: 1,
      rosterVersion: 0,
      rosters,
      notebooks: [...config.draft_notes],
      standings: config.entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 })),
      series: [],
      period: [],
      schedule: [],
      transactions: [],
      nextWindowWeek: 1,
    },
    { runDir: directory, psDir: defaultPsDir() },
  );
  const epochDir = path.join(directory, 'transactions', 'after-week-1');
  fs.mkdirSync(epochDir, { recursive: true });
  fs.writeFileSync(
    path.join(epochDir, 'window.jsonl'),
    `${canonicalJson({
      kind: 'free_agency',
      entrant: first,
      model: config.entrants[first],
      swaps: [{ drop: replayed.drop, add: replayed.add }],
      reasoning: replayed.reasoning,
      notebook: replayed.notebook,
      evidenceSupplied: replayed.supplied,
      fallback: false,
      timestamp: new Date(0).toISOString(),
    })}\n`,
  );
  await runTradeWindow(state, {
    epochDir,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
  });

  const teambuildLog = path.join(directory, 'teambuild', 'teambuild.jsonl');
  const donor = structuredClone(
    readJsonlObjects(teambuildLog).find((row) => {
      const artifact = row.artifact as { task?: { provenance?: Record<string, unknown> } } | undefined;
      return artifact?.task?.provenance?.seriesIndex === 0 && artifact.task.provenance.entrant === first;
    })!,
  ) as Record<string, unknown>;
  const donorArtifact = donor.artifact as {
    task: { objective: { stage: string }; provenance: Record<string, unknown> };
  };
  donorArtifact.task.objective.stage = 'playoff';
  donorArtifact.task.provenance.seriesIndex = 1;
  donorArtifact.task.provenance.opponent = first === 0 ? 1 : 0;
  fs.appendFileSync(teambuildLog, `${JSON.stringify(donor)}\n`);

  await runDraftLeague(models, directory, { recordsPath, seed: 41, concurrency: 1, resume: true });
  const postWindowBuilds = readJsonlObjects(teambuildLog).filter((row) => {
    const artifact = row.artifact as { task?: { provenance?: Record<string, unknown> } } | undefined;
    return artifact?.task?.provenance?.seriesIndex === 1 && artifact.task.provenance.entrant === first;
  });
  assert.equal(postWindowBuilds.length, 2, 'a stored build bound to the dropped candidate is rebuilt');
  const playoffBuild = postWindowBuilds.at(-1)!;
  const artifact = playoffBuild.artifact as { task: { constraint: { candidates: Array<{ id: string }> } } };
  const candidates = artifact.task.constraint.candidates.map((candidate) => candidate.id);
  assert.ok(candidates.includes(replayed.add));
  assert.ok(!candidates.includes(replayed.drop));
});

test('durable journal and atomic final-artifact faults retry provider-free and commit once', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-window-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = transactionState();
  state.models = ['random', 'test:coach'];
  const initial = structuredClone(state);
  const before = JSON.stringify(state);
  const rosterReference = state.rosters;
  const budgetReference = state.budgets;
  const notebookReference = state.notebooks;
  const owned = new Set(state.rosters.flatMap((roster) => roster.map((candidate) => candidate.id)));
  let swap: { drop: string; add: string } | undefined;
  for (const drop of state.rosters[1]!) {
    for (const add of BOARD.mons) {
      if (owned.has(add.id)) continue;
      const parsed = parseTradeDecision(JSON.stringify({ swaps: [{ drop: drop.id, add: add.id }] }), state, 1);
      if (typeof parsed === 'string' || !parsed.swaps[0]) continue;
      swap = parsed.swaps[0];
      break;
    }
    if (swap) break;
  }
  assert.ok(swap, 'fixture needs one legal durable swap');

  const transcript = path.join(directory, 'window.jsonl');
  const originalAppend = fs.appendFileSync;
  let completions = 0;
  let injected = false;
  fs.appendFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const result = (originalAppend as (...values: unknown[]) => unknown)(file, ...args);
    if (!injected && String(file) === transcript) {
      injected = true;
      throw new Error('fault after durable append');
    }
    return result;
  }) as typeof fs.appendFileSync;
  try {
    await assert.rejects(
      runTradeWindow(state, {
        epochDir: directory,
        psDir: defaultPsDir(),
        position: { afterWeek: 1, index: 0, count: 1 },
        tradesAllowed: 0,
        makeTradeProvider: () => ({
          complete(): Promise<Completion> {
            completions += 1;
            return Promise.resolve({
              text: JSON.stringify({ swaps: [swap], notebook: 'durable plan' }),
              usage: {},
              toolCalls: [],
            });
          },
        }),
      }),
      /fault after durable append/,
    );
  } finally {
    fs.appendFileSync = originalAppend;
  }
  assert.equal(completions, 1);
  assert.equal(JSON.stringify(state), before, 'durability failure does not mutate caller state');
  assert.equal(fs.readFileSync(transcript, 'utf8').split('\n').length, 2, 'the first row reached durable storage');

  const artifactFile = path.join(directory, 'window.json');
  const originalRename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
    const renamed = originalRename(source, destination);
    if (String(destination) === artifactFile) throw new Error('fault after physical artifact rename');
    return renamed;
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(
      runTradeWindow(state, {
        epochDir: directory,
        psDir: defaultPsDir(),
        position: { afterWeek: 1, index: 0, count: 1 },
        tradesAllowed: 0,
        makeTradeProvider: () => ({
          complete(): Promise<Completion> {
            completions += 1;
            throw new Error('durable decisions must not call providers');
          },
        }),
      }),
      /fault after physical artifact rename/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  const journal = fs.readFileSync(transcript, 'utf8');
  assert.equal(journal.split('\n').length, 3);
  assert.ok(journal.endsWith('\n'));
  assert.ok(fs.existsSync(artifactFile), 'the physical artifact survived the interrupted caller');
  assert.equal(JSON.stringify(state), before, 'finalization failure remains caller-atomic');
  assert.equal(completions, 1, 'the durable prefix was replayed');

  const artifact = await runTradeWindow(state, {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 0,
    makeTradeProvider: () => ({
      complete(): Promise<Completion> {
        completions += 1;
        throw new Error('complete durable journal must not call providers');
      },
    }),
  });
  assert.equal(completions, 1);
  assert.equal(fs.readFileSync(transcript, 'utf8'), journal, 'retry does not append committed decisions twice');
  assert.strictEqual(state.rosters, rosterReference);
  assert.strictEqual(state.budgets, budgetReference);
  assert.strictEqual(state.notebooks, notebookReference);
  assert.equal(state.rosters[1]!.filter((candidate) => candidate.id === swap.add).length, 1);
  assert.ok(!state.rosters[1]!.some((candidate) => candidate.id === swap.drop));
  assert.deepEqual(state.notebooks, ['', 'durable plan']);
  assert.deepEqual(readValidatedTradeWindow(directory, initial, { afterWeek: 1, tradesAllowed: 0 }), artifact);
});

test('current teambuild provenance counts as post-window transaction-barrier evidence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-window-teambuild-barrier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = ['random', 'random'];
  await runDraftLeague(models, directory, { recordsPath, seed: 79, concurrency: 1, throughWeek: 1 });
  const teambuildFile = path.join(directory, 'teambuild', 'teambuild.jsonl');
  const postWindow = structuredClone(readJsonlObjects(teambuildFile)[0]!);
  const artifact = postWindow.artifact as {
    task: { objective: { stage: string }; provenance: { seriesIndex: number; opponent: number } };
  };
  artifact.task.objective.stage = 'playoff';
  artifact.task.provenance.seriesIndex = 1;
  artifact.task.provenance.opponent = 1;
  fs.appendFileSync(
    teambuildFile,
    `${JSON.stringify(postWindow)}
`,
  );

  await assert.rejects(
    runDraftLeague(models, directory, { recordsPath, seed: 79, concurrency: 1, resume: true }),
    /review barrier but lacks a complete review: teambuild\/teambuild.jsonl series 1/,
  );
});

test('committed overlays fail closed when tampered or missing past the transaction barrier', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-window-barrier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  await runDraftLeague(['random', 'random'], directory, { recordsPath, seed: 73, concurrency: 1 });
  const artifactFile = path.join(directory, 'transactions', 'after-week-1', 'window.json');
  const original = fs.readFileSync(artifactFile, 'utf8');
  const artifact = JSON.parse(original) as { rosters: Array<{ spent: number }> };
  artifact.rosters[0]!.spent += 1;
  fs.writeFileSync(artifactFile, `${JSON.stringify(artifact)}\n`);
  await assert.rejects(
    runDraftLeague(['random', 'random'], directory, { recordsPath, seed: 73, concurrency: 1, resume: true }),
    /authoritative ordered replay/,
  );

  fs.writeFileSync(artifactFile, original);
  fs.rmSync(artifactFile);
  await assert.rejects(
    runDraftLeague(['random', 'random'], directory, { recordsPath, seed: 73, concurrency: 1, resume: true }),
    /transaction barrier but lacks authoritative window artifacts/,
  );
  assert.ok(!fs.existsSync(artifactFile), 'resume does not regenerate a missing committed overlay');
});

test('transaction replay enforces one current schema, privacy shape, and phase order', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-window-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await runTradeWindow(transactionState(), {
    epochDir: directory,
    psDir: defaultPsDir(),
    position: { afterWeek: 1, index: 0, count: 1 },
    tradesAllowed: 1,
  });
  const transcript = path.join(directory, 'window.jsonl');
  const artifactFile = path.join(directory, 'window.json');
  const journal = fs.readFileSync(transcript, 'utf8');
  const artifact = fs.readFileSync(artifactFile, 'utf8');
  const lines = journal.slice(0, -1).split('\n');
  const scenarios: Array<{ name: string; write: () => void; error: RegExp }> = [
    {
      name: 'blank physical line',
      write: () => fs.writeFileSync(transcript, `\n${journal}`),
      error: /line 1 must be a nonblank JSON object/,
    },
    {
      name: 'missing terminal newline',
      write: () => fs.writeFileSync(transcript, journal.slice(0, -1)),
      error: /must be nonblank and end with a newline/,
    },
    {
      name: 'noncanonical duplicate key',
      write: () =>
        fs.writeFileSync(
          transcript,
          `${lines[0]!.replace('"kind":"offer"', '"kind":"ignored","kind":"offer"')}\n${lines.slice(1).join('\n')}\n`,
        ),
      error: /line 1 is not canonical JSON/,
    },
    {
      name: 'no-offer private responder field',
      write: () => {
        const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        rows[0]!.responseNotebook = 'not applicable';
        fs.writeFileSync(transcript, `${rows.map(canonicalJson).join('\n')}\n`);
      },
      error: /offer row must have exactly the current schema keys/,
    },
    {
      name: 'interleaved phase',
      write: () => fs.writeFileSync(transcript, `${[lines[0], lines[2], lines[1], lines[3]].join('\n')}\n`),
      error: /interleaves an offer after free agency began/,
    },
    {
      name: 'incomplete committed log',
      write: () => fs.writeFileSync(transcript, `${lines.slice(0, -1).join('\n')}\n`),
      error: /ordered log is incomplete/,
    },
    {
      name: 'missing current artifact field',
      write: () => {
        const parsed = JSON.parse(artifact) as Record<string, unknown>;
        delete parsed.offers;
        fs.writeFileSync(artifactFile, `${JSON.stringify(parsed)}\n`);
      },
      error: /is not a complete transaction artifact/,
    },
  ];
  for (const scenario of scenarios) {
    fs.writeFileSync(transcript, journal);
    fs.writeFileSync(artifactFile, artifact);
    scenario.write();
    assert.throws(
      () => readValidatedTradeWindow(directory, transactionState(), { afterWeek: 1, tradesAllowed: 1 }),
      scenario.error,
      scenario.name,
    );
  }
});

test('season resume requires canonical stored series evidence before standings and bracket adoption', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-season-fold-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  await runDraftLeague(['random', 'random'], directory, { recordsPath, seed: 29, concurrency: 1 });
  const original = fs
    .readFileSync(recordsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const roundRobin = original.findIndex((row) => row.stage === 'roundrobin');
  const playoff = original.findIndex((row) => row.stage === 'playoff');
  assert.ok(roundRobin >= 0 && playoff >= 0);

  const inventedTiebreak = structuredClone(original);
  const playoffRow = inventedTiebreak[playoff]!;
  const playoffIndex = Number(playoffRow.series_index);
  const regulationSeeds = seriesEntropy(seededRng(`29:series:${playoffIndex}`)).gameSeeds;
  const tiedRegulation = regulationSeeds.map((gameSeed, index) => ({
    number: index + 1,
    winner: null,
    winner_side: null,
    turns: 1,
    seed: gameSeed,
  }));
  const tiebreakSeed = foldSeriesGames(regulationSeeds, tiedRegulation, { requireWinner: true }).nextSeed!;
  const winnerSide = playoffRow.winner_side as 'p1' | 'p2';
  const players = playoffRow.players as Record<'p1' | 'p2', string>;
  playoffRow.games = [
    ...tiedRegulation,
    { number: 4, winner: players[winnerSide], winner_side: winnerSide, turns: 1, seed: tiebreakSeed },
  ];
  playoffRow.score = winnerSide === 'p1' ? { p1: 1, p2: 0 } : { p1: 0, p2: 1 };
  playoffRow.winner = players[winnerSide];
  playoffRow.turns = 4;
  fs.writeFileSync(recordsPath, `${inventedTiebreak.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await assert.rejects(
    runDraftLeague(['random', 'random'], directory, {
      recordsPath,
      seed: 29,
      concurrency: 1,
      resume: true,
    }),
    /canonical completed series evidence/,
    'a fourth playoff game invented only in results.jsonl is not stored series evidence',
  );

  const scenarios: Array<{ name: string; mutate: (rows: Array<Record<string, unknown>>) => void; error: RegExp }> = [
    {
      name: 'Bo3 cardinality',
      mutate: (rows) => {
        rows[roundRobin]!.games = [];
      },
      error: /canonical completed series evidence/,
    },
    {
      name: 'players',
      mutate: (rows) => {
        rows[playoff]!.players = { p1: 'forged', p2: 'random' };
      },
      error: /canonical completed series evidence/,
    },
    {
      name: 'seed',
      mutate: (rows) => {
        const games = rows[roundRobin]!.games as Array<Record<string, unknown>>;
        games[0]!.seed = [1, 1, 1, 1];
      },
      error: /canonical completed series evidence/,
    },
    {
      name: 'folded score',
      mutate: (rows) => {
        rows[roundRobin]!.score = { p1: 9, p2: 0 };
      },
      error: /canonical completed series evidence/,
    },
    {
      name: 'pre-window prefix',
      mutate: (rows) => {
        const later = rows[playoff]!;
        const prefix = rows[roundRobin]!;
        rows.splice(0, rows.length, later, prefix);
      },
      error: /crosses the transaction barrier before the exact pre-window result prefix/,
    },
  ];
  for (const scenario of scenarios) {
    const rows = structuredClone(original);
    scenario.mutate(rows);
    fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    await assert.rejects(
      runDraftLeague(['random', 'random'], directory, {
        recordsPath,
        seed: 29,
        concurrency: 1,
        resume: true,
      }),
      scenario.error,
      scenario.name,
    );
  }
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
  assert.deepEqual(
    config.transactions,
    [{ after_week: 1, trades_allowed: 1 }],
    'short leagues keep only the default windows that fit their round robin',
  );
  for (const row of rows) assert.equal(row.closed_sheets, true, 'series records carry the sheet rule');
  const builds = readJsonlObjects(path.join(directory, 'teambuild', 'teambuild.jsonl'));
  for (const build of builds) {
    const artifact = build.artifact as Record<string, unknown>;
    const task = artifact.task as Record<string, unknown>;
    assert.equal(task.sheetPolicy, 'closed');
    assert.equal(artifact.scaffold, teambuildScaffoldRevision('closed'));
  }
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
  assert.equal(config.transactions, null, 'a league that plays no games holds no transaction window');
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
  assert.equal(promoted.draft_only, false, 'a resumed draft-only run is a season');
  assert.deepEqual(
    promoted.transactions,
    [{ after_week: 1, trades_allowed: 1 }],
    'the resumed season chooses a schedule like a fresh one',
  );
  assert.equal(promoted.draft_scaffold, config.draft_scaffold, 'a resume keeps the draft it already ran on record');
  assert.ok(
    fs.existsSync(path.join(directory, 'transactions', 'after-week-1', 'window.json')),
    'the chosen window opens',
  );
  assert.equal(played[0]!.stage, 'roundrobin');
  assert.equal(played[1]!.stage, 'playoff');

  const contaminated = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-only-evidence-'));
  t.after(() => fs.rmSync(contaminated, { recursive: true, force: true }));
  const contaminatedRecords = path.join(contaminated, 'results.jsonl');
  await runDraftLeague(['random', 'random'], contaminated, {
    recordsPath: contaminatedRecords,
    seed: 5,
    draftOnly: true,
  });
  fs.writeFileSync(contaminatedRecords, `${JSON.stringify({ ...played[0], run_id: path.basename(contaminated) })}\n`);
  for (const relative of ['teambuild/teambuild.jsonl', 'coaching.jsonl', 'season.jsonl']) {
    fs.mkdirSync(path.dirname(path.join(contaminated, relative)), { recursive: true });
    fs.writeFileSync(path.join(contaminated, relative), '{}\n');
  }
  fs.mkdirSync(path.join(contaminated, 'series', 'stale'), { recursive: true });
  await assert.rejects(
    runDraftLeague(['random', 'random'], contaminated, {
      recordsPath: contaminatedRecords,
      seed: 5,
      resume: true,
    }),
    (error: Error) =>
      ['stored results', 'teambuild/teambuild.jsonl', 'coaching.jsonl', 'season.jsonl', 'series/'].every((value) =>
        error.message.includes(value),
      ),
  );
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
  state.teamNames[1] = 'Drought Dodgers';
  state.rosters[1] = [mon('charizard-mega-y')];
  state.taken.set('charizard-mega-y', 1);
  state.budgets[1] = state.budgets[1]! - mon('charizard-mega-y').cost;
  const prompt = draftUserPrompt(state, 0, ['fake:model', 'random'], 0, '');
  assert.ok(!/most you can spend/.test(prompt), 'the harness does not compute an affordable ceiling');
  assert.match(prompt, /every remaining slot has to be filled/, 'the budget rule is still stated');
  assert.ok(
    prompt.indexOf('YOUR ROSTER') < prompt.lastIndexOf('You have'),
    'roster context comes before the budget line',
  );
  assert.ok(!/roster plan and needs/.test(prompt), 'the notebook does not prescribe a needs list');
  assert.match(prompt, /random/);
  assert.doesNotMatch(prompt, /Drought Dodgers/);
});

test('season reviews are written once per coach and replayed on resume', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-season-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = ['test:champion', 'test:eliminated'];
  const state: SeasonReviewState = {
    board: BOARD,
    models,
    picks: [
      { pick: 0, entrant: 0, mon: mon('charizard-mega-y').id, rationale: 'Sun opener.', fallback: false },
      { pick: 1, entrant: 1, mon: mon('tyranitar').id, rationale: 'Sand anchor.', fallback: false },
    ],
    rosters: [[mon('charizard-mega-y')], [mon('tyranitar')]],
    windows: [
      {
        after_week: 3,
        order: [1, 0],
        offers: [],
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
    ],
    standings: [
      { entrant: 0, w: 1, l: 0, gw: 2, gl: 0 },
      { entrant: 1, w: 0, l: 1, gw: 0, gl: 2 },
    ],
    series: [['Round-robin week 1: beat test:eliminated 2-0'], ['Round-robin week 1: lost to test:champion 0-2']],
    notebooks: ['champion plan', 'eliminated plan'],
  };
  const prompts = new Map<string, string>();
  const reply = JSON.stringify({
    summary: 'It went as the record says.',
    did_well: 'The draft covered rain.',
    did_poorly: 'The mega slot was idle.',
    would_change: 'Buy the backup mega.',
  });
  const reviewOptions = {
    runDir: directory,
    psDir: defaultPsDir(),
    makeReviewProvider: (spec: string) => ({
      complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
        prompts.set(spec, `${system}\n${messages[0]?.content ?? ''}`);
        return Promise.resolve({ text: reply, usage: {}, toolCalls: [] });
      },
    }),
  };
  const initial = await runSeasonReview([{ entrant: 1, outcome: 'You missed the playoffs.' }], state, reviewOptions);
  assert.deepEqual(
    initial.map((review) => review.entrant),
    [1],
  );
  fs.appendFileSync(path.join(directory, 'season.jsonl'), '{"entrant":');
  const reviews = await runSeasonReview(
    [
      { entrant: 1, outcome: 'You missed the playoffs.' },
      { entrant: 0, outcome: 'You won the final.' },
    ],
    state,
    reviewOptions,
  );

  assert.deepEqual(
    reviews.map((review) => review.entrant),
    [1, 0],
  );
  assert.ok(reviews.every((review) => !review.fallback));
  assert.match(prompts.get(models[0]!) ?? '', /Traded up\./);
  assertFormatAuthority(prompts.get(models[0]!) ?? '');
  assertFormatAuthority(prompts.get(models[1]!) ?? '');
  assert.match(prompts.get(models[1]!) ?? '', /You are test:eliminated, a coach/);
  assert.doesNotMatch(prompts.get(models[1]!) ?? '', /\b(?:Champion|Eliminated)\b/);
  assert.match(prompts.get(models[1]!) ?? '', /You made no swaps/);
  assert.match(prompts.get(models[1]!) ?? '', /Sand anchor\./);
  assert.equal(readJsonlObjects(path.join(directory, 'season.jsonl')).length, 2);

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
    assert.ok(
      entry.types.some((type) => type.toLowerCase() === 'fire'),
      `${id} is Fire`,
    );
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
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
    'name sort is alphabetical',
  );

  const bst = search.run({ min_bst: 600, limit: 100 });
  assert.ok(ids(bst).length > 0, 'the base stat filter returns entries');
  function ids(result: string): string[] {
    return result
      .split('\n')
      .slice(1)
      .map((line) => line.slice(2).split(' | ')[0]!);
  }
});

test('window prompts name their place in the schedule and the public moves of earlier windows', () => {
  const state = transactionState();
  const first = { afterWeek: 1, index: 0, count: 3 };
  const last = { afterWeek: 3, index: 2, count: 3 };
  const opening = renderTradeOfferPrompt(state, 0, defaultPsDir(), { position: first });
  assert.match(opening, /transaction window 1 of 3, open after round-robin week 1\. 2 more windows follow/);
  assert.ok(!opening.includes('PUBLIC TRANSACTIONS FROM EARLIER WINDOWS'), 'the first window has no history');
  const closing = renderFreeAgencyPrompt(
    {
      ...state,
      history: describeTransactionHistory(
        [
          {
            after_week: 1,
            order: [1, 0],
            offers: [
              {
                from: 1,
                to: 0,
                give: 'a',
                get: 'b',
                message: 'swap?',
                accepted: true,
                proposerFallback: false,
                responderFallback: false,
                offerReasoning: '',
                responseReasoning: '',
              },
            ],
            decisions: [
              {
                entrant: 0,
                model: 'random',
                swaps: [{ drop: 'c', add: 'd' }],
                reasoning: '',
                notebook: '',
                fallback: false,
              },
            ],
            rosters: [],
          },
        ],
        state.models,
      ),
    },
    0,
    defaultPsDir(),
    { position: last },
  );
  assert.match(
    closing,
    /transaction window 3 of 3, open after round-robin week 3\. Rosters lock when this window closes/,
  );
  assert.match(
    closing,
    /PUBLIC TRANSACTIONS FROM EARLIER WINDOWS:\n- After week 1: random traded a to random for b\.\n- After week 1: random dropped c and added d\./,
  );
});

test('a league paused between two closed windows resumes on the right roster version', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-draft-league-epochs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = ['random', 'random', 'random', 'random'];
  const first = await runDraftLeague(models, directory, {
    recordsPath,
    seed: 23,
    concurrency: 2,
    throughWeek: 2,
    transactions: [
      { afterWeek: 1, tradesAllowed: 0 },
      { afterWeek: 2, tradesAllowed: 0 },
    ],
  });
  assert.equal(first.length, 4, 'two weeks of a four-coach league are four series');
  assert.ok(fs.existsSync(path.join(directory, 'transactions', 'after-week-1', 'window.json')));
  assert.ok(
    !fs.existsSync(path.join(directory, 'transactions', 'after-week-2')),
    'pausing after week 2 stops before its window opens',
  );
  assert.ok(fs.existsSync(path.join(directory, 'reviews', 'week-1.jsonl')), 'week 1 was reviewed before its window');
  assert.ok(
    !fs.existsSync(path.join(directory, 'reviews', 'week-2.jsonl')),
    'pausing after week 2 stops before its review',
  );
  const resumed = await runDraftLeague(models, directory, { recordsPath, seed: 23, concurrency: 2, resume: true });
  assert.equal(resumed.length, 7);
  assert.ok(fs.existsSync(path.join(directory, 'transactions', 'after-week-2', 'window.json')));
  for (const week of [1, 2, 3]) {
    const reviews = readJsonlObjects(path.join(directory, 'reviews', `week-${week}.jsonl`));
    assert.equal(reviews.length, 4, `every coach reviews week ${week}`);
    assert.ok(reviews.every((row) => row.roster_version === Math.min(week - 1, 2)));
  }
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(config.review_weeks, [1, 2, 3], 'sequential weeks review after every week');
  for (const row of resumed) {
    assert.deepEqual(row.transactions, [
      { after_week: 1, trades_allowed: 0 },
      { after_week: 2, trades_allowed: 0 },
    ]);
    assert.equal(row.roster_version, row.stage === 'playoff' ? 2 : Math.min(Number(row.round) - 1, 2));
  }
  const replayed = await runDraftLeague(models, directory, { recordsPath, seed: 23, concurrency: 2, resume: true });
  assert.deepEqual(
    replayed.map((row) => row.series_id),
    resumed.map((row) => row.series_id),
    'a complete league replays without new series',
  );
});
