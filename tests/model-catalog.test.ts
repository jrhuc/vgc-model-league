import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverModels } from '../src/model-catalog.js';
import { PROVIDER_OPTIONS, providerOption } from '../src/provider-registry.js';

test('provider registry is exactly OpenRouter, Prime Inference, the Vercel AI Gateway, OpenCode, and random', () => {
  assert.deepEqual(
    PROVIDER_OPTIONS.map(({ id, baseUrl, envKey, discovery, requiresKey }) => ({
      id,
      baseUrl,
      envKey,
      discovery,
      requiresKey,
    })),
    [
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        discovery: 'list',
        requiresKey: true,
      },
      {
        id: 'prime',
        baseUrl: 'https://api.pinference.ai/api/v1',
        envKey: 'PRIME_API_KEY',
        discovery: 'manual',
        requiresKey: true,
      },
      {
        id: 'gateway',
        baseUrl: 'https://ai-gateway.vercel.sh/v1',
        envKey: 'AI_GATEWAY_API_KEY',
        discovery: 'manual',
        requiresKey: true,
      },
      {
        id: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        envKey: 'OPENCODE_API_KEY',
        discovery: 'list',
        requiresKey: true,
      },
      {
        id: 'opencode-zen',
        baseUrl: 'https://opencode.ai/zen/v1',
        envKey: 'OPENCODE_API_KEY',
        discovery: 'list',
        requiresKey: true,
      },
      {
        id: 'random',
        baseUrl: undefined,
        envKey: undefined,
        discovery: 'none',
        requiresKey: false,
      },
    ],
  );
  assert.equal(providerOption('openai'), undefined);
  assert.equal(providerOption('compat'), undefined);
});

test('OpenRouter discovery uses only its fixed list endpoint and filters non-text models', async () => {
  let calls = 0;
  const models = await discoverModels(providerOption('openrouter')!, 'openrouter-secret', {
    fetch: (async (input, init) => {
      calls += 1;
      assert.equal(String(input), 'https://openrouter.ai/api/v1/models');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer openrouter-secret');
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor/text-z',
              name: 'Text Z',
              supported_parameters: ['tools', 'reasoning'],
              architecture: { output_modalities: ['text'] },
            },
            { id: 'vendor/image', architecture: { output_modalities: ['image'] } },
            {
              id: 'vendor/text-no-reasoning',
              supported_parameters: ['tools'],
              architecture: { output_modalities: ['text'] },
            },
            { id: 'vendor/text-a', architecture: { modality: 'text+image->text' } },
            { id: 'vendor/text-a', supported_parameters: ['reasoning'] },
            { id: 'vendor/evil\u001b[2J', architecture: { output_modalities: ['text'] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch,
  });

  assert.equal(calls, 1, 'discovery performs no separate key or credit lookup');
  assert.deepEqual(models, [
    { id: 'vendor/text-a', supportsReasoning: true },
    { id: 'vendor/text-no-reasoning' },
    { id: 'vendor/text-z', displayName: 'Text Z', supportsReasoning: true },
  ]);
});

test('model discovery requires the OpenRouter key and Prime remains manual without a request', async () => {
  let fetched = false;
  const fakeFetch = (async () => {
    fetched = true;
    throw new Error('must not fetch');
  }) as typeof globalThis.fetch;
  await assert.rejects(discoverModels(providerOption('openrouter')!, undefined, { fetch: fakeFetch }), /OPENROUTER/);
  await assert.rejects(discoverModels(providerOption('opencode-go')!, undefined, { fetch: fakeFetch }), /OPENCODE/);
  await assert.rejects(discoverModels(providerOption('prime')!, 'prime-key', { fetch: fakeFetch }), /manual model IDs/);
  assert.equal(fetched, false);
});

test('OpenCode discovery reads its plain OpenAI-style catalog and filters non-generative ids', async () => {
  const models = await discoverModels(providerOption('opencode-zen')!, 'opencode-secret', {
    fetch: (async (input, init) => {
      assert.equal(String(input), 'https://opencode.ai/zen/v1/models');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opencode-secret');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-fable-5', object: 'model' },
            { id: 'text-embedding-mini', object: 'model' },
            { id: 'grok-code', object: 'model' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch,
  });
  assert.deepEqual(models, [{ id: 'claude-fable-5' }, { id: 'grok-code' }]);
});

test('catalog failures redact the request key', async () => {
  const key = 'openrouter-secret';
  await assert.rejects(
    discoverModels(providerOption('openrouter')!, key, {
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: `invalid ${key}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })) as typeof globalThis.fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    },
  );
});
