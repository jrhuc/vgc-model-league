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

type TestField = {
  value: string;
  getAttribute(name: string): string | null;
  focus(): void;
  dispatchEvent(event: unknown): boolean;
};

function asButton(node: unknown): TestButton {
  assert.ok(node);
  return node as TestButton;
}

function asField(node: unknown): TestField {
  assert.ok(node);
  return node as TestField;
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('built client bundle boots and renders the app against the live server', async () => {
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
    await waitFor(() => rendered().includes('Model lineup'));
    const text = rendered();
    assert.match(text, /VGC MODEL LEAGUE/);
    assert.match(text, /Model lineup/);
    assert.match(text, /Control sheet/);
    assert.match(text, /No models selected/);
    const navButtons = window.document.querySelectorAll('.nav-button');
    assert.equal(
      navButtons.length,
      4,
      'setup, the live run, the draft league, and one data room; pools live inside run setup',
    );
    assert.deepEqual(
      [...navButtons].map((button) => button.textContent),
      ['New run', 'Live run', 'Draft league', 'Data room'],
      'every recorded result reads from one data room',
    );

    const modeTabs = window.document.querySelectorAll('.mode-tab');
    assert.equal(modeTabs.length, 4, 'match, tournament, draft, and rotation modes are offered');
    assert.equal(
      window.document.querySelector('.mode-tabs')?.tagName,
      'FIELDSET',
      'run modes use a semantic toggle group',
    );
    assert.equal(modeTabs[0]?.getAttribute('role'), null);
    assert.equal(modeTabs[0]?.getAttribute('aria-pressed'), 'true');
    assert.equal(modeTabs[1]?.getAttribute('aria-pressed'), 'false');
    assert.ok(
      window.document.querySelector('legend.visually-hidden'),
      'fieldset legends stay readable to assistive tech',
    );
    assert.equal(window.document.querySelector('#pool'), null, 'a match needs no team pool');

    const addBaseline = asButton(
      [...window.document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Add random baseline',
      ),
    );
    addBaseline.click();
    addBaseline.click();
    await waitFor(() => window.document.querySelectorAll('.contender').length === 2);
    assert.ok(
      rendered().includes('Sample ·'),
      'sample teams prefill match contenders so the run can start immediately',
    );
    assert.equal(
      window.document.querySelector('.add-bay:not(.hidden)'),
      null,
      'a full match lineup hides the model selection bay',
    );
    const contenderButton = asButton(window.document.querySelector('.contender-main'));
    assert.equal(contenderButton.getAttribute('aria-expanded'), 'false');
    contenderButton.click();
    await waitFor(() => window.document.querySelector('#teamPaste0') !== null);
    assert.equal(contenderButton.getAttribute('aria-expanded'), 'true');
    const pasteField = asField(window.document.querySelector('#teamPaste0'));
    assert.ok(pasteField.value.trim().length > 0, 'the sample team prefills the paste editor');
    assert.match(
      window.document.querySelector('.schedule')?.textContent ?? '',
      /with Sample ·|assign its team from a pool/,
    );
    const validateButton = asButton(
      [...window.document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Validate team'),
    );
    assert.equal(validateButton.disabled, false, 'a non-empty paste enables validation');
    validateButton.click();
    await waitFor(() => window.document.querySelector('#teamPaste0') === null, 30_000);
    assert.equal(window.document.querySelector('#teamPaste0'), null, 'a legal paste collapses the team editor');
    assert.match(rendered(), /Pasted team ✓/);
    assert.equal(contenderButton.getAttribute('aria-expanded'), 'false');
    asButton(window.document.querySelector('.icon-button')).click();
    await waitFor(() => window.document.querySelectorAll('.contender').length === 1);
    asButton(window.document.querySelector('.icon-button')).click();
    await waitFor(() => window.document.querySelectorAll('.contender').length === 0);

    asButton(modeTabs[3]).click();
    await waitFor(() => window.document.querySelector('#pool') !== null);
    const poolDropdown = asButton(window.document.querySelector('#pool'));
    assert.equal(poolDropdown.getAttribute('role'), 'combobox');
    assert.ok(
      (window.document.querySelector('.pool-facts')?.textContent ?? '').includes('teams'),
      'selected pool should show its team count',
    );
    assert.ok(
      (window.document.querySelector('.pools-manager > summary')?.textContent ?? '').includes('Manage team pools'),
      'pool creation is collapsed into the run setup page',
    );

    asButton(modeTabs[2]).click();
    await waitFor(() => rendered().includes('Draft board'));
    assert.match(rendered(), /Snake draft/);
    assert.match(rendered(), /weekly round robin, then playoffs/);
    assert.match(rendered(), /pick six and build each set themselves/);
    assert.match(
      window.document.querySelector('.schedule')?.textContent ?? '',
      /Add at least two models to plan the draft/,
    );

    asButton(modeTabs[1]).click();
    await waitFor(() => window.document.querySelector('#pool') !== null);
    assert.equal(modeTabs[1]?.getAttribute('aria-pressed'), 'true');
    for (let count = 0; count < 3; count += 1) addBaseline.click();
    await waitFor(() => window.document.querySelectorAll('.contender').length === 3);
    assert.doesNotMatch(rendered(), /even number of models/);
    const startButton = asButton(
      [...window.document.querySelectorAll('button')].find((button) =>
        /Start the 3-model bracket/.test(button.textContent ?? ''),
      ),
    );
    assert.equal(startButton.disabled, false);

    asButton(modeTabs[0]).click();
    await waitFor(() => rendered().includes('Run card'));

    const modelSearch = window.document.querySelector('#modelSearch');
    assert.ok(modelSearch, 'model combobox input should render');
    assert.equal(modelSearch.getAttribute('role'), 'combobox');

    const providerSearch = asField(window.document.querySelector('#provider'));
    assert.equal(providerSearch.getAttribute('role'), 'combobox');
    assert.equal(providerSearch.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(providerSearch.value, 'Anthropic');
    providerSearch.focus();
    providerSearch.value = 'vercel';
    providerSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => window.document.querySelectorAll('.dropdown-option').length === 1);
    assert.equal(window.document.querySelector('.dropdown-option')?.textContent?.trim(), 'Vercel AI Gateway');
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
    await waitFor(() => rendered().includes('Reigning champion'));
    assert.match(rendered(), /openai:alpha/);
    assert.match(rendered(), /1 finished/);
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
