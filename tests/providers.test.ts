import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiError,
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  nitroSpec,
  parseSpec,
  reasoningLevels,
  SdkProvider,
  toolResultMessage,
  validateReasoning,
} from '../src/providers.js';
import type { JsonObject, ProviderMessage } from '../src/types.js';

test('provider specs route aliases and custom endpoints', () => {
  const meta = parseSpec('meta:muse-spark-1.1');
  assert.equal(meta.baseUrl, 'https://api.meta.ai/v1');
  assert.deepEqual(reasoningLevels(meta), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(makeProvider(meta, { apiKey: 'test', reasoning: 'medium' }) instanceof SdkProvider);
  for (const [provider, baseUrl] of Object.entries({
    'opencode-go': 'https://opencode.ai/zen/go/v1',
    'opencode-zen': 'https://opencode.ai/zen/v1',
    vercel: 'https://ai-gateway.vercel.sh/v1',
  })) {
    const spec = parseSpec(`${provider}:vendor/model`);
    assert.deepEqual(spec, { provider, model: 'vendor/model', baseUrl });
    assert.ok(makeProvider(spec, { apiKey: 'test' }) instanceof SdkProvider);
  }
  assert.deepEqual(parseSpec('compat:https://example.test/v1:model'), {
    provider: 'compat',
    baseUrl: 'https://example.test/v1',
    model: 'model',
  });
  assert.deepEqual(parseSpec('compat:http://localhost:11434/v1:qwen2.5:7b'), {
    provider: 'compat',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
  });
  assert.throws(() => parseSpec('human'), /Usage/);
});

test('OpenAI-compatible routers use explicit environment key names', async () => {
  const openCodeKey = process.env.OPENCODE_API_KEY;
  const vercelKey = process.env.AI_GATEWAY_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    for (const provider of ['opencode-go', 'opencode-zen']) {
      await assert.rejects(
        makeProvider(parseSpec(`${provider}:model`)).complete('system', []),
        /Missing OPENCODE_API_KEY/,
      );
    }
    await assert.rejects(makeProvider(parseSpec('vercel:model')).complete('system', []), /Missing AI_GATEWAY_API_KEY/);
  } finally {
    if (openCodeKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = openCodeKey;
    if (vercelKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = vercelKey;
  }
});

test('reasoning levels are validated by model family', () => {
  const meta = parseSpec('meta:muse-spark-1.1');
  validateReasoning(meta, 'xhigh');
  assert.throws(() => validateReasoning(meta, 'max'), /reasoning=max/);
  assert.deepEqual(reasoningLevels(parseSpec('anthropic:claude-opus-4-10')), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('provider failures distinguish terminal capacity from recoverable upstream errors', () => {
  assert.deepEqual(
    classifyProviderFailure(
      new ApiError(429, 'google:gemini-3.6-flash 429: exceeded your current quota; GenerateRequestsPerDay-FreeTier'),
      'google:gemini-3.6-flash',
    ),
    { kind: 'quota', summary: 'Google API quota is exhausted (429).', terminal: true, pausable: true },
  );
  assert.deepEqual(classifyProviderFailure(new ApiError(429, 'rate limit; retry in 20s'), 'google:gemini'), {
    kind: 'rate_limit',
    summary: 'Google API rate limit was reached (429).',
    terminal: false,
    pausable: true,
  });
  assert.deepEqual(
    classifyProviderFailure(
      new ApiError(402, 'This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens'),
      'openrouter:moonshotai/kimi-k3:nitro',
    ),
    { kind: 'quota', summary: 'OpenRouter API credits are exhausted (402).', terminal: true, pausable: true },
  );
  assert.deepEqual(classifyProviderFailure(new ApiError(0, 'request timed out after 55s'), 'openai:gpt'), {
    kind: 'timeout',
    summary: 'OpenAI API request timed out.',
    terminal: false,
    pausable: true,
  });
  assert.deepEqual(classifyProviderFailure(new Error('empty response'), 'opencode-go:deepseek-v4-flash'), {
    kind: 'upstream',
    summary: 'OpenCode Go API returned no usable response.',
    terminal: true,
    retryable: true,
    pausable: true,
  });
  assert.deepEqual(
    classifyProviderFailure(new Error('reasoning exhausted the 16384-token response budget'), 'opencode-go:glm-5.2'),
    {
      kind: 'truncation',
      summary: 'OpenCode Go API spent the whole response budget on reasoning and returned no answer.',
      terminal: false,
    },
  );
  assert.deepEqual(
    classifyProviderFailure(
      new ApiError(
        400,
        'opencode-go:kimi-k3 400: {"error":{"message":"Error from provider (Console Go): Upstream request failed"}}',
      ),
      'opencode-go:kimi-k3',
    ),
    {
      kind: 'upstream',
      summary: 'OpenCode Go API is temporarily unavailable (400).',
      terminal: false,
      pausable: true,
    },
  );
  assert.deepEqual(
    classifyProviderFailure(
      new ApiError(
        429,
        'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier. Please retry in 34.025085268s.',
      ),
      'google:gemini-3.6-flash',
    ),
    {
      kind: 'rate_limit',
      summary: 'Google API rate limit was reached (429).',
      terminal: false,
      pausable: true,
    },
  );
  assert.equal(
    classifyProviderFailure(
      new ApiError(429, 'You exceeded your current quota: GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
      'google:gemini-3.6-flash',
    ).terminal,
    true,
  );
  assert.equal(classifyProviderFailure(new ApiError(401, 'invalid key'), 'anthropic:claude').terminal, true);
  assert.equal(classifyProviderFailure(new ApiError(503, 'overloaded'), 'anthropic:claude').terminal, false);
  assert.equal(classifyProviderFailure(new ApiError(501, 'not implemented'), 'compat:model').terminal, true);
});

test('restart only recognizes vgcleague GUI processes', async () => {
  const { looksLikeGuiCommand } = await import('../src/restart.js');
  assert.equal(looksLikeGuiCommand('node dist/src/cli.js gui --port 8484'), true);
  assert.equal(looksLikeGuiCommand('node /srv/vgcleague gui'), true);
  assert.equal(looksLikeGuiCommand('node server.js --port 8484'), false);
  assert.equal(looksLikeGuiCommand('postgres -D /usr/local/var'), false);
  assert.equal(looksLikeGuiCommand('node dist/src/cli.js rotation --models a b'), false);
});

test('shared tool messages preserve typed calls', () => {
  const completion = {
    text: 'checking',
    usage: {},
    toolCalls: [{ id: 'call_1', name: 'lookup_move', arguments: { name: 'Protect' } }],
  };
  assert.deepEqual(assistantToolMessage(completion), {
    role: 'assistant',
    content: 'checking',
    toolCalls: completion.toolCalls,
  });
  assert.deepEqual(toolResultMessage('call_1', 'Protect is a status move'), {
    role: 'tool',
    toolCallId: 'call_1',
    content: 'Protect is a status move',
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: unknown[], options: { done?: boolean } = {}): Response {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (options.done) frames.push('data: [DONE]\n\n');
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function chatStream(text: string, final: Record<string, unknown> = {}): Response {
  const base = { id: 'gen_1', object: 'chat.completion.chunk', created: 1, model: 'stub' };
  return sseResponse(
    [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...final },
    ],
    { done: true },
  );
}

test('OpenAI uses Responses API with reasoning and tools', async () => {
  let url = '';
  let authorization: string | null = null;
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get('authorization');
    body = JSON.parse(String(init?.body));
    const message = {
      type: 'message',
      role: 'assistant',
      id: 'msg_1',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
    };
    const functionCall = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup_move',
      arguments: '{"name":"Protect"}',
      status: 'completed',
    };
    const response = { id: 'resp_1', created_at: 1, model: 'gpt-5.6-luna', output: [] };
    return sseResponse([
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.output_item.added', output_index: 1, item: { ...functionCall, arguments: '' } },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"name":"Protect"}',
      },
      { type: 'response.output_item.done', output_index: 1, item: functionCall },
      {
        type: 'response.completed',
        response: { ...response, output: [message, functionCall], usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]);
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('openai:gpt-5.6-luna'), {
    apiKey: 'openai-key',
    reasoning: 'medium',
    fetch,
  });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }], {
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
  });

  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(authorization, 'Bearer openai-key');
  assert.equal('temperature' in body, false);
  assert.match(JSON.stringify(body), /lookup_move/);
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  assert.equal(reasoning?.effort ?? body.reasoning_effort, 'medium');
  const { responseMessages, ...rest } = completion;
  assert.deepEqual(rest, {
    text: 'hello',
    finishReason: 'tool-calls',
    usage: { input_tokens: 10, output_tokens: 5 },
    toolCalls: [
      {
        id: 'call_1',
        name: 'lookup_move',
        arguments: { name: 'Protect' },
        providerMetadata: { openai: { itemId: 'fc_1' } },
      },
    ],
  });
  assert.match(JSON.stringify(responseMessages), /msg_1/, 'raw response messages keep provider item ids');
});

test('Gemini thought signatures round-trip through replayed tool calls', async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'estimate_damage', args: { move: 'Surf' } }, thoughtSignature: 'sig-2' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      },
    ]);
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('google:gemini-3.1-flash-lite'), { apiKey: 'google-key', fetch });

  const completion = await provider.complete(
    'system',
    [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'estimate_damage',
            arguments: { move: 'Thunderbolt' },
            providerMetadata: { google: { thoughtSignature: 'sig-1' } },
          },
        ],
      },
      toolResultMessage('call_1', '42%'),
    ],
    {
      tools: [
        {
          name: 'estimate_damage',
          description: 'Estimate damage',
          parameters: {
            type: 'object',
            properties: { move: { type: 'string' } },
            required: ['move'],
            additionalProperties: false,
          },
        },
      ],
    },
  );

  const replayed = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)
    .flatMap((content) => content.parts)
    .find((part) => 'functionCall' in part);
  assert.equal(replayed?.thoughtSignature, 'sig-1');
  assert.deepEqual(completion.toolCalls[0]?.providerMetadata, { google: { thoughtSignature: 'sig-2' } });
});

test('OpenRouter requests buy usage accounting and surface cost and upstream provider', async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return chatStream('ok', {
      provider: 'DeepInfra',
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.00123 },
    });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('openrouter:z-ai/glm-5.2:nitro'), { apiKey: 'or-key', fetch });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(body.model, 'z-ai/glm-5.2:nitro', 'variant suffixes pass through to OpenRouter untouched');
  assert.deepEqual(body.usage, { include: true });
  assert.equal(completion.provider, 'DeepInfra');
  assert.equal(completion.usage.cost, 0.00123);
  assert.equal(completion.usage.input_tokens, 4);
  assert.equal(completion.usage.output_tokens, 2);
});

test('nitroSpec adds routing only to unrouted OpenRouter specs', () => {
  assert.equal(nitroSpec('openrouter:z-ai/glm-5.2'), 'openrouter:z-ai/glm-5.2:nitro');
  assert.equal(nitroSpec('openrouter:z-ai/glm-5.2:nitro'), 'openrouter:z-ai/glm-5.2:nitro');
  assert.equal(nitroSpec('openrouter:deepseek/deepseek-v4:floor'), 'openrouter:deepseek/deepseek-v4:floor');
  assert.equal(nitroSpec('opencode-go:kimi-k3'), 'opencode-go:kimi-k3');
  assert.equal(nitroSpec('anthropic:claude-opus-5'), 'anthropic:claude-opus-5');
});

test('OpenRouter requests for Anthropic models carry cache breakpoints, others stay untouched', async () => {
  let body: Record<string, unknown> = {};
  const fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return chatStream('ok', { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  }) as typeof globalThis.fetch;

  const claude = makeProvider(parseSpec('openrouter:anthropic/claude-opus-5'), { apiKey: 'or-key', fetch });
  await claude.complete('rules', [{ role: 'user', content: 'state' }]);
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const system = messages.find((message) => message.role === 'system');
  const user = messages.find((message) => message.role === 'user');
  assert.deepEqual(system?.content, [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(user?.content, [{ type: 'text', text: 'state', cache_control: { type: 'ephemeral' } }]);

  const glm = makeProvider(parseSpec('openrouter:z-ai/glm-5.2'), { apiKey: 'or-key', fetch });
  await glm.complete('rules', [{ role: 'user', content: 'state' }]);
  const untouched = body.messages as Array<{ role: string; content: unknown }>;
  assert.ok(
    untouched.every((message) => typeof message.content === 'string'),
    'non-Anthropic models keep plain string content',
  );
});

test('OpenRouter routing preferences come from the environment and must be JSON', async () => {
  process.env.VGC_OPENROUTER_PROVIDER = '{"order":["deepinfra"]}';
  try {
    let body: Record<string, unknown> = {};
    const fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return chatStream('ok', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }) as typeof globalThis.fetch;
    const provider = makeProvider(parseSpec('openrouter:qwen/qwen3.7-plus'), { apiKey: 'or-key', fetch });
    const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(body.provider, { order: ['deepinfra'] });
    assert.equal(completion.provider, undefined, 'a response naming no provider adds nothing');
    assert.equal('cost' in completion.usage, false);

    process.env.VGC_OPENROUTER_PROVIDER = 'not json';
    assert.throws(() => makeProvider(parseSpec('openrouter:qwen/qwen3.7-plus'), { apiKey: 'or-key' }), /must be JSON/);
  } finally {
    delete process.env.VGC_OPENROUTER_PROVIDER;
  }
});

test('compat provider uses chat completions', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return chatStream('ok', { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('kimi:kimi-k3'), { apiKey: 'moonshot-key', fetch });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.equal(body.temperature, 0.2);
  assert.equal('reasoning_effort' in body, false);
  const { responseMessages, ...rest } = completion;
  assert.deepEqual(rest, {
    text: 'ok',
    finishReason: 'stop',
    usage: { input_tokens: 4, output_tokens: 2 },
    toolCalls: [],
  });
  assert.equal(responseMessages?.length, 1);
});

test('temperature is dropped after a 400 response', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1)
      return jsonResponse({ error: { message: 'temperature is not supported', type: 'invalid_request_error' } }, 400);
    return chatStream('ok', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('kimi:kimi-k3'), { apiKey: 'moonshot-key', fetch });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(bodies.length, 2);
  assert.equal('temperature' in bodies[0]!, true);
  assert.equal('temperature' in bodies[1]!, false);
  assert.equal(completion.text, 'ok');
});

test('a masked OpenCode upstream 400 retries without temperature', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1)
      return jsonResponse(
        {
          error: {
            message: 'Error from provider (Console Go): Upstream request failed',
            type: 'invalid_request_error',
          },
        },
        400,
      );
    return chatStream('ok', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('opencode-go:kimi-k3'), { apiKey: 'zen-key', fetch });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(bodies.length, 2);
  assert.equal('temperature' in bodies[0]!, true);
  assert.equal('temperature' in bodies[1]!, false);
  assert.equal(completion.text, 'ok');
});

test('API call errors map to ApiError without leaking credentials', async () => {
  const fetch = (async () =>
    new Response('service unavailable for moonshot-key', { status: 503 })) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('kimi:kimi-k3'), { apiKey: 'moonshot-key', fetch });

  await assert.rejects(
    provider.complete('system', [{ role: 'user', content: 'hello' }]),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.message.startsWith('kimi:kimi-k3 503:') &&
      error.message.includes('[redacted]') &&
      !error.message.includes('moonshot-key'),
  );
});

test('OpenRouter preserves in-band error status after generation starts', async () => {
  const fetch = (async () =>
    sseResponse([
      {
        error: {
          code: 502,
          message: 'ResourceExhausted: Worker local total request limit reached (33/32)',
        },
      },
    ])) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('openrouter:nvidia/nemotron-3-super-120b-a12b:free'), {
    apiKey: 'openrouter-key',
    fetch,
  });

  await assert.rejects(
    provider.complete('system', [{ role: 'user', content: 'hello' }]),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 502 &&
      error.message.startsWith('openrouter:nvidia/nemotron-3-super-120b-a12b:free 502:') &&
      error.message.includes('ResourceExhausted'),
  );
});

test('Anthropic maps adaptive reasoning without temperature', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return sseResponse([
      {
        type: 'message_start',
        message: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-opus-4-10',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 6, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('anthropic:claude-opus-4-10'), {
    apiKey: 'anthropic-key',
    reasoning: 'xhigh',
    fetch,
  });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  const outputConfig = body.output_config as Record<string, unknown> | undefined;
  assert.equal(outputConfig?.effort ?? body.effort, 'xhigh');
  assert.equal('temperature' in body, false);
  assert.equal(completion.text, 'hello');
  const system = body.system as Array<Record<string, unknown>>;
  assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral' }, 'the system prefix is a cache breakpoint');
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const lastPart = messages[messages.length - 1]?.content.at(-1);
  assert.deepEqual(lastPart?.cache_control, { type: 'ephemeral' }, 'the conversation tail is a cache breakpoint');
});

test('model overrides reroute specs and follow file edits', async (t) => {
  const { resolveSpecOverride } = await import('../src/providers.js');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-overrides-'));
  const file = path.join(directory, 'overrides.json');
  const previous = process.env.VGC_MODEL_OVERRIDES;
  process.env.VGC_MODEL_OVERRIDES = file;
  t.after(() => {
    if (previous === undefined) delete process.env.VGC_MODEL_OVERRIDES;
    else process.env.VGC_MODEL_OVERRIDES = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(resolveSpecOverride('opencode-go:kimi-k3'), 'opencode-go:kimi-k3', 'no file means no rerouting');

  fs.writeFileSync(file, JSON.stringify({ models: { 'opencode-go:kimi-k3': 'openrouter:moonshotai/kimi-k3' } }));
  assert.equal(resolveSpecOverride('opencode-go:kimi-k3'), 'openrouter:moonshotai/kimi-k3');
  assert.equal(resolveSpecOverride('opencode-go:glm-5.2'), 'opencode-go:glm-5.2', 'unlisted specs pass through');

  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(file, JSON.stringify({ models: {} }));
  fs.utimesSync(file, future, future);
  assert.equal(resolveSpecOverride('opencode-go:kimi-k3'), 'opencode-go:kimi-k3', 'edits apply without a restart');

  fs.writeFileSync(file, 'not json');
  fs.utimesSync(file, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  assert.equal(resolveSpecOverride('opencode-go:kimi-k3'), 'opencode-go:kimi-k3', 'a malformed file reroutes nothing');
});

function anthropicStream(): Response {
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-opus-5',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const REPLAYED_TOOL_LOOP: ProviderMessage[] = [
  { role: 'user', content: 'decide' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_1', name: 'lookup_species', arguments: { name: 'Gengar' } }],
    raw: [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'sig' } } },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup_species', input: { name: 'Gengar' } },
        ],
      },
    ] as unknown as JsonObject[],
  },
  toolResultMessage('call_1', 'Ghost/Poison'),
];

const LOOKUP_TOOL = {
  name: 'lookup_species',
  description: 'look up',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
};

test('anthropic strips replayed thinking blocks unless thinking is enabled', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return anthropicStream();
  }) as typeof globalThis.fetch;

  const plain = makeProvider(parseSpec('anthropic:claude-opus-5'), { apiKey: 'ant-key', fetch });
  await plain.complete('system', REPLAYED_TOOL_LOOP, { tools: [LOOKUP_TOOL] });
  const assistant = (bodies[0]!.messages as { role: string; content: unknown[] }[]).find(
    (m) => m.role === 'assistant',
  )!;
  assert.deepEqual(
    (assistant.content as { type: string }[]).map((part) => part.type),
    ['tool_use'],
  );
  const lastMessage = (bodies[0]!.messages as { content: { cache_control?: unknown }[] }[]).at(-1)!;
  assert.ok(lastMessage.content.at(-1)?.cache_control, 'trailing cache breakpoint survives the strip');

  const thinking = makeProvider(parseSpec('anthropic:claude-opus-5.1'), {
    apiKey: 'ant-key',
    fetch,
    reasoning: 'medium',
  });
  await thinking.complete('system', REPLAYED_TOOL_LOOP, { tools: [LOOKUP_TOOL] });
  const kept = (bodies[1]!.messages as { role: string; content: { type: string }[] }[]).find(
    (m) => m.role === 'assistant',
  )!;
  assert.ok(
    kept.content.some((part) => part.type === 'thinking' || part.type === 'redacted_thinking'),
    'enabled thinking keeps replayed blocks',
  );
});

test('anthropic keeps the trailing cache breakpoint when a round made several tool calls', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return anthropicStream();
  }) as typeof globalThis.fetch;

  const calls = ['call_1', 'call_2', 'call_3', 'call_4'];
  const loop: ProviderMessage[] = [
    { role: 'user', content: 'decide' },
    {
      role: 'assistant',
      content: null,
      toolCalls: calls.map((id) => ({ id, name: 'lookup_species', arguments: { name: id } })),
    },
    ...calls.map((id) => toolResultMessage(id, 'Ghost/Poison')),
  ];

  const provider = makeProvider(parseSpec('anthropic:claude-opus-5'), { apiKey: 'ant-key', fetch });
  await provider.complete('system', loop, { tools: [LOOKUP_TOOL] });

  const messages = bodies[0]!.messages as { role: string; content: { type: string; cache_control?: unknown }[] }[];
  const last = messages.at(-1)!;
  assert.equal(last.role, 'user');
  assert.deepEqual(
    last.content.map((part) => part.type),
    ['tool_result', 'tool_result', 'tool_result', 'tool_result'],
    'consecutive tool results group into one user message',
  );
  assert.ok(last.content.at(-1)!.cache_control, 'grouped tool results keep the trailing cache breakpoint');
});
