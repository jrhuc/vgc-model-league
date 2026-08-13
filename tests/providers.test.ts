import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiError,
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  nitroSpec,
  parseRoutingPreferences,
  parseSpec,
  toolResultMessage,
  uniqueToolCalls,
  validateModelExecution,
  validateReasoning,
} from '../src/providers.js';

function sseResponse(events: unknown[]): Response {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chatStream(text: string, final: Record<string, unknown> = {}): Response {
  const base = { id: 'gen_1', object: 'chat.completion.chunk', created: 1, model: 'stub' };
  return sseResponse([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...final },
  ]);
}

test('provider specs are exactly OpenRouter, Prime Inference, and random', () => {
  assert.deepEqual(parseSpec('openrouter:anthropic/claude-sonnet-4:nitro'), {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4:nitro',
  });
  assert.deepEqual(parseSpec('prime:Qwen/Qwen3-32B'), {
    provider: 'prime',
    model: 'Qwen/Qwen3-32B',
  });
  assert.deepEqual(parseSpec('random'), { provider: 'random', model: 'random' });
  assert.throws(() => validateReasoning(parseSpec('prime:model'), 'high'), /no advertised configurable reasoning/);
  assert.doesNotThrow(() => validateReasoning(parseSpec('openrouter:model'), 'high'));
  assert.throws(() => validateReasoning(parseSpec('openrouter:model'), 'off' as never), /invalid reasoning level/);

  for (const value of [
    'openrouter:',
    'prime:',
    'prime:-model',
    'openrouter:model name',
    'unknown:model',
    'random:anything',
  ]) {
    assert.throws(() => parseSpec(value), value);
  }
});

test('run-scoped credentials are isolated by exact model spec', async () => {
  assert.throws(
    () =>
      validateModelExecution(['openrouter:model-a', 'prime:model-b'], {
        apiKeys: { 'openrouter:model-a': 'openrouter-key' },
      }),
    /API key missing for prime:model-b/,
  );

  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousPrime = process.env.PRIME_API_KEY;
  process.env.OPENROUTER_API_KEY = 'openrouter-only';
  delete process.env.PRIME_API_KEY;
  try {
    await assert.rejects(makeProvider(parseSpec('prime:model')).complete('system', []), /Missing PRIME_API_KEY/);
    delete process.env.OPENROUTER_API_KEY;
    process.env.PRIME_API_KEY = 'prime-only';
    await assert.rejects(
      makeProvider(parseSpec('openrouter:model')).complete('system', []),
      /Missing OPENROUTER_API_KEY/,
    );
  } finally {
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    if (previousPrime === undefined) delete process.env.PRIME_API_KEY;
    else process.env.PRIME_API_KEY = previousPrime;
  }
});

test('OpenRouter disables fallback and optionally pins exactly one upstream', () => {
  assert.deepEqual(parseRoutingPreferences({} as NodeJS.ProcessEnv), { allow_fallbacks: false });
  assert.deepEqual(parseRoutingPreferences({ VGC_OPENROUTER_PIN: 'deepinfra' } as NodeJS.ProcessEnv), {
    order: ['deepinfra'],
    allow_fallbacks: false,
  });
  assert.throws(
    () => parseRoutingPreferences({ VGC_OPENROUTER_PIN: 'deepinfra,together' } as NodeJS.ProcessEnv),
    /exactly one upstream provider/,
  );
});

test('OpenRouter executes the model spec while recording its pinned upstream as routing metadata', async () => {
  const previousPin = process.env.VGC_OPENROUTER_PIN;
  process.env.VGC_OPENROUTER_PIN = 'deepinfra';
  let url = '';
  let authorization = '';
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    body = JSON.parse(String(init?.body));
    return chatStream('ok', {
      provider: 'DeepInfra',
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.00123 },
    });
  }) as typeof globalThis.fetch;
  try {
    const completion = await makeProvider(parseSpec('openrouter:z-ai/glm-5:nitro'), {
      apiKey: 'openrouter-key',
      reasoning: 'medium',
      fetch,
    }).complete('system', [{ role: 'user', content: 'hello' }]);

    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(authorization, 'Bearer openrouter-key');
    assert.equal(body.model, 'z-ai/glm-5:nitro');
    assert.deepEqual(body.provider, { order: ['deepinfra'], allow_fallbacks: false });
    assert.deepEqual(body.usage, { include: true });
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(completion.provider, 'DeepInfra');
    assert.deepEqual(completion.usage, { input_tokens: 4, output_tokens: 2, cost: 0.00123 });
    assert.equal(completion.finishReason, 'stop');
  } finally {
    if (previousPin === undefined) delete process.env.VGC_OPENROUTER_PIN;
    else process.env.VGC_OPENROUTER_PIN = previousPin;
  }
});

test('Prime uses only its fixed OpenAI-compatible chat endpoint and plain response metadata', async () => {
  let url = '';
  let authorization = '';
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    body = JSON.parse(String(init?.body));
    return chatStream('prime reply', {
      provider: 'must-not-surface',
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 99 },
    });
  }) as typeof globalThis.fetch;

  const completion = await makeProvider(parseSpec('prime:test-model'), {
    apiKey: 'prime-key',
    fetch,
  }).complete('system', [{ role: 'user', content: 'hello' }], { maxTokens: 2222 });

  assert.equal(url, 'https://api.pinference.ai/api/v1/chat/completions');
  assert.equal(authorization, 'Bearer prime-key');
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, 2222);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal('provider' in body, false);
  assert.equal(completion.provider, undefined);
  assert.deepEqual(completion.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal(completion.text, 'prime reply');
});

test('the common compatible stream preserves tools, structured finish reason, and replay messages', async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    const base = { id: 'gen_tool', object: 'chat.completion.chunk', created: 1, model: 'stub' };
    return sseResponse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup_move', arguments: '{"name":"Pro' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'tect"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      },
    ]);
  }) as typeof globalThis.fetch;

  const completion = await makeProvider(parseSpec('prime:tool-model'), { apiKey: 'prime-key', fetch }).complete(
    'system',
    [{ role: 'user', content: 'check Protect' }],
    {
      toolChoice: 'required',
      tools: [
        {
          name: 'lookup_move',
          description: 'Look up a move',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      ],
    },
  );

  assert.match(JSON.stringify(body.tools), /lookup_move/);
  assert.equal(body.tool_choice, 'required');
  assert.equal(completion.finishReason, 'tool-calls');
  assert.deepEqual(completion.toolCalls, [{ id: 'call_1', name: 'lookup_move', arguments: { name: 'Protect' } }]);
  assert.ok(completion.responseMessages?.length, 'the SDK assistant response is retained for replay');
  const replay = assistantToolMessage(completion);
  assert.deepEqual(replay.toolCalls, completion.toolCalls);
  assert.deepEqual(replay.raw, completion.responseMessages);
  assert.deepEqual(toolResultMessage('call_1', 'Protect is a status move'), {
    role: 'tool',
    toolCallId: 'call_1',
    content: 'Protect is a status move',
  });
  assert.deepEqual(uniqueToolCalls([...completion.toolCalls, completion.toolCalls[0]!]), completion.toolCalls);
});

test('compatible HTTP and in-band stream failures preserve retry classification without leaking keys', async () => {
  const failed = makeProvider(parseSpec('prime:failed-model'), {
    apiKey: 'prime-secret',
    fetch: (async () =>
      new Response(JSON.stringify({ error: { message: 'service unavailable prime-secret' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch,
  });
  await assert.rejects(failed.complete('system', [{ role: 'user', content: 'hello' }]), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /prime-secret/);
    assert.match(error.message, /\[redacted\]/);
    assert.deepEqual(classifyProviderFailure(error, 'prime:failed-model'), {
      kind: 'upstream',
      summary: 'Prime Inference API is temporarily unavailable (503).',
      terminal: false,
      pausable: true,
    });
    return true;
  });

  const inBand = makeProvider(parseSpec('openrouter:failed-model'), {
    apiKey: 'openrouter-key',
    fetch: (async () =>
      sseResponse([{ error: { code: 502, message: 'upstream worker failed' } }])) as typeof globalThis.fetch,
  });
  await assert.rejects(inBand.complete('system', [{ role: 'user', content: 'hello' }]), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    return true;
  });
});

test('adapter redacts thrown transport and malformed stream failures', async () => {
  const suppliedKey = 'supplied-provider-secret';
  const environmentKey = 'environment-provider-secret';
  const previous = process.env.PRIME_API_KEY;
  process.env.PRIME_API_KEY = environmentKey;
  const failures: Array<{ label: string; fetch: typeof globalThis.fetch }> = [
    {
      label: 'Error transport',
      fetch: (async () => {
        throw new Error(`transport exposed ${suppliedKey} and ${environmentKey}`);
      }) as typeof globalThis.fetch,
    },
    {
      label: 'primitive transport',
      fetch: (async () => {
        throw suppliedKey;
      }) as typeof globalThis.fetch,
    },
    {
      label: 'malformed stream',
      fetch: (async () =>
        new Response(
          `data: {"secret":"${suppliedKey}"

`,
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        )) as typeof globalThis.fetch,
    },
  ];
  try {
    for (const failure of failures) {
      const provider = makeProvider(parseSpec('prime:redaction-test'), { apiKey: suppliedKey, fetch: failure.fetch });
      await assert.rejects(provider.complete('system', [{ role: 'user', content: 'hello' }]), (error: unknown) => {
        assert.ok(error instanceof Error, failure.label);
        assert.doesNotMatch(error.message, new RegExp(`${suppliedKey}|${environmentKey}`), failure.label);
        return true;
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PRIME_API_KEY;
    else process.env.PRIME_API_KEY = previous;
  }
});

test('nitro routing changes only OpenRouter specs', () => {
  assert.equal(nitroSpec('openrouter:model'), 'openrouter:model:nitro');
  assert.equal(nitroSpec('openrouter:model:floor'), 'openrouter:model:floor');
  assert.equal(nitroSpec('prime:model'), 'prime:model');
  assert.equal(nitroSpec('random'), 'random');
});
