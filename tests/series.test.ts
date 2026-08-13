import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Bo3Context, RecordedSeriesContext } from '../src/series.js';
import {
  chanceEventCounts,
  foldSeriesGames,
  playBo3,
  resolveAttemptLineage,
  SINGLE_ELIMINATION_GAME_LIMIT,
  seriesSeedSchedule,
} from '../src/series.js';
import { showdownCommit } from '../src/showdown.js';

test('chance-event counts retain uninterpreted protocol facts per side', () => {
  const counts = chanceEventCounts([
    '|move|p2a: Aerodactyl|Rock Slide|p1a: Politoed|[spread] p1a,p1b',
    '|-miss|p2a: Aerodactyl|p1b: Gengar',
    '|-crit|p1a: Politoed',
    '|cant|p1a: Politoed|flinch',
    '|cant|p1b: Tinkaton|flinch',
    '|cant|p2b: Kingambit|par',
    '|-damage|p1a: Politoed|100/196',
    'garbage line without pipe',
  ]);
  assert.deepEqual(counts.p1, { misses: 0, crits_taken: 1, flinched_turns: 2, full_paralysis: 0 });
  assert.deepEqual(counts.p2, { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 1 });
});

function fakeEngines(): Bo3Context['engines'] {
  const engine = () =>
    ({
      beginGame() {},
      endGame() {},
      decisionStats() {
        return { fallbacks: 0 };
      },
    }) as unknown as Bo3Context['engines']['p1'];
  return { p1: engine(), p2: engine() };
}

test('game evidence separates model defaults, simulator substitutions, and timer autodefaults', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-fallback-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const engines = fakeEngines();
  let modelFallbacks = 5;
  engines.p1.decisionStats = () => ({ fallbacks: modelFallbacks });
  const result = await playBo3({
    engines,
    names: { p1: 'Side One', p2: 'Side Two' },
    players: { p1: 'model-one', p2: 'model-two' },
    teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
    gameSeeds: [[1, 2, 3, 4]],
    seriesId: 'fallbacks',
    seriesDir: directory,
    format: 'test',
    psDir: '',
    runBattle: async () => {
      modelFallbacks = 8;
      return {
        winner: 'Side One',
        turns: 1,
        log: ['|win|Side One'],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 1, p2: 0 },
        timerAutodefaults: { p1: 2, p2: 0 },
      };
    },
  });
  assert.deepEqual(result.games[0]!.model_choice_fallbacks, { p1: 3, p2: 0 });
  assert.deepEqual(result.games[0]!.simulator_substitutions, { p1: 1, p2: 0 });
  assert.deepEqual(result.games[0]!.timer_autodefaults, { p1: 2, p2: 0 });
});

test('a result log is not adoptable until both post-game hooks finish', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-completion-marker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const engines = fakeEngines();
  engines.p2.endGame = async () => {
    throw new Error('reflection failed');
  };
  const play = () =>
    playBo3({
      engines,
      names: { p1: 'Side One', p2: 'Side Two' },
      players: { p1: 'model-one', p2: 'model-two' },
      teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
      gameSeeds: [[1, 2, 3, 4]],
      seriesId: 'marker',
      seriesDir: directory,
      format: 'test',
      psDir: '',
      runBattle: async (_seed, onUpdate) => {
        onUpdate(['|win|Side One'], ['|win|Side One']);
        return {
          winner: 'Side One',
          turns: 1,
          log: ['|win|Side One'],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    });

  await assert.rejects(play(), /reflection failed/);
  assert.match(fs.readFileSync(path.join(directory, 'game-1.log'), 'utf8'), /\|win\|Side One/);
  assert.equal(fs.existsSync(path.join(directory, 'game-1.complete.json')), false);

  engines.p2.endGame = async () => {};
  const result = await play();
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'game-1.complete.json'), 'utf8'));
  assert.equal(marker.kind, 'game_complete');
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.series_id, 'marker');
  assert.equal(marker.game_number, 1);
  assert.equal(typeof marker.attempt_id, 'string');
  assert.deepEqual(marker.seed, [1, 2, 3, 4]);
  assert.equal(
    marker.log_sha256,
    createHash('sha256')
      .update(fs.readFileSync(path.join(directory, 'game-1.log')))
      .digest('hex'),
  );
  assert.deepEqual({ number: marker.game_number, seed: marker.seed, ...marker.summary }, result.games[0]);
});

test('single-elimination seed schedule precommits all deterministic regulation and extension seeds', () => {
  const regulation: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const schedule = seriesSeedSchedule(regulation, true);
  assert.equal(schedule.length, SINGLE_ELIMINATION_GAME_LIMIT);
  assert.deepEqual(schedule.slice(0, 3), regulation);
  const tiedPrefix = schedule.slice(0, 4).map((seed, index) => ({
    number: index + 1,
    seed,
    winner_side: null,
  }));
  assert.deepEqual(foldSeriesGames(regulation, tiedPrefix, { requireWinner: true }).nextSeed, schedule[4]);
  assert.deepEqual(seriesSeedSchedule(regulation, false), regulation);
});

test('foldSeriesGames derives deterministic terminal playoff tiebreaks for games four through nine', () => {
  const regulation: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  for (let terminalGame = 4; terminalGame <= SINGLE_ELIMINATION_GAME_LIMIT; terminalGame += 1) {
    const games: Array<Record<string, unknown>> = [];
    const playedSeeds: Array<[number, number, number, number]> = [];
    while (games.length < terminalGame) {
      const folded = foldSeriesGames(regulation, games, { requireWinner: true });
      assert.equal(folded.complete, false);
      assert.ok(folded.nextSeed);
      playedSeeds.push(folded.nextSeed);
      const winnerSide = games.length + 1 === terminalGame ? 'p1' : null;
      games.push({
        number: games.length + 1,
        seed: folded.nextSeed,
        winner_side: winnerSide,
        winner: winnerSide ? 'one' : null,
      });
    }
    const terminal = foldSeriesGames(regulation, games, {
      requireWinner: true,
      players: { p1: 'one', p2: 'two' },
    });
    assert.equal(terminal.complete, true);
    assert.equal(terminal.winnerSide, 'p1');
    assert.deepEqual(
      playedSeeds,
      games.map((game) => game.seed),
    );
  }
});

test('single elimination plays deterministic tiebreak games until one side wins', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-tiebreak-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planned: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const run = async (name: string) => {
    const seriesDir = path.join(directory, name);
    fs.mkdirSync(seriesDir);
    const seeds: Array<[number, number, number, number]> = [];
    let game = 0;
    const result = await playBo3({
      engines: fakeEngines(),
      names: { p1: 'Side One', p2: 'Side Two' },
      players: { p1: 'model-one', p2: 'model-two' },
      teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
      gameSeeds: planned,
      seriesId: name,
      seriesDir,
      format: 'test',
      psDir: '',
      requireWinner: true,
      runBattle: async (seed) => {
        seeds.push(seed);
        game += 1;
        const winner = game === 4 ? 'Side Two' : null;
        return {
          winner,
          turns: 1,
          log: [winner ? `|win|${winner}` : '|tie'],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    });
    return { result, seeds };
  };

  const first = await run('first');
  const second = await run('second');
  assert.equal(first.result.winnerSide, 'p2');
  assert.deepEqual(first.result.score, { p1: 0, p2: 1 });
  assert.equal(first.result.games.length, 4);
  assert.deepEqual(first.result.games[0]!.model_choice_fallbacks, { p1: 0, p2: 0 });
  assert.deepEqual(first.result.games[0]!.simulator_substitutions, { p1: 0, p2: 0 });
  assert.deepEqual(first.result.games[0]!.timer_autodefaults, { p1: 0, p2: 0 });
  assert.deepEqual(first.seeds.slice(0, 3), planned);
  assert.deepEqual(first.seeds[3], second.seeds[3]);
});

test('single elimination fails rather than fabricating a winner after the safety cap', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-tiebreak-cap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let games = 0;
  await assert.rejects(
    playBo3({
      engines: fakeEngines(),
      names: { p1: 'Side One', p2: 'Side Two' },
      players: { p1: 'model-one', p2: 'model-two' },
      teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
      gameSeeds: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
      seriesId: 'cap',
      seriesDir: directory,
      format: 'test',
      psDir: '',
      requireWinner: true,
      runBattle: async () => {
        games += 1;
        return {
          winner: null,
          turns: 1,
          log: ['|tie'],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          simulatorSubstitutions: { p1: 0, p2: 0 },
          timerAutodefaults: { p1: 0, p2: 0 },
        };
      },
    }),
    /remained tied after 9 games/,
  );
  assert.equal(games, SINGLE_ELIMINATION_GAME_LIMIT);
});

test('a tied playoff resumes with its deterministic non-null tiebreak seed', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-tiebreak-resume-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 19, undefined, { requireWinner: true });
  const seriesId = 'tiebreakresume';
  const seriesDir = path.join(runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    `${JSON.stringify({
      schema_version: 3,
      series_id: seriesId,
      started: '2026-01-01T00:00:00.000Z',
      identity: recordedIdentityFixture(options),
    })}
`,
  );
  const attemptId = 'tiebreak-attempt';
  fs.writeFileSync(
    path.join(seriesDir, 'series-attempts.jsonl'),
    `${JSON.stringify(attemptFixture('attempt_started', attemptId, seriesId))}
`,
  );
  const names = { p1: 'p1-random', p2: 'p2-random' };
  const regulation = options.gameSeeds.map((seed, index) => ({
    number: index + 1,
    winner: null,
    winner_side: null,
    seed,
  }));
  const expectedTiebreak = foldSeriesGames(options.gameSeeds, regulation, { requireWinner: true }).nextSeed!;
  const scheduledSeeds = [...options.gameSeeds, expectedTiebreak];
  for (let game = 1; game <= 4; game += 1) {
    const terminal = game === 4 ? `|win|${names.p2}` : '|tie';
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      [`|player|p1|${names.p1}|1|`, `|player|p2|${names.p2}|2|`, `|turn|${game}`, terminal, ''].join('\n'),
    );
    writeGameCompletionMarkerFixture(seriesDir, seriesId, game, attemptId, scheduledSeeds[game - 1]!, {
      winner: game === 4 ? 'random' : null,
      winner_side: game === 4 ? 'p2' : null,
      turns: game,
    });
  }

  const { fields } = await playRecordedSeries(options);
  const games = fields.games as Array<Record<string, unknown>>;
  assert.equal(games.length, 4);
  assert.equal(games[3]!.resumed, undefined);
  assert.deepEqual(games[3]!.seed, expectedTiebreak);
  assert.notEqual(games[3]!.seed, null);
  assert.equal(fields.winner_side, 'p2');
});

test('adopted completed games fast-forward the series and only remaining games play', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-fastforward-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const seeds: Array<[number, number, number, number]> = [];
  const result = await playBo3({
    engines: fakeEngines(),
    names: { p1: 'Side One', p2: 'Side Two' },
    players: { p1: 'model-one', p2: 'model-two' },
    teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    completedGames: [
      { number: 1, winner: 'model-one', winner_side: 'p1', turns: 9, seed: [1, 2, 3, 4], resumed: true },
    ],
    seriesId: 'fastforward',
    seriesDir: directory,
    format: 'test',
    psDir: '',
    runBattle: async (seed) => {
      seeds.push(seed);
      return {
        winner: 'Side One',
        turns: 3,
        log: ['|win|Side One'],
        pov: { p1: [], p2: [] },
        errors: { p1: 0, p2: 0 },
        simulatorSubstitutions: { p1: 0, p2: 0 },
        timerAutodefaults: { p1: 0, p2: 0 },
      };
    },
  });
  assert.deepEqual(seeds, [[5, 6, 7, 8]], 'only game two plays, on its planned seed');
  assert.equal(result.winnerSide, 'p1');
  assert.deepEqual(result.score, { p1: 2, p2: 0 });
  assert.equal(result.games.length, 2);
  assert.equal(result.games[0]!.resumed, true);
  assert.equal(result.games[1]!.number, 2);
});

test('a decided adopted series plays nothing at all', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-decided-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await playBo3({
    engines: fakeEngines(),
    names: { p1: 'Side One', p2: 'Side Two' },
    players: { p1: 'model-one', p2: 'model-two' },
    teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    completedGames: [
      { number: 1, winner: 'model-two', winner_side: 'p2', turns: 4, seed: [1, 2, 3, 4] },
      { number: 2, winner: 'model-two', winner_side: 'p2', turns: 6, seed: [5, 6, 7, 8] },
    ],
    seriesId: 'decided',
    seriesDir: directory,
    format: 'test',
    psDir: '',
    runBattle: async () => {
      throw new Error('no game should run');
    },
  });
  assert.equal(result.winnerSide, 'p2');
  assert.deepEqual(result.score, { p1: 0, p2: 2 });
  assert.equal(result.games.length, 2);
});

test('a live restart has no lineage link and keeps prior rows append-only', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-adopt-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 4);
  const priorDir = path.join(runDir, 'series', 'priorattempt1');
  fs.mkdirSync(priorDir, { recursive: true });
  const metadata = {
    schema_version: 3,
    series_id: 'priorattempt1',
    started: '2026-01-01T00:00:00.000Z',
    identity: recordedIdentityFixture(options),
  };
  fs.writeFileSync(path.join(priorDir, 'series.json'), `${JSON.stringify(metadata)}\n`);
  fs.writeFileSync(
    path.join(priorDir, 'game-1.log'),
    ['|player|p1|p1-random|1|', '|player|p2|p2-random|2|', '|turn|1', '|turn|7', '|win|p1-random', ''].join('\n'),
  );
  writeGameCompletionMarkerFixture(priorDir, 'priorattempt1', 1, 'prior-attempt', options.gameSeeds[0]!, {
    winner: 'random',
    winner_side: 'p1',
    turns: 7,
    errors: { p1: 2, p2: 3 },
    model_choice_fallbacks: { p1: 4, p2: 5 },
    simulator_substitutions: { p1: 6, p2: 7 },
    timer_autodefaults: { p1: 8, p2: 9 },
    chance_events: {
      p1: { misses: 1, crits_taken: 2, flinched_turns: 3, full_paralysis: 4 },
      p2: { misses: 5, crits_taken: 6, flinched_turns: 7, full_paralysis: 8 },
    },
  });
  fs.writeFileSync(
    path.join(priorDir, 'game-2.log'),
    ['|player|p1|p1-random|1|', '|player|p2|p2-random|2|', '|turn|1', '|turn|3', ''].join('\n'),
  );
  const decisionFile = path.join(priorDir, 'p1-decisions.jsonl');
  const submittedDecisions = [
    JSON.stringify({
      kind: 'decision',
      attempt_id: 'prior-attempt',
      submission_id: 'prior-attempt:1:p1:1',
      submission_source: 'random',
      outcome: 'accepted',
      action: 'move 1',
      game_number: 1,
      turn: 5,
      notebook: 'kept: lead pelipper',
    }),
    JSON.stringify({
      kind: 'decision',
      attempt_id: 'prior-attempt',
      submission_id: 'prior-attempt:2:p1:1',
      submission_source: 'random',
      outcome: 'accepted',
      action: 'move 1',
      game_number: 2,
      turn: 2,
      notebook: 'stale: from abandoned game',
    }),
    '',
  ].join('\n');
  fs.writeFileSync(decisionFile, submittedDecisions);
  fs.writeFileSync(
    path.join(priorDir, 'series-attempts.jsonl'),
    `${JSON.stringify(attemptFixture('attempt_started', 'prior-attempt', 'priorattempt1'))}\n`,
  );

  const { fields } = await playRecordedSeries(options);
  assert.equal(fields.series_id, 'priorattempt1', 'the prior directory is adopted, not replaced');
  const games = fields.games as Array<Record<string, unknown>>;
  assert.equal(games[0]!.resumed, undefined);
  assert.equal(games[0]!.winner_side, 'p1');
  assert.equal(games[0]!.turns, 7);
  assert.equal(games[0]!.winner, 'random');
  assert.deepEqual(games[0]!.errors, { p1: 2, p2: 3 });
  assert.deepEqual(games[0]!.model_choice_fallbacks, { p1: 4, p2: 5 });
  assert.deepEqual(games[0]!.simulator_substitutions, { p1: 6, p2: 7 });
  assert.deepEqual(games[0]!.timer_autodefaults, { p1: 8, p2: 9 });
  assert.deepEqual(games[0]!.chance_events, {
    p1: { misses: 1, crits_taken: 2, flinched_turns: 3, full_paralysis: 4 },
    p2: { misses: 5, crits_taken: 6, flinched_turns: 7, full_paralysis: 8 },
  });
  assert.ok(games.length >= 2, 'the unfinished second game replays');
  assert.equal(games[1]!.resumed, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(priorDir, 'series.json'), 'utf8')), metadata);
  const appendedDecisions = fs.readFileSync(decisionFile, 'utf8');
  assert.ok(appendedDecisions.startsWith(submittedDecisions));
  const appendedRows = appendedDecisions
    .slice(submittedDecisions.length)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(appendedRows.some((row) => row.kind === 'decision' && row.submission_source === 'random'));
  assert.ok(appendedRows.some((row) => row.kind === 'decision' && row.outcome === 'accepted'));
  const submissionIds = appendedRows.flatMap((row) => (row.kind === 'decision' ? [row.submission_id] : []));
  assert.equal(new Set(submissionIds).size, submissionIds.length);
  assert.ok(submissionIds.every((id) => String(id).startsWith(`${String(fields.attempt_id)}:`)));
  const attemptRows = fs
    .readFileSync(path.join(priorDir, 'series-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const liveStart = attemptRows.find((row) => row.kind === 'attempt_started' && row.attempt_id === fields.attempt_id);
  assert.ok(liveStart);
  assert.equal(liveStart.resumed_from, undefined);
  assert.equal(attemptRows.at(-1)!.kind, 'attempt_completed');

  await playRecordedSeries(options);
  assert.equal(fs.readFileSync(decisionFile, 'utf8'), appendedDecisions);
  const retriedStarts = fs
    .readFileSync(path.join(priorDir, 'series-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind === 'attempt_started');
  assert.equal(retriedStarts.at(-1)!.resumed_from, undefined);
  const score = fields.score as Record<string, number>;
  assert.ok(score.p1 === 2 || score.p2 === 2, 'the series still finishes with a winner');
  assert.ok(score.p1! >= 1, 'the adopted game one win persists in the score');
});

function attemptFixture(
  kind: 'attempt_started' | 'attempt_completed' | 'attempt_aborted',
  attemptId: string,
  seriesId: string,
  extra: Record<string, unknown> = {},
) {
  const head = { context_id: null, sequence: 0, byte_length: 0, sha256: createHash('sha256').update('').digest('hex') };
  return {
    kind,
    schema_version: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    attempt_id: attemptId,
    series_id: seriesId,
    adopted_completed_games: 0,
    context_heads: { start: { p1: head, p2: head }, end: { p1: head, p2: head } },
    ...extra,
  };
}

interface CompletionSummaryFixture {
  winner: string | null;
  winner_side: 'p1' | 'p2' | null;
  turns: number;
  errors?: { p1: number; p2: number };
  model_choice_fallbacks?: { p1: number; p2: number };
  simulator_substitutions?: { p1: number; p2: number };
  timer_autodefaults?: { p1: number; p2: number };
  chance_events?: ReturnType<typeof chanceEventCounts>;
}

function writeGameCompletionMarkerFixture(
  seriesDir: string,
  seriesId: string,
  gameNumber: number,
  attemptId: string,
  seed: [number, number, number, number],
  result: CompletionSummaryFixture,
): void {
  const logPath = path.join(seriesDir, `game-${gameNumber}.log`);
  const logBytes = fs.readFileSync(logPath);
  const relativeLog = path.relative(process.cwd(), logPath);
  const zeros = { p1: 0, p2: 0 };
  const emptyChance = chanceEventCounts([]);
  fs.writeFileSync(
    path.join(seriesDir, `game-${gameNumber}.complete.json`),
    `${JSON.stringify({
      kind: 'game_complete',
      schema_version: 1,
      series_id: seriesId,
      game_number: gameNumber,
      attempt_id: attemptId,
      seed,
      log_sha256: createHash('sha256').update(logBytes).digest('hex'),
      summary: {
        winner: result.winner,
        winner_side: result.winner_side,
        turns: result.turns,
        errors: result.errors ?? zeros,
        model_choice_fallbacks: result.model_choice_fallbacks ?? zeros,
        simulator_substitutions: result.simulator_substitutions ?? zeros,
        timer_autodefaults: result.timer_autodefaults ?? zeros,
        chance_events: result.chance_events ?? emptyChance,
        log: relativeLog.startsWith('..') ? logPath : relativeLog,
      },
    })}
`,
  );
}

function recordedFixtureOptions(
  pool: { format: string; teams: Array<{ id: string; packed: string }> },
  psDir: string,
  runDir: string,
  seriesIndex: number,
  players: Record<'p1' | 'p2', string> = { p1: 'random', p2: 'random' },
  overrides: Partial<RecordedSeriesContext> = {},
): RecordedSeriesContext {
  return {
    seriesIndex,
    players,
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir,
    runDir,
    ...overrides,
  };
}

function optionalFixtureDigests(values: Partial<Record<'p1' | 'p2', string>> | undefined) {
  return Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => {
      const value = values?.[pid];
      return [pid, value === undefined ? null : createHash('sha256').update(value).digest('hex')];
    }),
  );
}

function recordedIdentityFixture(context: RecordedSeriesContext) {
  return {
    players: context.players,
    team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
    packed_teams: { p1: context.teams.p1.packed, p2: context.teams.p2.packed },
    packed_team_digests: {
      p1: createHash('sha256').update(context.teams.p1.packed).digest('hex'),
      p2: createHash('sha256').update(context.teams.p2.packed).digest('hex'),
    },
    format: context.format,
    game_seeds: context.gameSeeds,
    series_index: context.seriesIndex ?? null,
    engine_seeds: context.engineSeeds,
    showdown_commit: showdownCommit(context.psDir),
    scaffold: {
      timer_scale: context.timerScale ?? 'off',
      require_winner: context.requireWinner ?? false,
      closed_sheets: context.closedSheets ?? false,
      reasoning: context.reasoning ?? null,
      reasoning_by_model: context.reasoningByModel ?? null,
      initial_notebook_digests: optionalFixtureDigests(context.initialNotebooks),
      draft_roster_digests: optionalFixtureDigests(context.draftRosters),
      briefing_digests: optionalFixtureDigests(context.briefings),
    },
  };
}

function writeDecidedAdoption(
  runDir: string,
  seriesId: string,
  context: RecordedSeriesContext,
  started?: string,
): string {
  const seriesDir = path.join(runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    `${JSON.stringify({
      schema_version: 3,
      series_id: seriesId,
      started: started ?? '2026-01-01T00:00:00.000Z',
      identity: recordedIdentityFixture(context),
    })}\n`,
  );
  const fixtureAttempt = `${seriesId}-fixture`;
  fs.writeFileSync(
    path.join(seriesDir, 'series-attempts.jsonl'),
    `${JSON.stringify(attemptFixture('attempt_started', fixtureAttempt, seriesId))}\n${JSON.stringify(
      attemptFixture('attempt_completed', fixtureAttempt, seriesId, { completed_games: 2 }),
    )}\n`,
  );
  const names = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
  for (const game of [1, 2]) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      [`|player|p1|${names.p1}|1|`, `|player|p2|${names.p2}|2|`, `|turn|${game}`, `|win|${names.p1}`, ''].join('\n'),
    );
    writeGameCompletionMarkerFixture(seriesDir, seriesId, game, fixtureAttempt, context.gameSeeds[game - 1]!, {
      winner: context.players.p1,
      winner_side: 'p1',
      turns: game,
    });
  }
  return seriesDir;
}

test('adoption fails closed on ambiguous equal-progress series directories', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-adopt-tie-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 14);
  const firstDir = writeDecidedAdoption(runDir, 'z-equal-progress', options);
  const secondDir = writeDecidedAdoption(runDir, 'a-equal-progress', options);
  const attemptsBefore = [firstDir, secondDir].map((directory) =>
    fs.readFileSync(path.join(directory, 'series-attempts.jsonl')),
  );

  await assert.rejects(playRecordedSeries(options), /ambiguous recorded series adoption/);
  assert.deepEqual(
    [firstDir, secondDir].map((directory) => fs.readFileSync(path.join(directory, 'series-attempts.jsonl'))),
    attemptsBefore,
  );
});

test('adoption rejects immutable series identity mismatches without rewriting metadata', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-adopt-identity-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const stored = recordedFixtureOptions(pool, defaultPsDir(), runDir, 16);
  const seriesDir = writeDecidedAdoption(runDir, 'identity-bound', stored);
  const metadataBefore = fs.readFileSync(path.join(seriesDir, 'series.json'));
  const attemptsBefore = fs.readFileSync(path.join(seriesDir, 'series-attempts.jsonl'));
  const mismatched = recordedFixtureOptions(pool, defaultPsDir(), runDir, 16, {
    p1: 'openai:different-model',
    p2: 'random',
  });

  await assert.rejects(playRecordedSeries(mismatched), /recorded series identity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, 'series.json')), metadataBefore);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, 'series-attempts.jsonl')), attemptsBefore);
});

test('adoption rejects any mutation of marker-bound canonical game log bytes', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-adopt-log-digest-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 17);
  const seriesDir = writeDecidedAdoption(runDir, 'digest-bound', options);
  const attemptsBefore = fs.readFileSync(path.join(seriesDir, 'series-attempts.jsonl'));
  fs.appendFileSync(path.join(seriesDir, 'game-1.log'), '|mutation|after-completion\n');

  await assert.rejects(playRecordedSeries(options), /canonical game log digest does not match/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, 'series-attempts.jsonl')), attemptsBefore);
});

test('adoption accepts only the exact current completion marker shape', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  for (const mutation of ['extra', 'missing'] as const) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `vgc-series-adopt-marker-${mutation}-`));
    t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
    const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, mutation === 'extra' ? 18 : 19);
    const seriesDir = writeDecidedAdoption(runDir, `${mutation}-marker`, options);
    const markerPath = path.join(seriesDir, 'game-1.complete.json');
    const completion = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (mutation === 'extra') completion.unbound = true;
    else delete completion.summary.errors;
    fs.writeFileSync(markerPath, `${JSON.stringify(completion)}\n`);

    await assert.rejects(playRecordedSeries(options), /invalid game completion marker/);
  }
});

test('a resumed attempt supersedes a crashed attempt and completes under one stable id', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-attempt-resume-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesId = 'crashresume';
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 15);
  const seriesDir = writeDecidedAdoption(runDir, seriesId, options);
  const emptyHead = {
    context_id: null,
    sequence: 0,
    byte_length: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  fs.appendFileSync(
    path.join(seriesDir, 'series-attempts.jsonl'),
    `${JSON.stringify({
      kind: 'attempt_started',
      schema_version: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      attempt_id: 'crashed-attempt',
      series_id: seriesId,
      adopted_completed_games: 1,
      context_heads: { start: { p1: emptyHead, p2: emptyHead }, end: { p1: emptyHead, p2: emptyHead } },
    })}\n{"kind":`,
  );

  await playRecordedSeries(options);

  const rows = fs
    .readFileSync(path.join(seriesDir, 'series-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const resumedStart = rows.findLast(
    (row) => row.kind === 'attempt_started' && ![`${seriesId}-fixture`, 'crashed-attempt'].includes(row.attempt_id),
  );
  assert.ok(resumedStart);
  assert.equal(resumedStart.adopted_completed_games, 2);
  const superseded = rows.find((row) => row.kind === 'attempt_superseded');
  assert.equal(superseded.attempt_id, 'crashed-attempt');
  assert.equal(superseded.superseded_by, resumedStart.attempt_id);
  assert.equal(superseded.adopted_completed_games, 1);
  const completed = rows.at(-1)!;
  assert.equal(completed.kind, 'attempt_completed');
  assert.equal(completed.attempt_id, resumedStart.attempt_id);
  assert.equal(completed.adopted_completed_games, 2);
  assert.equal(completed.completed_games, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.series_id === seriesId &&
        row.context_heads.start.p1 &&
        row.context_heads.start.p2 &&
        row.context_heads.end.p1 &&
        row.context_heads.end.p2,
    ),
  );
});

test('adoption truncates a torn final context row before a subsequent append', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-context-tail-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 9, {
    p1: 'openrouter:context-test',
    p2: 'random',
  });
  const seriesDir = writeDecidedAdoption(runDir, 'contextattempt', options);
  const contextFile = path.join(seriesDir, 'p1-context.jsonl');
  const rows = [
    {
      kind: 'agent_context',
      pid: 'p1',
      series_id: 'contextattempt',
      context_id: 'ctx-00000001',
      sequence: 1,
      context_kind: 'episode',
      payload: { event: 'game_begin' },
    },
    {
      kind: 'agent_context',
      pid: 'p1',
      series_id: 'contextattempt',
      context_id: 'ctx-00000002',
      sequence: 2,
      context_kind: 'observation',
      payload: { lines: ['|turn|1'] },
    },
  ];
  fs.writeFileSync(
    contextFile,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"kind":"agent_context","context_id":"ctx-00000003"`,
  );
  await playRecordedSeries(options);
  assert.equal(fs.readFileSync(contextFile, 'utf8'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const next = {
    kind: 'agent_context',
    pid: 'p1',
    series_id: 'contextattempt',
    context_id: 'ctx-00000003',
    sequence: 3,
    context_kind: 'reflection',
    payload: { summary: 'appended after recovery' },
  };
  fs.appendFileSync(contextFile, `${JSON.stringify(next)}\n`);
  await playRecordedSeries(options);
  const recovered = fs
    .readFileSync(contextFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    recovered.map((row) => row.sequence),
    [1, 2, 3],
  );
});

test('adoption still rejects malformed interior context rows', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-context-interior-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, 10, {
    p1: 'openrouter:context-test',
    p2: 'random',
  });
  const seriesDir = writeDecidedAdoption(runDir, 'badcontext', options);
  fs.writeFileSync(
    path.join(seriesDir, 'p1-context.jsonl'),
    [
      JSON.stringify({
        kind: 'agent_context',
        pid: 'p1',
        series_id: 'badcontext',
        context_id: 'ctx-00000001',
        sequence: 1,
        context_kind: 'episode',
        payload: {},
      }),
      '{"kind":',
      JSON.stringify({
        kind: 'agent_context',
        pid: 'p1',
        series_id: 'badcontext',
        context_id: 'ctx-00000002',
        sequence: 2,
        context_kind: 'episode',
        payload: {},
      }),
      '',
    ].join('\n'),
  );

  const contextBefore = fs.readFileSync(path.join(seriesDir, 'p1-context.jsonl'));
  await assert.rejects(playRecordedSeries(options), /invalid p1 context row 2/);
  assert.deepEqual(fs.readFileSync(path.join(seriesDir, 'p1-context.jsonl')), contextBefore);
  const attempts = fs
    .readFileSync(path.join(seriesDir, 'series-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    attempts.map((row) => row.kind),
    ['attempt_started', 'attempt_completed', 'attempt_started', 'attempt_aborted'],
  );
  assert.equal(attempts.at(-2)!.attempt_id, attempts.at(-1)!.attempt_id);
  assert.equal(attempts.at(-1)!.error.message, 'invalid p1 context row 2');
});

test('attempt lineage is transitive, excludes restart siblings, and fails closed', () => {
  const starts = [
    { kind: 'attempt_started', attempt_id: 'A', series_id: 'series' },
    { kind: 'attempt_started', attempt_id: 'restart-sibling', series_id: 'series' },
    { kind: 'attempt_started', attempt_id: 'B', series_id: 'series', resumed_from: 'A' },
    { kind: 'attempt_started', attempt_id: 'C', series_id: 'series', resumed_from: 'B' },
  ];
  assert.deepEqual(resolveAttemptLineage(starts, 'C'), ['A', 'B', 'C']);
  assert.deepEqual(resolveAttemptLineage(starts, 'restart-sibling'), ['restart-sibling']);
  assert.equal(
    resolveAttemptLineage(
      [
        ...starts,
        { kind: 'attempt_started', attempt_id: 'missing-child', series_id: 'series', resumed_from: 'missing' },
      ],
      'missing-child',
    ),
    undefined,
  );
  assert.equal(
    resolveAttemptLineage(
      [
        { kind: 'attempt_started', attempt_id: 'cycle-a', series_id: 'series', resumed_from: 'cycle-b' },
        { kind: 'attempt_started', attempt_id: 'cycle-b', series_id: 'series', resumed_from: 'cycle-a' },
      ],
      'cycle-a',
    ),
    undefined,
  );
});

test('adoption rejects context rows owned by another seat or series', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-context-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, pid, persistedSeries] of [
    ['wrongpid', 'p2', 'wrongpid'],
    ['wrongseries', 'p1', 'another-series'],
  ] as const) {
    const runDir = path.join(root, name);
    const options = recordedFixtureOptions(pool, defaultPsDir(), runDir, name === 'wrongpid' ? 12 : 13, {
      p1: 'openrouter:context-test',
      p2: 'random',
    });
    const seriesDir = writeDecidedAdoption(runDir, name, options);
    fs.writeFileSync(
      path.join(seriesDir, 'p1-context.jsonl'),
      `${JSON.stringify({
        kind: 'agent_context',
        pid,
        series_id: persistedSeries,
        context_id: 'ctx-00000001',
        sequence: 1,
        context_kind: 'episode',
        payload: {},
      })}\n`,
    );
    await assert.rejects(playRecordedSeries(options), /invalid p1 context row 1/);
  }
});
