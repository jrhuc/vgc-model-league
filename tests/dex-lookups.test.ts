import assert from 'node:assert/strict';
import test from 'node:test';

import { createBoardSearch } from '../src/board-search.js';
import { completeWithDexTools, TOOL_BUDGET_NOTICE } from '../src/dex-lookups.js';
import { loadBoard } from '../src/draft.js';
import { defaultPsDir } from '../src/paths.js';
import { ShowdownReference } from '../src/reference.js';
import type { CompleteOptions, Completion, Provider, ProviderMessage } from '../src/types.js';

const POLICY = {
  maxTokens: 4096,
  timeoutSeconds: 10,
  toolRounds: 2,
  maxCallsPerRound: 2,
  providerRetries: 1,
  retryBaseMs: 1,
};

function reply(partial: Partial<Completion>): Completion {
  return { text: '', usage: {}, toolCalls: [], ...partial };
}

function scriptedProvider(
  replies: Completion[],
  calls: { messages: ProviderMessage[]; options?: CompleteOptions }[],
): Provider {
  return {
    complete: (_system, messages, options) => {
      calls.push({ messages: messages.map((m) => ({ ...m })), ...(options === undefined ? {} : { options }) });
      const next = replies.shift();
      if (!next) throw new Error('scripted provider ran out of replies');
      return Promise.resolve(next);
    },
  };
}

test('tool calls written as text are executed instead of failing the attempt', async () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const calls: { messages: ProviderMessage[]; options?: CompleteOptions }[] = [];
  const provider = scriptedProvider(
    [
      reply({ text: '{"name": "lookup_species", "args": {"name": "Basculegion-Male"}}' }),
      reply({ text: '{"sets": []}' }),
    ],
    calls,
  );
  const lookups: { name: string; result: string }[] = [];
  const messages: ProviderMessage[] = [{ role: 'user', content: 'build' }];
  const completion = await completeWithDexTools({
    provider,
    system: 'sys',
    messages,
    spec: 'openrouter:thinkingmachines/inkling',
    reference,
    policy: POLICY,
    onLookup: (call) => lookups.push({ name: call.name, result: call.result }),
  });
  assert.equal(completion.text, '{"sets": []}');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0]!.name, 'lookup_species');
  assert.match(lookups[0]!.result, /Species Basculegion:/);
  const followUp = calls[1]!.messages.at(-1)!;
  assert.equal(followUp.role, 'user');
  assert.match(String(followUp.content), /Tool result for lookup_species: - Species Basculegion:/);
});

test('fractional provider cost survives usage accumulation across tool rounds', async () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const calls: { messages: ProviderMessage[]; options?: CompleteOptions }[] = [];
  const toolCall = { id: 'call-1', name: 'lookup_species', arguments: { name: 'Gengar' } };
  const provider = scriptedProvider(
    [
      reply({ toolCalls: [toolCall], usage: { input_tokens: 100, output_tokens: 50, cost: 0.031 } }),
      reply({ text: '{"sets": []}', usage: { input_tokens: 200, output_tokens: 80, cost: 0.0205 } }),
    ],
    calls,
  );
  const completion = await completeWithDexTools({
    provider,
    system: 'sys',
    messages: [{ role: 'user', content: 'build' }],
    spec: 'openrouter:moonshotai/kimi-k3',
    reference,
    policy: POLICY,
  });
  assert.ok(Math.abs((completion.usage.cost ?? 0) - 0.0515) < 1e-9, 'sub-dollar costs must not truncate to zero');
  assert.equal(completion.usage.input_tokens, 300);
});

test('exhausting the tool budget is announced before the forced-text round', async () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const calls: { messages: ProviderMessage[]; options?: CompleteOptions }[] = [];
  const toolCall = { id: 'call-1', name: 'lookup_species', arguments: { name: 'Gengar' } };
  const provider = scriptedProvider(
    [
      reply({ toolCalls: [toolCall] }),
      reply({ toolCalls: [{ ...toolCall, id: 'call-2' }] }),
      reply({ text: '{"sets": []}' }),
    ],
    calls,
  );
  const messages: ProviderMessage[] = [{ role: 'user', content: 'build' }];
  const completion = await completeWithDexTools({
    provider,
    system: 'sys',
    messages,
    spec: 'google:gemini-3.6-flash',
    reference,
    policy: POLICY,
  });
  assert.equal(completion.text, '{"sets": []}');
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.options?.toolChoice, 'none');
  assert.equal(calls[2]!.messages.at(-1)!.content, TOOL_BUDGET_NOTICE);
  assert.ok(!calls[1]!.messages.some((m) => m.content === TOOL_BUDGET_NOTICE));
});

test('search_board is offered and dispatched only when a board search is supplied', async () => {
  const reference = new ShowdownReference('gen9championsvgc2026regmb');
  const boardSearch = createBoardSearch(loadBoard('regmb-202607'), defaultPsDir());
  const toolCall = { id: 'call-1', name: 'search_board', arguments: { learns: 'Fake Out', max_cost: 20, limit: 5 } };

  const withoutBoard: { messages: ProviderMessage[]; options?: CompleteOptions }[] = [];
  await completeWithDexTools({
    provider: scriptedProvider([reply({ text: '{"pick": "gengar-mega"}' })], withoutBoard),
    system: 'sys',
    messages: [{ role: 'user', content: 'pick' }],
    spec: 'test:model',
    reference,
    policy: POLICY,
  });
  const plainTools = (withoutBoard[0]!.options?.tools ?? []).map((tool) => tool.name);
  assert.ok(!plainTools.includes('search_board'), 'stages without a board never see the tool');

  const calls: { messages: ProviderMessage[]; options?: CompleteOptions }[] = [];
  const lookups: { name: string; result: string }[] = [];
  const completion = await completeWithDexTools({
    provider: scriptedProvider([reply({ toolCalls: [toolCall] }), reply({ text: '{"pick": "incineroar"}' })], calls),
    system: 'sys',
    messages: [{ role: 'user', content: 'pick' }],
    spec: 'test:model',
    reference,
    boardSearch,
    policy: POLICY,
    onLookup: (call) => lookups.push({ name: call.name, result: call.result }),
  });
  const draftTools = (calls[0]!.options?.tools ?? []).map((tool) => tool.name);
  assert.ok(draftTools.includes('search_board'), 'the draft offers the board tool alongside the dex tools');
  assert.ok(draftTools.includes('lookup_species'), 'the dex tools are still offered');
  assert.equal(completion.text, '{"pick": "incineroar"}');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0]!.name, 'search_board');
  assert.match(lookups[0]!.result, /Board search: \d+ match/);
  assert.match(lookups[0]!.result, /incineroar \| /);
});
