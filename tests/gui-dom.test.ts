import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { Window } from 'happy-dom';

import { GuiServer } from '../src/gui/server.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-runs-'));
after(() => fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true }));

type TestButton = {
  click(): void;
  disabled: boolean;
  textContent: string | null;
  getAttribute(name: string): string | null;
};

function asButton(node: unknown): TestButton {
  assert.ok(node);
  return node as TestButton;
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The GUI is redesigned freely pre-release, so this suite only guards against a bundle that fails to boot;
 * nothing here may assert on layout, copy, or DOM structure. */
test('built client bundle boots against the live server', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const window = new Window({ url: base });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset, 'shell should reference the built bundle with a portable relative path');
    const bundle = await (await fetch(new URL(asset, base))).text();

    window.document.body.innerHTML = '<div id="app"></div>';
    if (!('EventSource' in window)) {
      (window as unknown as Record<string, unknown>).EventSource = class {
        onmessage: unknown = null;
        close(): void {}
      };
    }
    window.eval(bundle);

    const rendered = () => window.document.body.textContent ?? '';
    await waitFor(() => rendered().trim().length > 0);
    assert.ok(rendered().trim().length > 0, 'the app must render something instead of crashing on boot');
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});
test('the data room archives a bracket and expands it on demand', async () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-records-'));
  const recordsPath = path.join(recordsDir, 'results.jsonl');
  const match = (
    seriesIndex: number,
    round: number,
    seeds: [number, number],
    p1: string,
    p2: string,
    winnerSide: 'p1' | 'p2',
  ) => ({
    mode: 'tournament',
    run_id: 'cup-dom',
    timestamp: `2026-07-25T0${seriesIndex}:00:00.000Z`,
    series_index: seriesIndex,
    round,
    entrant_count: 3,
    seeds: { p1: seeds[0], p2: seeds[1] },
    pool: 'majors',
    players: { p1, p2 },
    teams: { p1: `team-${seeds[0]}`, p2: `team-${seeds[1]}` },
    winner: winnerSide === 'p1' ? p1 : p2,
    winner_side: winnerSide,
    score: { p1: 2, p2: winnerSide === 'p1' ? 0 : 3 },
    turns: 12,
    advanced: winnerSide === 'p1' ? p1 : p2,
  });
  const rows = [
    match(0, 1, [1, 2], 'openai:beta', 'openai:gamma', 'p2'),
    match(1, 2, [0, 2], 'openai:alpha', 'openai:gamma', 'p1'),
  ];
  fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH, recordsPath });
  const base = await gui.listen(0);
  const window = new Window({ url: `${base}#tournaments` });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset);
    const bundle = await (await fetch(new URL(asset, base))).text();
    window.document.body.innerHTML = '<div id="app"></div>';
    if (!('EventSource' in window)) {
      (window as unknown as Record<string, unknown>).EventSource = class {
        onmessage: unknown = null;
        close(): void {}
      };
    }
    window.eval(bundle);
    const rendered = () => window.document.body.textContent ?? '';
    await waitFor(() => rendered().includes('Descriptive archive counts'));
    assert.match(rendered(), /openai:alpha/);
    assert.match(rendered(), /1 finished/);
    assert.match(rendered(), /not standings or comparable measures of model quality/i);
    assert.doesNotMatch(rendered(), /Most titles|Tournament placements|Tournament record/);
    assert.deepEqual(
      [...window.document.querySelectorAll('.data-table td.spec-cell')].map((entry) => entry.getAttribute('title')),
      ['alpha', 'beta', 'gamma'],
      'cross-bracket counts remain alphabetical rather than performance ordered',
    );
    const head = asButton(window.document.querySelector('.tournament-card-head'));
    head.click();
    await waitFor(() => window.document.querySelectorAll('.bracket-match').length > 0);
    assert.equal(window.document.querySelectorAll('.bracket-match').length, 3, 'two semis (one a bye) and a final');
    assert.match(rendered(), /Bye/);
    assert.match(rendered(), /Final/);
  } finally {
    await window.happyDOM.close();
    gui.close();
    fs.rmSync(recordsDir, { recursive: true, force: true });
  }
});

test('direct model profiles present contextual observations without pooled records', async () => {
  const recordsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-profile-'));
  const recordsPath = path.join(recordsDir, 'results.jsonl');
  const rows = [
    {
      mode: 'rotation',
      run_id: 'profile-rotation',
      series_id: 'series-a',
      timestamp: '2026-07-25T01:00:00.000Z',
      pool: 'majors',
      players: { p1: 'openai:zeta', p2: 'random' },
      winner: 'openai:zeta',
      winner_side: 'p1',
      score: { p1: 2, p2: 0 },
      games: [{ number: 1 }, { number: 2 }],
      decision_stats: {
        p1: { decisions: 4, move_selections: 6, switch_selections: 2, protect_selections: 1 },
      },
    },
    {
      mode: 'exhibition',
      run_id: 'profile-exhibition',
      series_id: 'series-b',
      timestamp: '2026-07-26T01:00:00.000Z',
      pool: 'majors',
      players: { p1: 'random', p2: 'openai:zeta' },
      winner: 'random',
      winner_side: 'p1',
      score: { p1: 2, p2: 1 },
      games: [{ number: 1 }, { number: 2 }, { number: 3 }],
      decision_stats: {
        p2: { decisions: 5, move_selections: 8, switch_selections: 2, protect_selections: 2 },
      },
    },
  ];
  fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH, recordsPath });
  const base = await gui.listen(0);
  const window = new Window({ url: `${base}#data/zeta` });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset);
    const bundle = await (await fetch(new URL(asset, base))).text();
    window.document.body.innerHTML = '<div id="app"></div>';
    if (!('EventSource' in window)) {
      (window as unknown as Record<string, unknown>).EventSource = class {
        onmessage: unknown = null;
        close(): void {}
      };
    }
    window.eval(bundle);

    const rendered = () => window.document.querySelector('.view.on')?.textContent ?? '';
    await waitFor(() => rendered().includes('Observed action mix in recorded contexts'));
    assert.match(rendered(), /Context, not quality/i);
    assert.match(rendered(), /opponents, teams, formats, schedules, and scaffolds differ/i);
    assert.match(rendered(), /does not rank this model or support model-quality comparisons/i);
    assert.match(rendered(), /Recorded contexts by mode/);
    assert.doesNotMatch(rendered(), /How this model plays|Records by mode|W-L/);
    assert.equal(
      [...window.document.querySelectorAll('.stat-value')].some((entry) => entry.textContent?.trim() === '1-1'),
      false,
      'the profile must not feature a pooled W-L tile',
    );
  } finally {
    await window.happyDOM.close();
    gui.close();
    fs.rmSync(recordsDir, { recursive: true, force: true });
  }
});

test('starting a run hydrates the arena without an SSE event', async () => {
  let publishAutomatic: (() => void) | undefined;
  let publishSuccess: (() => void) | undefined;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    tournamentRunner: async (_models, _runDir, options = {}) => {
      options.onEvent?.({
        type: 'plans',
        mode: 'tournament',
        protocolVersion: 1,
        plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
        pool: '',
        seed: 7,
      });
      options.onEvent?.({ type: 'series-start', index: 0 });
      options.onEvent?.({ type: 'game-update', index: 0, game: 1, lines: ['|turn|7'], publicLines: ['|turn|7'] });
      options.onEvent?.({
        type: 'decision',
        index: 0,
        pid: 'p1',
        row: {
          kind: 'decision',
          game_number: 1,
          turn: 7,
          phase: 'turn',
          selection: [],
          rationale: 'No decision was submitted; the battle timer decides.',
          automatic: false,
          fallback: true,
          error_summary: 'Google API quota is exhausted (429).',
        },
      });
      publishAutomatic = () =>
        options.onEvent?.({
          type: 'decision',
          index: 0,
          pid: 'p1',
          row: {
            kind: 'decision',
            game_number: 1,
            turn: 8,
            phase: 'forced_switch',
            selection: ['Switch to Gholdengo'],
            rationale: 'Automatic: only one legal joint action.',
            automatic: true,
            fallback: false,
          },
        });
      publishSuccess = () =>
        options.onEvent?.({
          type: 'decision',
          index: 0,
          pid: 'p1',
          row: {
            kind: 'decision',
            game_number: 1,
            turn: 8,
            phase: 'turn',
            selection: ['Protect'],
            rationale: 'Preserve the position.',
            automatic: false,
            fallback: false,
          },
        });
      const aborted = Promise.withResolvers<void>();
      options.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      await aborted.promise;
      return [];
    },
  });
  const base = await gui.listen(0);
  const window = new Window({ url: base });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset);
    const bundle = await (await fetch(new URL(asset, base))).text();

    window.document.body.innerHTML = '<div id="app"></div>';
    (window as unknown as Record<string, unknown>).EventSource = class {
      onmessage: unknown = null;
      close(): void {}
    };
    window.eval(bundle);

    await waitFor(() => (window.document.body.textContent ?? '').includes('Model lineup'));
    const addBaseline = asButton(
      [...window.document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Add random baseline',
      ),
    );
    addBaseline.click();
    addBaseline.click();
    await waitFor(() => window.document.querySelectorAll('.contender').length === 2);

    const start = asButton(
      [...window.document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Start the match',
      ),
    );
    assert.equal(start.disabled, false);
    start.click();

    await waitFor(() => window.document.querySelector('.header-state.live') !== null);
    assert.equal(window.document.querySelector('.header-state.live')?.textContent?.trim(), 'Run in progress');
    assert.match(window.document.querySelector('.view.on')?.textContent ?? '', /Run in progress/);

    const boardRow = asButton(window.document.querySelector('.board-row'));
    boardRow.click();
    await waitFor(() => window.document.querySelector('.side-fallback-warning') !== null);
    const warning = window.document.querySelector('.side-fallback-warning');
    assert.match(warning?.getAttribute('aria-label') ?? '', /latest model decision used a fallback/i);
    assert.equal(warning?.getAttribute('title'), 'Google API quota is exhausted (429).');

    const decisionsTab = asButton(
      [...window.document.querySelectorAll('button')].find((button) =>
        button.textContent?.trim().startsWith('Decisions'),
      ),
    );
    decisionsTab.click();
    await waitFor(() => window.document.querySelector('.decision-error') !== null);
    assert.equal(window.document.querySelector('.decision-error')?.textContent, 'Google API quota is exhausted (429).');

    publishAutomatic?.();
    boardRow.click();
    await waitFor(() => window.document.querySelectorAll('.decision-entry').length === 2);
    assert.ok(
      window.document.querySelector('.side-fallback-warning'),
      'an automatic action does not clear the warning',
    );

    publishSuccess?.();
    boardRow.click();
    await waitFor(() => window.document.querySelectorAll('.decision-entry').length === 3);
    assert.equal(
      window.document.querySelector('.side-fallback-warning'),
      null,
      'a successful model decision clears it',
    );
  } finally {
    await window.happyDOM.close();
    await gui.shutdown(0);
  }
});
