import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { Window } from 'happy-dom';

import { GuiServer } from '../src/gui/server.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-dom-'));
after(() => fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true }));

async function waitFor(predicate: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('DOM condition was not reached before the test deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('built client boots to the canonical Home route against the live server', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const window = new Window({ url: base });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset);
    const bundle = await (await fetch(new URL(asset, base))).text();
    window.document.body.innerHTML = '<div id="app"></div>';
    let eventSources = 0;
    (window as unknown as Record<string, unknown>).EventSource = class {
      onmessage: unknown = null;
      constructor() {
        eventSources += 1;
      }
      close(): void {}
    };
    window.eval(bundle);
    assert.ok(window.document.querySelector('header.app-header'));
    assert.ok(window.document.querySelector('main > .view.on:not([hidden]) h1'));
    await waitFor(() => window.document.querySelector('main > .view.on:not([hidden]) h1') !== null);
    await waitFor(() => window.document.title === 'Home · VGC Model League');
    assert.equal(window.document.title, 'Home · VGC Model League');
    assert.equal(window.document.querySelectorAll('main > .view.on:not([hidden]) h1').length, 1);
    assert.equal(window.document.querySelector('.primary-nav a[aria-current="page"]')?.textContent, 'Home');
    assert.equal(window.document.body.classList.contains('research-dark'), true);

    window.location.hash = '#leagues';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.document.title === 'Draft leagues · VGC Model League');
    assert.equal(window.document.body.classList.contains('research-dark'), false);

    window.location.hash = '#method';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.document.title === 'Method · VGC Model League');
    assert.equal(window.document.body.classList.contains('research-dark'), true);
    assert.equal(eventSources, 0, 'anonymous research and archive pages do not open the live event stream');
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});

test('archive game content unmounts off route and remounts from its deep link', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const window = new Window({ url: `${base}#leagues/live-run/game-0-1` });
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

    const nativeFetch = window.fetch.bind(window);
    let gameRequests = 0;
    const league = {
      runId: 'live-run',
      when: '2026-08-09T00:00:00.000Z',
      lastPlayed: null,
      board: null,
      format: null,
      budget: null,
      picksPerEntrant: null,
      weeks: 1,
      playoffRounds: 1,
      phase: 'roundrobin',
      week: 1,
      champion: null,
      draftOnly: false,
      live: true,
      liveSeries: [],
      tradeWindow: null,
      seasonReviews: [],
      franchises: [],
      series: [],
      teambuilds: [],
      spend: { decisions: 0, tokens: null, reasoningTokens: null, cost: null },
      usage: [],
      distribution: { speciesDrafted: 0, speciesBuilt: 0, speciesFielded: 0, itemsUsed: 0, topItems: [] },
    };
    const game = {
      runId: 'live-run',
      seriesIndex: 0,
      seriesId: 'series-0',
      stage: 'roundrobin',
      round: 1,
      game: 1,
      games: [1],
      gameWinners: [null],
      sides: [0, 1],
      teamNames: ['Alpha', 'Beta'],
      winner: null,
      live: true,
      snapshot: {
        turn: 1,
        weather: '',
        fields: [],
        sides: {
          p1: { player: 'Alpha', conditions: [], mons: [] },
          p2: { player: 'Beta', conditions: [], mons: [] },
        },
        timers: {
          p1: { seconds: 120, turnSeconds: 45, elapsedSeconds: 0, running: true },
          p2: { seconds: 120, turnSeconds: 45, elapsedSeconds: 0, running: true },
        },
        spend: { p1: { seconds: 0, tokens: 0 }, p2: { seconds: 0, tokens: 0 } },
        log: [],
        decisions: [],
      },
      log: [],
      decisions: [],
      reflections: [],
    };
    window.fetch = (async (input, init) => {
      const target = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
      const url = new URL(target, base);
      const response = (data: unknown) =>
        new window.Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/league') return response(league);
      if (url.pathname === '/api/league/game') {
        gameRequests += 1;
        return response(game);
      }
      return nativeFetch(input, init);
    }) as typeof window.fetch;

    window.eval(bundle);
    await waitFor(() => window.document.querySelector('.matchup-heading')?.textContent?.includes('Alpha') === true);
    assert.equal(window.document.querySelectorAll('.side-timer').length, 2);

    window.location.hash = '#method';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.document.title === 'Method · VGC Model League');
    await waitFor(() => window.document.querySelector('.matchup-heading') === null);
    assert.equal(window.document.querySelectorAll('.side-timer').length, 0);
    const offRouteRequests = gameRequests;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(gameRequests, offRouteRequests);

    window.location.hash = '#leagues/live-run/game-0-1';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => gameRequests > offRouteRequests);
    await waitFor(() => window.document.querySelector('.matchup-heading')?.textContent?.includes('Alpha') === true);
    assert.equal(window.document.querySelectorAll('.side-timer').length, 2);
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});

test('Draft leagues renders an honest route-shaped shell while mutable data loads', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const window = new Window({ url: `${base}#leagues` });
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

    const nativeFetch = window.fetch.bind(window);
    const state = await (await nativeFetch('/api/state')).json();
    let resolveState: ((response: Response) => void) | undefined;
    let resolveLeagues: ((response: Response) => void) | undefined;
    const pendingState = new Promise<Response>((resolve) => {
      resolveState = resolve;
    });
    const pendingLeagues = new Promise<Response>((resolve) => {
      resolveLeagues = resolve;
    });
    window.fetch = (async (input, init) => {
      const target = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
      const url = new URL(target, base);
      if (url.pathname === '/api/state') return pendingState;
      if (url.pathname === '/api/leagues') return pendingLeagues;
      return nativeFetch(input, init);
    }) as typeof window.fetch;

    window.eval(bundle);
    await waitFor(() => window.document.querySelector('.league-card-grid[aria-busy="true"]') !== null);
    const index = window.document.querySelector('.league-index-main');
    assert.ok(index);
    assert.equal(
      window.document.querySelector('.archive-loading-status[role="status"]')?.textContent?.trim(),
      'Loading draft league archive…',
    );
    assert.equal(window.document.querySelectorAll('.league-card-placeholder').length, 6);
    assert.equal(
      window.document.querySelector('.board-snapshot-placeholder[role="status"]')?.textContent?.trim(),
      'Loading draft boards…',
    );

    const response = (data: unknown) =>
      new window.Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    resolveState?.(response(state) as unknown as Response);
    resolveLeagues?.(response({ leagues: [] }) as unknown as Response);
    await waitFor(() => window.document.querySelector('.results-empty') !== null);
    assert.equal(window.document.querySelector('.league-index-main'), index);
    assert.equal(window.document.querySelector('.league-card-grid[aria-busy="true"]'), null);
    assert.equal(window.document.querySelector('.board-snapshot-placeholder'), null);
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});
