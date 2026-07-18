import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverModels, PROVIDER_OPTIONS, providerOption } from '../src/model-catalog.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('provider options preserve ordering and discovery capabilities', () => {
  assert.deepEqual(
    PROVIDER_OPTIONS.map((provider) => provider.id),
    [
      'anthropic',
      'openai',
      'google',
      'xai',
      'deepseek',
      'kimi',
      'openrouter',
      'cerebras',
      'meta',
      'zai',
      'compat',
      'random',
    ],
  );
  assert.deepEqual(
    PROVIDER_OPTIONS.map((provider) => provider.discovery),
    ['list', 'list', 'list', 'list', 'list', 'list', 'list', 'list', 'manual', 'manual', 'manual', 'none'],
  );
  assert.equal(providerOption('kimi')?.envKey, 'MOONSHOT_API_KEY');
  assert.equal(providerOption('meta')?.envKey, 'META_MODEL_API_KEY');
  assert.equal(providerOption('openrouter')?.requiresKey, true);
  assert.equal(providerOption('compat')?.requiresKey, false);
  assert.equal(providerOption('random')?.envKey, undefined);
  assert.equal(providerOption('missing'), undefined);
});

test('OpenAI discovery sends bearer auth and filters non-chat modalities', async () => {
  let called = false;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    called = true;
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer openai-secret');
    return jsonResponse({
      data: [
        { id: 'gpt-z', display_name: 'GPT\u0007Z', owned_by: 'openai' },
        { id: 'text-embedding-3-small', owned_by: 'openai' },
        { id: 'whisper-1', owned_by: 'openai' },
        { id: 'babbage-002', owned_by: 'openai' },
        { id: 'gpt-image-1', owned_by: 'openai' },
        { id: 'gpt-3.5-turbo-instruct', owned_by: 'openai' },
        { id: 'gpt-5-pro', owned_by: 'openai' },
        { id: 'gpt-evil\u001b[2J', owned_by: 'openai' },
        { id: 'gpt-a', owned_by: 'team-a' },
        { id: 'gpt-a', owned_by: 'duplicate' },
      ],
    });
  }) as typeof fetch;

  const models = await discoverModels(providerOption('openai')!, 'openai-secret', { fetch: mockFetch });
  assert.equal(called, true);
  assert.deepEqual(models, [
    { id: 'gpt-a', description: 'Owner: team-a' },
    { id: 'gpt-z', displayName: 'GPT Z', description: 'Owner: openai' },
  ]);
});

test('Anthropic discovery follows last_id pagination', async () => {
  const urls: string[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'anthropic-secret');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    if (urls.length === 1) {
      return jsonResponse({
        data: [{ id: 'claude-z', display_name: 'Claude Z' }],
        has_more: true,
        last_id: 'claude-z',
      });
    }
    return jsonResponse({
      data: [{ id: 'claude-a', display_name: 'Claude A' }],
      has_more: false,
      last_id: 'claude-a',
    });
  }) as typeof fetch;

  const models = await discoverModels(providerOption('anthropic')!, 'anthropic-secret', { fetch: mockFetch });
  assert.deepEqual(urls, [
    'https://api.anthropic.com/v1/models',
    'https://api.anthropic.com/v1/models?after_id=claude-z',
  ]);
  assert.deepEqual(models, [
    { id: 'claude-a', displayName: 'Claude A' },
    { id: 'claude-z', displayName: 'Claude Z' },
  ]);
});

test('Google discovery normalizes names and keeps generateContent models across pages', async () => {
  const urls: string[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'google-secret');
    if (urls.length === 1) {
      return jsonResponse({
        models: [
          {
            name: 'models/gemini-z',
            displayName: 'Gemini Z',
            description: 'General purpose',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/embed-content', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'next page',
      });
    }
    return jsonResponse({
      models: [
        { name: 'gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['countTokens', 'generateContent'] },
      ],
    });
  }) as typeof fetch;

  const models = await discoverModels(providerOption('google')!, 'google-secret', { fetch: mockFetch });
  assert.deepEqual(urls, [
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models?pageToken=next+page',
  ]);
  assert.deepEqual(models, [
    { id: 'gemini-a', displayName: 'Gemini A' },
    { id: 'gemini-z', displayName: 'Gemini Z', description: 'General purpose' },
  ]);
});

test('OpenRouter permits unauthenticated catalogs and uses architecture output metadata', async () => {
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return jsonResponse({
      data: [
        {
          id: 'vendor/text-model',
          name: 'Text Model',
          context_length: 128000,
          architecture: { modality: 'text+image->text' },
        },
        { id: 'vendor/image-model', architecture: { output_modalities: ['image'] } },
      ],
    });
  }) as typeof fetch;

  assert.deepEqual(await discoverModels(providerOption('openrouter')!, undefined, { fetch: mockFetch }), [
    { id: 'vendor/text-model', displayName: 'Text Model', description: '128,000 token context' },
  ]);
});

test('discovery deduplicates, sorts, and forwards abort signals', async () => {
  const controller = new AbortController();
  const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    return jsonResponse({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta', name: 'Zeta' }] });
  }) as typeof fetch;

  assert.deepEqual(
    await discoverModels(providerOption('cerebras')!, 'cerebras-secret', {
      fetch: mockFetch,
      signal: controller.signal,
    }),
    [{ id: 'alpha' }, { id: 'zeta', displayName: 'Zeta' }],
  );
});

test('HTTP errors preserve useful provider detail without leaking keys', async () => {
  const secret = 'super-secret-value';
  const mockFetch = (async () =>
    jsonResponse(
      { error: { message: `Invalid credential ${secret}` } },
      { status: 401, statusText: 'Unauthorized' },
    )) as typeof fetch;

  await assert.rejects(discoverModels(providerOption('openai')!, secret, { fetch: mockFetch }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /OpenAI model discovery failed \(401 Unauthorized\): Invalid credential \[redacted\]/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('model discovery rejects oversized responses', async () => {
  const mockFetch = (async () =>
    new Response('{}', {
      headers: { 'content-length': '1000001', 'content-type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(
    discoverModels(providerOption('openai')!, 'key', { fetch: mockFetch }),
    /model catalog response was too large/,
  );
});

test('manual and non-catalog providers reject clearly without making requests', async () => {
  const mockFetch = (async () => {
    throw new Error('fetch should not be called');
  }) as typeof fetch;

  await assert.rejects(
    discoverModels(providerOption('zai')!, 'key', { fetch: mockFetch }),
    /enter a model ID manually/,
  );
  assert.deepEqual(await discoverModels(providerOption('meta')!, 'key', { fetch: mockFetch }), [
    { id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1' },
  ]);
  await assert.rejects(
    discoverModels(providerOption('random')!, undefined, { fetch: mockFetch }),
    /does not have a model catalog/,
  );
});
