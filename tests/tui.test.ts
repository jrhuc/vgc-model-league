import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ArenaEvent } from '../src/arena.js';
import { runBenchmark } from '../src/arena.js';
import type { App } from '../src/tui/app.js';
import { allowedReasoning, commandPreview, SetupScreen } from '../src/tui/setup.js';
import { decodeKeys, displayWidth, padDisplay, stripSgr, truncateDisplay } from '../src/tui/term.js';
import { tableLines } from '../src/tui/widgets.js';

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

test('setup screen toggles models and blocks underspecified runs', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  const lines = screen.render(100);
  assert.ok(lines.some((line) => stripSgr(line).includes('vgcbench')));
  assert.ok(lines.some((line) => stripSgr(line).includes('anthropic:claude-sonnet-5')));

  screen.key({ name: 'space' });
  assert.ok(screen.render(100).some((line) => stripSgr(line).includes('◉ anthropic:claude-sonnet-5')));

  for (const _ of Array(50)) screen.key({ name: 'down' });
  screen.key({ name: 'up' });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100).some((line) => stripSgr(line).includes('select at least two models')));
  assert.equal(app.screens.length, 0);

  screen.key({ name: 'char', char: 's' });
  assert.equal(app.screens.length, 1);
  screen.key({ name: 'ctrl-c' });
  assert.equal(app.quits, 1);
});

test('setup screen custom model entry validates specs', () => {
  const app = fakeApp();
  const screen = new SetupScreen(app);
  screen.key({ name: 'char', char: 'a' });
  for (const char of 'bogus') screen.key({ name: 'char', char });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100).some((line) => stripSgr(line).includes('Usage:')));
  screen.key({ name: 'escape' });
  screen.key({ name: 'char', char: 'a' });
  for (const char of 'xai:grok-4.3') screen.key({ name: 'char', char });
  screen.key({ name: 'enter' });
  assert.ok(screen.render(100).some((line) => stripSgr(line).includes('◉ xai:grok-4.3')));
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
  const last = events.at(-1)! as Extract<ArenaEvent, { type: 'series-end' }>;
  assert.deepEqual(last.record.score, rows[0]!.score);
  assert.deepEqual(gameEnds.at(-1)!.score, rows[0]!.score);
  fs.rmSync(directory, { recursive: true, force: true });
});
