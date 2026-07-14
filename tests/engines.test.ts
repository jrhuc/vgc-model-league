import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMEngine } from '../src/engines.js';
import type { BattleRequest, CompleteOptions, Completion, Provider, ProviderMessage } from '../src/types.js';

function request(activeCount = 1): BattleRequest {
  return {
    active: Array.from({ length: activeCount }, () => ({
      moves: [
        { move: 'First', id: 'first', pp: 10, maxpp: 10, target: 'self', disabled: false },
        { move: 'Second', id: 'second', pp: 10, maxpp: 10, target: 'self', disabled: false },
      ],
    })),
    side: {
      pokemon: Array.from({ length: activeCount }, (_, slot) => ({
        ident: `p1: Mon${slot + 1}`,
        details: 'Pikachu, L50',
        condition: '100/100',
        active: true,
        stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
        moves: ['first', 'second'],
        ability: 'static',
        item: '',
      })),
    },
  };
}

class ScriptedProvider implements Provider {
  readonly calls: Array<{ system: string; messages: ProviderMessage[]; options: CompleteOptions }> = [];
  private index = 0;

  constructor(private readonly responses: Array<string | Completion | Error>) {}

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    this.calls.push({ system, messages: structuredClone(messages), options: structuredClone(options) });
    const response = this.responses[this.index++];
    if (response instanceof Error) throw response;
    if (typeof response === 'string')
      return { text: response, usage: { input_tokens: 10, output_tokens: 2 }, toolCalls: [] };
    if (!response) throw new Error('missing scripted response');
    return response;
  }
}

test('LLM choices parse prose, retry, and record fallbacks', async (t) => {
  const cases: Array<[Array<string>, string, boolean, number]> = [
    [['{"choices":[1],"notes":"remember speed"}'], 'move 2', false, 1],
    [['I choose this: {"choices":[1],"notes":"x"}.'], 'move 2', false, 1],
    [['{"choices":[0]} then {"choices":[1]}'], 'move 2', false, 1],
    [['invalid', '{"choices":[1]}'], 'move 2', false, 2],
    [['invalid', '{"choices":[9]}'], 'move 1', true, 2],
  ];
  for (const [responses, expected, fallback, calls] of cases)
    await t.test(expected + responses.join(), async () => {
      const provider = new ScriptedProvider(responses);
      const decisions: Record<string, unknown>[] = [];
      const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });
      assert.equal(await engine.act(request(), { povLines: ['|turn|1'] }), expected);
      assert.equal(decisions[0]!.fallback, fallback);
      assert.deepEqual(engine.decisionStats(), { decisions: 1, fallbacks: Number(fallback) });
      assert.equal(provider.calls.length, calls);
    });
});

test('timer context bounds the provider request', async () => {
  const provider = new ScriptedProvider(['{"choices":[0]}']);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  const timed = request();
  timed.timer = { turnSeconds: 55, seconds: 420 };
  assert.equal(await engine.act(timed, { povLines: [] }), 'move 1');
  const call = provider.calls[0]!;
  assert.match(String(call.messages.at(-1)!.content), /Showdown timer: 55 seconds/);
  assert.ok(call.options.timeout! > 55 && call.options.timeout! <= 56);
});

test('doubles use one call and retain compact private context', async () => {
  const provider = new ScriptedProvider([
    '{"choices":[0,1],"notes":"Garchomp was faster"}',
    '{"choices":[1,0],"notes":"keep the speed read"}',
  ]);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  assert.equal(await engine.act(request(2), { povLines: ['|turn|1'] }), 'move 1, move 2');
  assert.equal(await engine.act(request(2), { povLines: ['|move|p2a: Garchomp|Rock Slide'] }), 'move 2, move 1');
  const prompt = String(provider.calls[1]!.messages.at(-1)!.content);
  assert.match(prompt, /Garchomp was faster/);
  assert.match(prompt, /Chosen joint action: move 1, move 2/);
  assert.match(prompt, /Rock Slide/);
  assert.doesNotMatch(prompt, /\|move\|p2a/);
});

test('provider failures abort and empty responses use a legal fallback', async () => {
  const broken = new LLMEngine('p1', 'broken', {
    provider: new ScriptedProvider([new Error('bad credentials')]),
    decisionLog: [],
  });
  await assert.rejects(broken.act(request(), { povLines: [] }), /bad credentials/);
  assert.deepEqual(broken.decisionStats(), { decisions: 0, fallbacks: 0 });
  const decisions: Record<string, unknown>[] = [];
  const empty = new LLMEngine('p1', 'empty', { provider: new ScriptedProvider(['']), decisionLog: decisions });
  assert.equal(await empty.act(request(), { povLines: [] }), 'move 1');
  assert.equal(decisions[0]!.error, 'empty response');
  assert.deepEqual(empty.decisionStats(), { decisions: 1, fallbacks: 1 });
});

test('tool calls resolve before the final choice', async () => {
  const provider = new ScriptedProvider([
    {
      text: '',
      usage: { input_tokens: 1 },
      toolCalls: [{ id: '1', name: 'lookup_move', arguments: { name: 'Earthquake' } }],
    },
    { text: '{"choices":[1],"notes":"spread"}', usage: { output_tokens: 1 }, toolCalls: [] },
  ]);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  assert.equal(await engine.act(request(), { povLines: [] }), 'move 2');
  assert.equal(provider.calls.length, 2);
  assert.ok(
    provider.calls[1]!.messages.some(
      (message) => message.role === 'assistant' && message.toolCalls?.[0]?.name === 'lookup_move',
    ),
  );
  assert.ok(
    provider.calls[1]!.messages.some(
      (message) => message.role === 'tool' && String(message.content).includes('Earthquake'),
    ),
  );
});

test('abandoned decisions cannot mutate memory or statistics', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider: Provider = {
    async complete() {
      started.resolve();
      await release.promise;
      return { text: '{"choices":[0],"notes":"should not stick"}', usage: {}, toolCalls: [] };
    },
  };
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  const action = engine.act(request(), { povLines: ['|turn|1'] });
  await started.promise;
  engine.abandonDecision();
  release.resolve();
  assert.equal(await action, '');
  assert.deepEqual(engine.decisionStats(), { decisions: 0, fallbacks: 0 });
});
