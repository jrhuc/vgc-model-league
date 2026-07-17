import assert from 'node:assert/strict';
import test from 'node:test';

import { Window } from 'happy-dom';

import { GuiServer } from '../src/gui/server.js';

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('built client bundle boots and renders the app against the live server', async () => {
  const gui = new GuiServer();
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
    await waitFor(() => rendered().includes('Contender lineup'));
    const text = rendered();
    assert.match(text, /VGC MODEL LEAGUE/);
    assert.match(text, /Contender lineup/);
    assert.match(text, /Control sheet/);
    assert.match(text, /Team pools/);
    assert.match(text, /No agents on the card/);
    const navButtons = window.document.querySelectorAll('.nav-button');
    assert.equal(navButtons.length, 4);

    const poolDropdown = window.document.querySelector('#pool') as HTMLButtonElement | null;
    assert.equal(poolDropdown?.getAttribute('role'), 'combobox');
    assert.ok(
      (window.document.querySelector('.pool-facts')?.textContent ?? '').includes('teams'),
      'selected pool should show its team count',
    );

    const modelSearch = window.document.querySelector('#modelSearch');
    assert.ok(modelSearch, 'model combobox input should render');
    assert.equal(modelSearch.getAttribute('role'), 'combobox');

    const providerDropdown = window.document.querySelector('#provider') as HTMLButtonElement | null;
    assert.equal(providerDropdown?.getAttribute('role'), 'combobox');
    assert.equal(providerDropdown?.textContent?.trim(), 'Anthropic');
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});
