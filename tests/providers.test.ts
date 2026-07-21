import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiError,
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningLevels,
  SdkProvider,
  toolResultMessage,
  validateReasoning,
} from '../src/providers.js';

test('provider specs route aliases and custom endpoints', () => {
  const meta = parseSpec('meta:muse-spark-1.1');
  assert.equal(meta.baseUrl, 'https://api.meta.ai/v1');
  assert.deepEqual(reasoningLevels(meta), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(makeProvider(meta, { apiKey: 'test', reasoning: 'medium' }) instanceof SdkProvider);
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
    { kind: 'quota', summary: 'Google API quota is exhausted (429).', terminal: true },
  );
  assert.deepEqual(classifyProviderFailure(new ApiError(429, 'rate limit; retry in 20s'), 'google:gemini'), {
    kind: 'rate_limit',
    summary: 'Google API rate limit was reached (429).',
    terminal: false,
  });
  assert.deepEqual(classifyProviderFailure(new ApiError(0, 'request timed out after 55s'), 'openai:gpt'), {
    kind: 'timeout',
    summary: 'OpenAI API request timed out.',
    terminal: false,
  });
  assert.equal(classifyProviderFailure(new ApiError(401, 'invalid key'), 'anthropic:claude').terminal, true);
  assert.equal(classifyProviderFailure(new ApiError(503, 'overloaded'), 'anthropic:claude').terminal, false);
  assert.equal(classifyProviderFailure(new ApiError(501, 'not implemented'), 'compat:model').terminal, true);
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

test('OpenAI uses Responses API with reasoning and tools', async () => {
  let url = '';
  let authorization: string | null = null;
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get('authorization');
    body = JSON.parse(String(init?.body));
    return jsonResponse({
      id: 'resp_1',
      model: 'gpt-5.6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [{ type: 'output_text', text: 'hello', annotations: [] }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup_move',
          arguments: '{"name":"Protect"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
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
    return jsonResponse({
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
    });
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

test('compat provider uses chat completions', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const fetch = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return jsonResponse({
      id: 'chatcmpl_1',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('kimi:kimi-k3'), { apiKey: 'moonshot-key', fetch });

  const completion = await provider.complete('system', [{ role: 'user', content: 'hello' }]);

  assert.equal(url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.equal(body.temperature, 0.2);
  assert.equal('reasoning_effort' in body, false);
  const { responseMessages, ...rest } = completion;
  assert.deepEqual(rest, {
    text: 'ok',
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
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof globalThis.fetch;
  const provider = makeProvider(parseSpec('kimi:kimi-k3'), { apiKey: 'moonshot-key', fetch });

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
    jsonResponse({
      error: {
        code: 502,
        message: 'ResourceExhausted: Worker local total request limit reached (33/32)',
      },
    })) as typeof globalThis.fetch;
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
    return jsonResponse({
      type: 'message',
      id: 'msg_1',
      model: 'claude-opus-4-10',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 6, output_tokens: 3 },
    });
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
});
