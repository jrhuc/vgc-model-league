import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cliEnvironment } from '../src/cli-provider.js';
import { makeProvider, parseSpec } from '../src/providers.js';

function fakeCli(directory: string): string {
  const executable = path.join(directory, 'fake-cli.mjs');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const prompt = process.argv.find((argument) => argument.startsWith('@'))?.slice(1);
fs.writeFileSync(
  path.join(process.env.TMPDIR ?? '.', 'capture.json'),
  JSON.stringify({
    args: process.argv.slice(2),
    environment: process.env,
    promptMode: prompt ? fs.statSync(prompt).mode & 0o777 : undefined,
  }),
);
process.stdout.write('fake response\\n');
`,
    { mode: 0o700 },
  );
  return executable;
}

function setEnvironment(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('CLI model ids reject option-like and control input while retaining ordinary provider ids', () => {
  for (const value of ['omp:', 'omp:-model', 'omp:model name', 'omp:model\nname', 'omp:model\0name']) {
    assert.throws(() => parseSpec(value), /Usage/);
  }
  for (const value of ['claude-cli:', 'claude-cli:-model', 'claude-cli:model\tname', 'claude-cli:model\0name']) {
    assert.throws(() => parseSpec(value), /Usage/);
  }
  assert.deepEqual(parseSpec('omp:vendor/model:1.2@release+fast-beta'), {
    provider: 'omp',
    model: 'vendor/model:1.2@release+fast-beta',
  });
  assert.deepEqual(parseSpec('claude-cli:claude-sonnet-4-6'), {
    provider: 'claude-cli',
    model: 'claude-sonnet-4-6',
  });
});

test('CLI subprocess environment has an explicit allowlist', () => {
  assert.deepEqual(
    cliEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      ANTHROPIC_API_KEY: 'anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
      GEMINI_API_KEY: 'gemini',
      META_MODEL_API_KEY: 'meta',
      OPENAI_COMPAT_API_KEY: 'compat',
      AI_GATEWAY_API_KEY: 'gateway',
      VGC_DB_URL: 'database-secret',
      VGC_OPENROUTER_PIN: 'also-not-forwarded',
      GITHUB_TOKEN: 'github-secret',
    }),
    {
      PATH: '/bin',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      ANTHROPIC_API_KEY: 'anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
      GEMINI_API_KEY: 'gemini',
      META_MODEL_API_KEY: 'meta',
      OPENAI_COMPAT_API_KEY: 'compat',
      AI_GATEWAY_API_KEY: 'gateway',
    },
  );
});

test('CLI invocation keeps approved credentials, excludes parent secrets, and writes a private prompt', {
  skip: process.platform === 'win32',
}, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-provider-test-'));
  const restore = setEnvironment({
    TMPDIR: scratch,
    VGC_OMP_BIN: fakeCli(scratch),
    ANTHROPIC_API_KEY: 'anthropic-key',
    OPENROUTER_API_KEY: 'openrouter-key',
    VGC_DB_URL: 'database-secret',
    GITHUB_TOKEN: 'github-secret',
  });
  try {
    const completion = await makeProvider(parseSpec('omp:vendor/model:1.2@release+fast-beta')).complete('system', [
      { role: 'user', content: 'hello' },
    ]);
    assert.equal(completion.text, 'fake response');
    const capture = JSON.parse(fs.readFileSync(path.join(scratch, 'capture.json'), 'utf8')) as {
      args: string[];
      environment: Record<string, string | undefined>;
      promptMode: number;
    };
    assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2), [
      '--model',
      'vendor/model:1.2@release+fast-beta',
    ]);
    assert.equal(capture.environment.ANTHROPIC_API_KEY, 'anthropic-key');
    assert.equal(capture.environment.OPENROUTER_API_KEY, 'openrouter-key');
    assert.equal(capture.environment.VGC_DB_URL, undefined);
    assert.equal(capture.environment.GITHUB_TOKEN, undefined);
    assert.equal(capture.promptMode, 0o600);
  } finally {
    restore();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-aborted CLI calls do not spawn and settled calls remove abort listeners', {
  skip: process.platform === 'win32',
}, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-provider-test-'));
  const restore = setEnvironment({ TMPDIR: scratch, VGC_OMP_BIN: fakeCli(scratch) });
  try {
    const provider = makeProvider(parseSpec('omp:model'));
    const completed = new AbortController();
    assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
    await provider.complete('system', [{ role: 'user', content: 'hello' }], { signal: completed.signal });
    assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
    await provider.complete('system', [{ role: 'user', content: 'again' }], { signal: completed.signal });
    assert.equal(getEventListeners(completed.signal, 'abort').length, 0);

    fs.rmSync(path.join(scratch, 'capture.json'), { force: true });
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      provider.complete('system', [{ role: 'user', content: 'never spawn' }], { signal: aborted.signal }),
      /call aborted/,
    );
    assert.equal(fs.existsSync(path.join(scratch, 'capture.json')), false);
    assert.equal(getEventListeners(aborted.signal, 'abort').length, 0);
  } finally {
    restore();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
