import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { Window } from 'happy-dom';
import { build as buildVite } from 'vite';

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
    (window as unknown as Record<string, unknown>).EventSource = class {
      onmessage: unknown = null;
      close(): void {}
    };
    window.eval(bundle);
    await waitFor(() => window.document.querySelector('main > .view.on:not([hidden]) h1') !== null);
    await waitFor(() => window.document.title === 'Home · VGC Model League');
    assert.equal(window.document.title, 'Home · VGC Model League');
    assert.equal(window.document.querySelectorAll('main > .view.on:not([hidden]) h1').length, 1);
    assert.equal(window.document.querySelector('.primary-nav a[aria-current="page"]')?.textContent, 'Home');
    assert.ok(window.document.querySelector('nav[aria-label="Main navigation"] a[href="#live"]'));
    assert.ok(window.document.querySelector('nav[aria-label="Main navigation"] a[href="#new-run"]'));
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});

test('static client excludes the operational graph and keeps only archive routes', async () => {
  const result = await buildVite({ mode: 'static', logLevel: 'silent' });
  const builds = (Array.isArray(result) ? result : [result]) as Array<{
    output: Array<{ type: string; modules?: Record<string, unknown> }>;
  }>;
  const modules = builds.flatMap((build) =>
    build.output.flatMap((entry) => (entry.type === 'chunk' ? Object.keys(entry.modules ?? {}) : [])),
  );
  assert.ok(modules.some((module) => module.endsWith('/src/gui/client/capabilities-static.ts')));
  assert.ok(modules.some((module) => module.endsWith('/src/gui/client/operational-loader-static.tsx')));
  for (const excluded of [
    '/src/gui/client/capabilities.ts',
    '/src/gui/client/operational-loader.tsx',
    '/src/gui/client/operational-workspace.tsx',
    '/src/gui/client/views/arena.tsx',
    '/src/gui/client/views/fixtures.tsx',
    '/src/gui/client/views/team-editor.tsx',
    '/src/gui/client/lib/run-draft.ts',
    '/src/gui/client/lib/use-model-lineup.ts',
    '/src/gui/client/views/league.tsx',
    '/src/gui/client/views/pools.tsx',
  ]) {
    assert.ok(!modules.some((module) => module.endsWith(excluded)), `${excluded} must not enter a static chunk`);
  }

  const output = path.resolve('dist/gui-static');
  const exportedState = JSON.parse(fs.readFileSync('artifacts/public/site/state.json', 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal('auth' in exportedState, false);
  const shell = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
  assert.ok(asset);
  const bundle = fs.readFileSync(path.resolve(output, asset), 'utf8');
  const window = new Window({ url: 'https://static.example/#live' });
  const requests: Array<{ method: string; pathname: string }> = [];
  let eventSources = 0;
  try {
    window.document.body.innerHTML = '<div id="app"></div>';
    window.fetch = async (input: Parameters<typeof window.fetch>[0], init?: Parameters<typeof window.fetch>[1]) => {
      const url = new URL(String(input instanceof window.Request ? input.url : input), window.location.href);
      requests.push({
        method: input instanceof window.Request ? input.method : (init?.method ?? 'GET'),
        pathname: url.pathname,
      });
      const relative = url.pathname.replace(/^\/data\//, '');
      const file = path.resolve('artifacts/public/site', relative);
      if (!url.pathname.startsWith('/data/') || !fs.existsSync(file)) {
        return new window.Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new window.Response(fs.readFileSync(file), { headers: { 'content-type': 'application/json' } });
    };
    (window as unknown as Record<string, unknown>).EventSource = class {
      constructor() {
        eventSources += 1;
      }
    };
    window.eval(bundle);
    await waitFor(() => window.document.querySelector('header.app-header') !== null);
    await waitFor(() => window.document.title === 'Home · VGC Model League');

    const navigation = window.document.querySelector('nav[aria-label="Main navigation"]');
    assert.ok(navigation);
    assert.equal(navigation.querySelector('a[href="#live"]'), null);
    assert.equal(navigation.querySelector('a[href="#new-run"]'), null);
    assert.ok(navigation.querySelector('a[href="#leagues"]'));
    assert.ok(navigation.querySelector('a[href="#tournaments"]'));
    assert.equal(navigation.querySelector('a[aria-current="page"]')?.textContent, 'Home');
    assert.equal(window.document.querySelector('footer a[href="#live"]'), null);
    assert.equal(window.document.querySelector('footer a[href="#new-run"]'), null);
    assert.ok(window.document.querySelector('footer a[href="#leagues"]'));
    assert.ok(window.document.querySelector('footer a[href="#tournaments"]'));

    for (const hash of ['#live', '#new-run']) {
      window.location.hash = hash;
      window.dispatchEvent(new window.Event('hashchange'));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(window.document.title, 'Home · VGC Model League');
      assert.equal(navigation.querySelector('a[aria-current="page"]')?.textContent, 'Home');
    }

    window.location.hash = '#tournaments';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.document.title === 'Tournaments · VGC Model League');
    await waitFor(() => requests.some((request) => request.pathname === '/data/tournaments.json'));
    assert.equal(navigation.querySelector('a[aria-current="page"]')?.textContent, 'Tournaments');
    assert.equal(eventSources, 0);
    assert.ok(requests.some((request) => request.pathname === '/data/state.json'));
    assert.ok(requests.every((request) => request.method === 'GET'));
    assert.ok(requests.every((request) => request.pathname.startsWith('/data/')));
  } finally {
    await window.happyDOM.close();
  }
});
