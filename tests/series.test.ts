import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Bo3Context } from '../src/series.js';
import { gameLuck, playBo3, SINGLE_ELIMINATION_GAME_LIMIT } from '../src/series.js';

test('game luck tallies chance events per side from the full log', () => {
  const luck = gameLuck([
    '|move|p2a: Aerodactyl|Rock Slide|p1a: Politoed|[spread] p1a,p1b',
    '|-miss|p2a: Aerodactyl|p1b: Gengar',
    '|-crit|p1a: Politoed',
    '|cant|p1a: Politoed|flinch',
    '|cant|p1b: Tinkaton|flinch',
    '|cant|p2b: Kingambit|par',
    '|-damage|p1a: Politoed|100/196',
    'garbage line without pipe',
  ]);
  assert.deepEqual(luck.p1, { misses: 0, crits_taken: 1, flinched_turns: 2, full_paralysis: 0 });
  assert.deepEqual(luck.p2, { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 1 });
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
  await play();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'game-1.complete.json'), 'utf8')), {
    kind: 'game_complete',
    series_id: 'marker',
    game_number: 1,
  });
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
    completedGames: [{ number: 1, winner: 'model-one', winner_side: 'p1', turns: 9, resumed: true }],
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
      { number: 1, winner: 'model-two', winner_side: 'p2', turns: 4 },
      { number: 2, winner: 'model-two', winner_side: 'p2', turns: 6 },
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

test('a resumed series adopts its prior directory, keeps game one, and prunes the abandoned game', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-adopt-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const priorDir = path.join(runDir, 'series', 'priorattempt1');
  fs.mkdirSync(priorDir, { recursive: true });
  fs.writeFileSync(
    path.join(priorDir, 'series.json'),
    `${JSON.stringify({ players: { p1: 'old:spec', p2: 'random' }, started: '2026-01-01T00:00:00.000Z', series_index: 4 })}\n`,
  );
  fs.writeFileSync(
    path.join(priorDir, 'game-1.log'),
    ['|player|p1|p1-old:spec|1|', '|player|p2|p2-random|2|', '|turn|1', '|turn|7', '|win|p1-old:spec', ''].join('\n'),
  );
  writeGameCompletionMarkerFixture(priorDir, 'priorattempt1', 1);
  fs.writeFileSync(
    path.join(priorDir, 'game-2.log'),
    ['|player|p1|p1-old:spec|1|', '|player|p2|p2-random|2|', '|turn|1', '|turn|3', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(priorDir, 'p1-decisions.jsonl'),
    [
      JSON.stringify({ kind: 'decision', game_number: 1, turn: 5, notebook: 'kept: lead pelipper' }),
      JSON.stringify({ kind: 'decision', game_number: 2, turn: 2, notebook: 'stale: from abandoned game' }),
      '',
    ].join('\n'),
  );
  const { fields } = await playRecordedSeries({
    seriesIndex: 4,
    players: { p1: 'random', p2: 'random' },
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir: defaultPsDir(),
    runDir,
  });
  assert.equal(fields.series_id, 'priorattempt1', 'the prior directory is adopted, not replaced');
  const games = fields.games as Array<Record<string, unknown>>;
  assert.equal(games[0]!.resumed, true);
  assert.equal(games[0]!.winner_side, 'p1');
  assert.equal(games[0]!.turns, 7);
  assert.equal(games[0]!.winner, 'random', 'the adopted win is credited to the current seat');
  assert.ok(games.length >= 2, 'the unfinished second game replays');
  assert.equal(games[1]!.resumed, undefined);
  const meta = JSON.parse(fs.readFileSync(path.join(priorDir, 'series.json'), 'utf8'));
  assert.equal(meta.series_index, 4);
  assert.deepEqual(meta.players, { p1: 'random', p2: 'random' });
  assert.equal(meta.started, '2026-01-01T00:00:00.000Z');
  const decisionLines = fs
    .readFileSync(path.join(priorDir, 'p1-decisions.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    decisionLines.some((row) => row.notebook === 'kept: lead pelipper'),
    'decisions from finished games survive',
  );
  assert.ok(
    decisionLines.every((row) => row.notebook !== 'stale: from abandoned game'),
    'decisions from the abandoned game are pruned',
  );
  const score = fields.score as Record<string, number>;
  assert.ok(score.p1 === 2 || score.p2 === 2, 'the series still finishes with a winner');
  assert.ok(score.p1! >= 1, 'the adopted game one win persists in the score');
});

function writeGameCompletionMarkerFixture(seriesDir: string, seriesId: string, gameNumber: number): void {
  fs.writeFileSync(
    path.join(seriesDir, `game-${gameNumber}.complete.json`),
    `${JSON.stringify({ kind: 'game_complete', series_id: seriesId, game_number: gameNumber })}\n`,
  );
}

function writeDecidedAdoption(runDir: string, seriesId: string, seriesIndex: number): string {
  const seriesDir = path.join(runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    `${JSON.stringify({ players: { p1: 'old-one', p2: 'old-two' }, series_index: seriesIndex })}\n`,
  );
  for (const game of [1, 2]) {
    fs.writeFileSync(
      path.join(seriesDir, `game-${game}.log`),
      ['|player|p1|old-one|1|', '|player|p2|old-two|2|', `|turn|${game}`, '|win|old-one', ''].join('\n'),
    );
    writeGameCompletionMarkerFixture(seriesDir, seriesId, game);
  }
  return seriesDir;
}

test('adoption fails closed on legacy result logs without completion markers', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-legacy-completion-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesDir = writeDecidedAdoption(runDir, 'legacyattempt', 11);
  fs.rmSync(path.join(seriesDir, 'game-1.complete.json'));

  const { fields } = await playRecordedSeries({
    seriesIndex: 11,
    players: { p1: 'random', p2: 'random' },
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir: defaultPsDir(),
    runDir,
  });

  const games = fields.games as Array<Record<string, unknown>>;
  assert.equal(games[0]!.resumed, undefined);
  assert.equal(fs.existsSync(path.join(seriesDir, 'game-1.complete.json')), true);
});

test('adoption restores post-game and explicitly cleared notebooks in decision-file order', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-notebook-adopt-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesDir = writeDecidedAdoption(runDir, 'notebookattempt', 8);
  fs.writeFileSync(
    path.join(seriesDir, 'p1-decisions.jsonl'),
    [
      JSON.stringify({ kind: 'decision', game_number: 1, notebook: 'turn plan' }),
      JSON.stringify({ kind: 'game_reflection', game_number: 1, notebook: 'post-game plan' }),
      JSON.stringify({ kind: 'decision', game_number: 2 }),
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(seriesDir, 'p2-decisions.jsonl'),
    [
      JSON.stringify({ kind: 'decision', game_number: 1, notebook: 'temporary plan' }),
      JSON.stringify({ kind: 'game_reflection', game_number: 2, notebook: '' }),
      '',
    ].join('\n'),
  );

  const result = await playRecordedSeries({
    seriesIndex: 8,
    players: { p1: 'openai:notebook-one', p2: 'openai:notebook-two' },
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    initialNotebooks: { p1: 'initial one', p2: 'initial two' },
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir: defaultPsDir(),
    runDir,
  });

  assert.equal(result.coachNotes.p1, 'post-game plan');
  assert.equal(result.coachNotes.p2, '');
});

test('adoption truncates a torn final context row before a subsequent append', async (t) => {
  const { playRecordedSeries } = await import('../src/series.js');
  const { loadPool } = await import('../src/teams.js');
  const { defaultPsDir } = await import('../src/paths.js');
  const pool = loadPool();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-context-tail-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const seriesDir = writeDecidedAdoption(runDir, 'contextattempt', 9);
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
  const options = {
    seriesIndex: 9,
    players: { p1: 'openai:context-test', p2: 'random' },
    teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
    gameSeeds: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ] as Array<[number, number, number, number]>,
    engineSeeds: { p1: 11, p2: 22 },
    format: pool.format,
    psDir: defaultPsDir(),
    runDir,
  };

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
  const seriesDir = writeDecidedAdoption(runDir, 'badcontext', 10);
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

  await assert.rejects(
    playRecordedSeries({
      seriesIndex: 10,
      players: { p1: 'openai:context-test', p2: 'random' },
      teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
      gameSeeds: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
      engineSeeds: { p1: 11, p2: 22 },
      format: pool.format,
      psDir: defaultPsDir(),
      runDir,
    }),
    /invalid p1 context row 2/,
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
    const seriesDir = writeDecidedAdoption(runDir, name, name === 'wrongpid' ? 12 : 13);
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
    await assert.rejects(
      playRecordedSeries({
        seriesIndex: name === 'wrongpid' ? 12 : 13,
        players: { p1: 'openai:context-test', p2: 'random' },
        teams: { p1: pool.teams[0]!, p2: pool.teams[1]! },
        gameSeeds: [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
          [9, 10, 11, 12],
        ],
        engineSeeds: { p1: 11, p2: 22 },
        format: pool.format,
        psDir: defaultPsDir(),
        runDir,
      }),
      /invalid p1 context row 1/,
    );
  }
});
