import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ArenaEvent } from '../src/arena.js';
import { makePlans, runBenchmark } from '../src/arena.js';
import { PROVIDER_OPTIONS } from '../src/model-catalog.js';
import type { App } from '../src/tui/app.js';
import { CredentialScreen } from '../src/tui/models.js';
import { RunScreen } from '../src/tui/run.js';
import { allowedReasoning, commandPreview, runSize, SetupScreen } from '../src/tui/setup.js';
import { decodeKeys, displayWidth, padDisplay, stripSgr, truncateDisplay } from '../src/tui/term.js';
import { pinFooter, tableLines, wrapText } from '../src/tui/widgets.js';

function fakeApp(): App & { screens: unknown[]; quits: number } {
  const fake = {
    screens: [] as unknown[],
    quits: 0,
    width: 100,
    height: 40,
    paint() {},
    setScreen(screen: unknown) {
      fake.screens.push(screen);
    },
    quit() {
      fake.quits += 1;
    },
  };
  return fake as unknown as App & { screens: unknown[]; quits: number };
}

test('wrapText wraps words, hard-breaks long tokens, and caps lines', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText(`x ${'a'.repeat(12)} y`, 5), ['x', 'aaaaa', 'aaaaa', 'aa y']);
  assert.deepEqual(wrapText('alpha beta gamma delta', 5, 2), ['alpha', 'beta…']);
  assert.deepEqual(wrapText('  spaced\n\nout  ', 10), ['spaced out']);
});

test('decodeKeys handles sequences, control characters, and text', () => {
  assert.deepEqual(decodeKeys('\x1b[A\x1b[B\x1b[C\x1b[D'), [
    { name: 'up' },
    { name: 'down' },
    { name: 'right' },
    { name: 'left' },
  ]);
  assert.deepEqual(decodeKeys('\r'), [{ name: 'enter' }]);
  assert.deepEqual(decodeKeys('\x03'), [{ name: 'ctrl-c' }]);
  assert.deepEqual(decodeKeys('\x7f'), [{ name: 'backspace' }]);
  assert.deepEqual(decodeKeys('\x1b[3~'), [{ name: 'delete' }]);
  assert.deepEqual(decodeKeys('a 1'), [{ name: 'char', char: 'a' }, { name: 'space' }, { name: 'char', char: '1' }]);
  assert.deepEqual(decodeKeys('\x1b'), [{ name: 'escape' }]);
});

test('display helpers ignore SGR escapes', () => {
  const colored = '\x1b[1;38;5;75mhello\x1b[0m';
  assert.equal(stripSgr(colored), 'hello');
  assert.equal(displayWidth(colored), 5);
  assert.equal(padDisplay(colored, 8).length, colored.length + 3);
  assert.equal(stripSgr(truncateDisplay(colored, 3)), 'hel');
  assert.equal(truncateDisplay('plain text', 5), 'plain');
});

test('tableLines pads and aligns by display width', () => {
  const lines = tableLines(
    [{ title: 'name' }, { title: 'n', align: 'right' }],
    [
      ['\x1b[1malpha\x1b[0m', '5'],
      ['b', '123'],
    ],
  );
  assert.equal(lines.length, 4);
  assert.equal(stripSgr(lines[2]!), '  alpha    5');
  assert.equal(stripSgr(lines[3]!), '  b      123');
});

test('pinFooter keeps navigation at the bottom of short screens', () => {
  const lines = pinFooter(['body'], ['', 'footer'], 5);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'body');
  assert.equal(lines[4], 'footer');
});

test('allowedReasoning intersects levels across selected specs', () => {
  assert.deepEqual(allowedReasoning(['anthropic:claude-sonnet-5', 'openai:gpt-5.2', 'random']), [
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  assert.deepEqual(allowedReasoning(['random']), []);
  assert.deepEqual(allowedReasoning(['anthropic:claude-sonnet-5', 'openai:gpt-5.2-chat']), ['medium']);
  assert.deepEqual(allowedReasoning(['google:gemini-2.5-pro', 'openai:gpt-5.2-chat']), []);
});

test('commandPreview mirrors the batch CLI invocation', () => {
  assert.equal(
    commandPreview({
      models: ['anthropic:claude-sonnet-5', 'random'],
      seriesPerPair: 4,
      pool: 'regmb-202607',
      concurrency: 2,
      reasoning: 'medium',
      seed: 7,
    }),
    'vgcbench run --models anthropic:claude-sonnet-5 random --reasoning medium --series-per-pair 4 --pool regmb-202607 --seed 7',
  );
});

test('setup workflow builds and reviews a mirrored round robin', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('01 CONTENDERS')));

  screen.key({ name: 'end' });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('Add at least two contenders')));

  for (const spec of ['random', 'compat:http://localhost:11434/v1:qwen']) {
    screen.key({ name: 'char', char: 'm' });
    for (const char of spec) screen.key(char === ' ' ? { name: 'space' } : { name: 'char', char });
    screen.key({ name: 'enter' });
  }
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('compat / qwen')));

  screen.key({ name: 'end' });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('02 MATCH DESIGN')));
  screen.key({ name: 'right' });
  screen.key({ name: 'down' });
  screen.key({ name: 'right' });
  screen.key({ name: 'down' });
  screen.key({ name: 'right' });
  screen.key({ name: 'right' });
  screen.key({ name: 'down' });
  screen.key({ name: 'right' });
  screen.key({ name: 'down' });
  screen.key({ name: 'char', char: '7' });
  screen.key({ name: 'down' });
  screen.key({ name: 'enter' });
  const review = screen.render(100, 30).map(stripSgr);
  assert.ok(review.some((line) => line.includes('03 REVIEW')));
  assert.ok(review.some((line) => line.includes('BATCH COMMAND')));
  assert.ok(review.some((line) => line.includes('1 pairings  4 series  8–12 games')));
  assert.ok(
    review
      .join(' ')
      .replace(/\s+/g, ' ')
      .includes('--reasoning off --series-per-pair 4 --pool test --concurrency 3 --seed 7'),
  );

  screen.key({ name: 'down' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('incur provider cost')));
  screen.key({ name: 'enter' });
  assert.equal(app.screens.length, 1);
  assert.deepEqual(runSize(4, 4), { pairings: 6, series: 24, minimumGames: 48, maximumGames: 72 });
});

test('even series counts reuse team matchups while swapping model sides', () => {
  const plans = makePlans(
    ['model-a', 'model-b'],
    2,
    [
      { id: 'team-a', packed: 'a' },
      { id: 'team-b', packed: 'b' },
      { id: 'team-c', packed: 'c' },
    ],
    () => 0,
  );
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => plan.players),
    [
      { p1: 'model-a', p2: 'model-b' },
      { p1: 'model-b', p2: 'model-a' },
    ],
  );
  assert.deepEqual(
    plans.map((plan) => ({ p1: plan.teams.p1.id, p2: plan.teams.p2.id })),
    [
      { p1: 'team-a', p2: 'team-b' },
      { p1: 'team-a', p2: 'team-b' },
    ],
  );
});

test('setup blocks required provider credentials before start', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  const previous = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    for (const spec of ['random', 'openai:gpt-5.2']) {
      screen.key({ name: 'char', char: 'm' });
      for (const char of spec) screen.key({ name: 'char', char });
      screen.key({ name: 'enter' });
    }
    screen.key({ name: 'end' });
    screen.key({ name: 'enter' });
    screen.key({ name: 'end' });
    screen.key({ name: 'enter' });
    screen.key({ name: 'down' });
    screen.key({ name: 'enter' });
    assert.equal(app.screens.length, 0);
    assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('Connect openai')));

    process.env.OPENAI_API_KEY = 'session-key';
    screen.key({ name: 'enter' });
    assert.equal(app.screens.length, 1);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('manual model entry explains invalid specs and accepts provider IDs', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  screen.key({ name: 'char', char: 'm' });
  for (const char of 'bogus') screen.key({ name: 'char', char });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('Usage:')));
  screen.key({ name: 'escape' });
  screen.key({ name: 'char', char: 'm' });
  for (const char of 'xai:grok-4.3') screen.key({ name: 'char', char });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('xai / grok-4.3')));
});

test('review warns when a contender uses a mutable latest alias', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  for (const spec of ['random', 'openrouter:vendor/model-latest']) {
    screen.key({ name: 'char', char: 'm' });
    for (const char of spec) screen.key({ name: 'char', char });
    screen.key({ name: 'enter' });
  }
  screen.key({ name: 'end' });
  screen.key({ name: 'enter' });
  screen.key({ name: 'end' });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100, 30).some((line) => stripSgr(line).includes('prefer a snapshot ID')));
});

test('credential entry keeps provider keys in the current process', () => {
  const app = fakeApp();
  const back = new SetupScreen(app);
  const provider = PROVIDER_OPTIONS.find((option) => option.id === 'openai')!;
  const previous = process.env.OPENAI_API_KEY;
  let connected = 0;
  try {
    delete process.env.OPENAI_API_KEY;
    const screen = new CredentialScreen(app, back, provider, () => {
      connected += 1;
    });
    for (const char of 'session-q-key') screen.key({ name: 'char', char });
    screen.key({ name: 'enter' });
    assert.equal(process.env.OPENAI_API_KEY, 'session-q-key');
    assert.equal(connected, 1);
    assert.ok(screen.render(100, 24).some((line) => stripSgr(line).includes('never written')));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('runBenchmark emits ordered arena events', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcbench-tui-'));
  const events: ArenaEvent[] = [];
  const rows = await runBenchmark(['random', 'random'], 1, directory, {
    seed: 1,
    concurrency: 1,
    recordsPath: path.join(directory, 'results.jsonl'),
    onEvent: (event) => events.push(event),
  });
  assert.equal(events[0]!.type, 'plans');
  assert.equal(events[1]!.type, 'series-start');
  assert.equal(events.at(-1)!.type, 'series-end');
  const gameEnds = events.filter((event) => event.type === 'game-end');
  assert.ok(gameEnds.length >= 2);
  const updates = events.filter((event) => event.type === 'game-update');
  assert.ok(updates.length > 0);
  assert.ok(updates.every((event) => event.lines.length > 0 && event.game >= 1));
  const last = events.at(-1)! as Extract<ArenaEvent, { type: 'series-end' }>;
  assert.deepEqual(last.record.score, rows[0]!.score);
  assert.deepEqual(gameEnds.at(-1)!.score, rows[0]!.score);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('run screen game view renders live battle state', () => {
  const app = fakeApp();
  const back = new SetupScreen(app);
  const screen = new RunScreen(app, back, {
    models: ['random', 'random'],
    seriesPerPair: 1,
    pool: 'test',
    concurrency: 1,
  });
  const internal = screen as unknown as { onEvent(event: ArenaEvent): void; runDir: string };
  try {
    internal.onEvent({
      type: 'plans',
      pool: 'test',
      seed: 1,
      plans: [{ index: 0, players: { p1: 'model-a', p2: 'model-b' } }],
    });
    internal.onEvent({ type: 'series-start', index: 0 });
    internal.onEvent({
      type: 'game-update',
      index: 0,
      game: 1,
      lines: [
        '|poke|p1|Miraidon, L50|',
        '|poke|p2|Calyrex-Ice, L50|',
        '|switch|p1a: Miraidon|Miraidon, L50|207/207',
        '|switch|p2a: Calyrex-Ice|Calyrex-Ice, L50|252/252',
        '|turn|1',
        '|move|p1a: Miraidon|Electro Drift|p2a: Calyrex-Ice',
        '|-damage|p2a: Calyrex-Ice|126/252',
        '|move|p2a: Calyrex-Ice|Glacial Lance|p1a: Miraidon',
        '|turn|2',
      ],
    });
    const board = screen.render(100, 30).map(stripSgr);
    assert.ok(board.some((line) => line.includes('turn 2')));
    screen.key({ name: 'enter' });
    const view = screen.render(100, 30).map(stripSgr);
    assert.ok(view.some((line) => line.includes('GAME VIEW')));
    assert.ok(view.some((line) => line.includes('GAME 1 · TURN 2')));
    assert.ok(view.some((line) => line.includes('model-a')));
    assert.ok(view.some((line) => line.includes('Miraidon') && line.includes('207/207')));
    assert.ok(view.some((line) => line.includes('Calyrex-Ice') && line.includes('126/252')));
    assert.ok(view.some((line) => line.includes('A›Miraidon') && line.includes('last Electro Drift')));
    assert.ok(view.some((line) => line.includes('Electro Drift') && line.includes('→ Calyrex-Ice · T1')));
    assert.ok(view.some((line) => line.includes('Glacial Lance') && line.includes('→ Miraidon · T1')));
    screen.key({ name: 'escape' });
    assert.ok(
      screen
        .render(100, 30)
        .map(stripSgr)
        .some((line) => line.includes('SERIES BOARD')),
    );
  } finally {
    fs.rmSync(internal.runDir, { recursive: true, force: true });
  }
});

test('an aborted signal stops the benchmark without throwing or recording', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcbench-abort-'));
  const recordsPath = path.join(directory, 'results.jsonl');
  const controller = new AbortController();
  controller.abort();
  const rows = await runBenchmark(['random', 'random', 'random'], 2, directory, {
    seed: 1,
    concurrency: 2,
    recordsPath,
    signal: controller.signal,
  });
  assert.deepEqual(rows, []);
  assert.equal(fs.existsSync(recordsPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
