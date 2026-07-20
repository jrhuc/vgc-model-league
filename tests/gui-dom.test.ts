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
    assert.equal(navButtons.length, 3, 'pool management lives inside run setup, not the top nav');

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
    assert.match(rendered(), /top seeds meet in playoffs/);
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

    const providerDropdown = asButton(window.document.querySelector('#provider'));
    assert.equal(providerDropdown.getAttribute('role'), 'combobox');
    assert.equal(providerDropdown.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(providerDropdown.textContent?.trim(), 'Anthropic');
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});
