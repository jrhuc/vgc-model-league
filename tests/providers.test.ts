import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistantToolMessage,
  makeProvider,
  OpenAIProvider,
  parseSpec,
  reasoningLevels,
  toolResultMessage,
  validateReasoning,
} from '../src/providers.js';

test('provider specs route aliases and custom endpoints', () => {
  const meta = parseSpec('meta:muse-spark-1.1');
  assert.equal(meta.baseUrl, 'https://api.meta.ai/v1');
  assert.deepEqual(reasoningLevels(meta), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.ok(makeProvider(meta, { apiKey: 'test', reasoning: 'medium' }) instanceof OpenAIProvider);
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
