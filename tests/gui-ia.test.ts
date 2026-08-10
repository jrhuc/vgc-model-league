import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { Window } from 'happy-dom';
import { loadSelectedTrace } from '../src/gui/selected-trace.js';
import { GuiServer } from '../src/gui/server.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-ia-'));
const TRACE_ARTIFACT = '/api/selected-trace/full.json';
let gui: GuiServer;
let base = '';
let bundle = '';

type TestElement = {
  textContent: string | null;
  getAttribute(name: string): string | null;
};

function element(node: unknown): TestElement {
  assert.ok(node);
  return node as TestElement;
}

before(async () => {
  gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  base = await gui.listen(0);
  const shell = await (await fetch(base)).text();
  const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
  assert.ok(asset);
  bundle = await (await fetch(new URL(asset, base))).text();
});

after(() => {
  gui.close();
  fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('DOM condition was not reached before the test deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function boot(hash = ''): Promise<Window> {
  const window = new Window({ url: `${base}${hash}` });
  window.document.body.innerHTML = '<div id="app"></div>';
  (window as unknown as Record<string, unknown>).EventSource = class {
    onmessage: unknown = null;
    close(): void {}
  };
  window.eval(bundle);
  await waitFor(() => window.document.querySelector('header.app-header') !== null);
  await waitFor(() => activeView(window).querySelector('h1') !== null);
  return window;
}

function activeView(window: Window) {
  const view = window.document.querySelector('main > .view.on:not([hidden])');
  assert.ok(view);
  return view;
}

function route(window: Window, hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event('hashchange'));
}

test('canonical routes expose one H1 and one current navigation destination', async () => {
  const window = await boot();
  const routes = [
    ['', 'Home', 'Home', 'How well does a language model decide when the game is VGC?'],
    ['#method', 'Method', 'Method', 'How the evaluation works'],
    ['#docs', 'Docs', 'Docs', 'Project documentation'],
    ['#leagues', 'Draft leagues', 'Draft leagues', 'Draft leagues.'],
    ['#live', 'Live', 'Live', 'No run in progress'],
    ['#tournaments', 'Tournaments', 'Tournaments', 'Tournaments.'],
    ['#new-run', 'New run', 'New run', 'Set up an'],
  ] as const;
  try {
    for (const [hash, label, title, heading] of routes) {
      route(window, hash);
      await waitFor(() => window.document.title === `${title} · VGC Model League`);
      await waitFor(() => activeView(window).querySelector('h1')?.textContent?.includes(heading) === true);
      assert.equal(activeView(window).querySelectorAll('h1').length, 1);
      assert.equal(window.document.querySelectorAll('.primary-nav a[aria-current="page"]').length, 1);
      assert.equal(window.document.querySelector('.primary-nav a[aria-current="page"]')?.textContent, label);
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('navigation publishes the canonical top-level hashes', async () => {
  const window = await boot();
  try {
    const links = [...window.document.querySelectorAll('.primary-nav a')].map((node) => element(node));
    assert.deepEqual(
      links.map((link) => [link.textContent, link.getAttribute('href')]),
      [
        ['Home', '#'],
        ['Method', '#method'],
        ['Docs', '#docs'],
        ['Draft leagues', '#leagues'],
        ['Live', '#live'],
        ['Tournaments', '#tournaments'],
        ['New run', '#new-run'],
      ],
    );
  } finally {
    await window.happyDOM.close();
  }
});

test('Home and Method render the selected artifact projection and endpoint', async () => {
  const selectedTrace = (await (await fetch(`${base}api/selected-trace`)).json()) as {
    traceId: string;
    draftQuotes: Array<{ text: string; pick: number }>;
    turn: { rationale: string; submittedCommand: string };
  };
  const curated = JSON.parse(
    fs.readFileSync(path.resolve('artifacts/public/landing/circuit-trace-v1/curated.json'), 'utf8'),
  ) as { traceId: string; stages: { draft: { picks: Array<{ quote: { text: string } }> } } };
  const fullBytes = fs.readFileSync(path.resolve('artifacts/public/landing/circuit-trace-v1/full.json'));
  const servedFull = Buffer.from(await (await fetch(`${base}api/selected-trace/full.json`)).arrayBuffer());
  assert.deepEqual(servedFull, fullBytes, 'the endpoint serves the manifest-checked full.json bytes unchanged');
  const full = JSON.parse(fullBytes.toString('utf8')) as {
    events: Array<{
      stage: string;
      event: string;
      seatSubmission: { rationale: string; submittedAction: string };
    }>;
  };
  const battle = full.events.find((event) => event.stage === 'battle' && event.event === 'first-action');
  assert.ok(battle);
  assert.equal(selectedTrace.traceId, curated.traceId);
  assert.equal(selectedTrace.draftQuotes[0]?.text, curated.stages.draft.picks[0]?.quote.text);
  assert.equal(selectedTrace.turn.rationale, battle.seatSubmission.rationale);
  assert.equal(selectedTrace.turn.submittedCommand, battle.seatSubmission.submittedAction);
  assert.deepEqual(Object.keys(selectedTrace.turn), [
    'promptExcerpt',
    'incomingNotebook',
    'rationale',
    'submittedCommand',
    'replayAccepted',
    'choiceIndex',
  ]);

  const window = await boot();
  try {
    await waitFor(() => (activeView(window).textContent ?? '').includes(selectedTrace.draftQuotes[0]!.text));
    assert.ok((activeView(window).textContent ?? '').includes(selectedTrace.draftQuotes[0]!.text));
    assert.ok(
      [...activeView(window).querySelectorAll('a')].some((link) => link.getAttribute('href') === TRACE_ARTIFACT),
    );
    route(window, '#method');
    await waitFor(() => (activeView(window).textContent ?? '').includes(selectedTrace.turn.rationale));
    assert.ok(
      [...activeView(window).querySelectorAll('a')].some((link) => link.getAttribute('href') === TRACE_ARTIFACT),
    );
  } finally {
    await window.happyDOM.close();
  }
});

test('selected-trace loading refuses linked directories and artifact files', () => {
  const source = path.resolve('artifacts/public/landing/circuit-trace-v1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-selected-trace-'));
  const bundle = path.join(root, 'bundle');
  const linkedBundle = path.join(root, 'linked-bundle');
  try {
    fs.cpSync(source, bundle, { recursive: true });
    assert.ok(loadSelectedTrace(bundle).view.traceId);
    fs.symlinkSync(bundle, linkedBundle);
    assert.throws(() => loadSelectedTrace(linkedBundle), /regular directory/);

    const outside = path.join(root, 'outside.json');
    fs.copyFileSync(path.join(bundle, 'full.json'), outside);
    fs.rmSync(path.join(bundle, 'full.json'));
    fs.symlinkSync(outside, path.join(bundle, 'full.json'));
    assert.throws(() => loadSelectedTrace(bundle), /regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public artifact checks allow research locators but reject actual credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-public-artifact-'));
  const write = (full: string) => {
    const curated = '{"traceId":"test"}\n';
    fs.writeFileSync(path.join(directory, 'curated.json'), curated);
    fs.writeFileSync(path.join(directory, 'full.json'), full);
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        artifacts: {
          curated: { path: 'curated.json', sha256: digest(curated) },
          full: { path: 'full.json', sha256: digest(full) },
        },
      }),
    );
  };
  try {
    write(
      `${JSON.stringify({
        seed: 303,
        run_locator: 'runs/20260808T120000.000000Z-public01',
        record_path: '/Users/research/vgc/records/results.jsonl',
        source_directory: '/var/tmp/evidence-source',
        hidden_research_field: 'not a credential',
      })}\n`,
    );
    const allowed = spawnSync(process.execPath, ['tools/check-public-artifacts.mjs', directory], {
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0, allowed.stderr);

    write(`${JSON.stringify({ api_key: `sk-proj-${'a'.repeat(24)}` })}\n`);
    const rejected = spawnSync(process.execPath, ['tools/check-public-artifacts.mjs', directory], {
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /credential/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
