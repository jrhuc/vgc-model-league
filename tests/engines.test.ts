import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMEngine } from '../src/engines.js';
import { ApiError } from '../src/providers.js';
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

const decision = (
  choices: number[],
  rationale = 'test choice',
  notebook = '',
  threats: string[] = ['threat'],
  candidates: string[] = ['candidate'],
) => JSON.stringify({ choices, rationale, notebook, threats, candidates });

const emptyStats = {
  decisions: 0,
  fallbacks: 0,
  reflections: 0,
  reflection_fallbacks: 0,
  move_selections: 0,
  switch_selections: 0,
  protect_selections: 0,
  consecutive_protect_selections: 0,
  ally_target_selections: 0,
  spread_move_selections: 0,
  mega_selections: 0,
  tool_lookups: 0,
  repeated_joint_actions: 0,
  team_previews: 0,
  bring_changes: 0,
  lead_changes: 0,
};
const oneMoveStats = { ...emptyStats, decisions: 1, move_selections: 1 };

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

test('LLM choices parse prose, retry, and record fallbacks', async () => {
  const cases: Array<[Array<string>, string, boolean, number]> = [
    [[decision([1], 'remember speed', 'remember speed')], 'move 2', false, 1],
    [[`I choose this: ${decision([1], 'reason', 'x')}.`], 'move 2', false, 1],
    [[`${decision([0])} then ${decision([1])}`], 'move 2', false, 1],
    [['{"choices":[1],"notes":"legacy"}', decision([1])], 'move 2', false, 2],
    [['invalid', decision([1])], 'move 2', false, 2],
    [['invalid', decision([9])], 'move 1', true, 2],
  ];
  for (const [responses, expected, fallback, calls] of cases) {
    const provider = new ScriptedProvider(responses);
    const decisions: Record<string, unknown>[] = [];
    const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });
    assert.equal(await engine.act(request(), { povLines: ['|turn|1'] }), expected);
    assert.equal(decisions[0]!.fallback, fallback);
    assert.deepEqual(engine.decisionStats(), { ...oneMoveStats, fallbacks: Number(fallback) });
    assert.equal(provider.calls.length, calls);
  }
});

test('timer context bounds the provider request', async () => {
  const provider = new ScriptedProvider([decision([0])]);
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
    decision([0, 1], 'Preserve the observed speed order.', 'Garchomp was faster'),
    decision([1, 0], 'Use the speed read.', 'keep the speed read'),
  ]);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  assert.equal(
    await engine.act(request(2), { povLines: ['|switch|p2a: Garchomp|Garchomp, L50|100/100', '|turn|1'] }),
    'move 1, move 2',
  );
  assert.equal(await engine.act(request(2), { povLines: ['|move|p2a: Garchomp|Rock Slide'] }), 'move 2, move 1');
  const prompt = String(provider.calls[1]!.messages.at(-1)!.content);
  assert.match(prompt, /Garchomp was faster/);
  assert.match(prompt, /Decision: move 1, move 2/);
  assert.match(prompt, /Rock Slide/);
  assert.doesNotMatch(prompt, /\|move\|p2a/);
  assert.doesNotMatch(prompt, /\bL50\b/);
});

test('provider failures abort and empty responses use a legal fallback', async () => {
  const broken = new LLMEngine('p1', 'broken', {
    provider: new ScriptedProvider([new Error('bad credentials')]),
    decisionLog: [],
  });
  await assert.rejects(broken.act(request(), { povLines: [] }), /bad credentials/);
  assert.deepEqual(broken.decisionStats(), emptyStats);

  const decisions: Record<string, unknown>[] = [];
  const empty = new LLMEngine('p1', 'empty', { provider: new ScriptedProvider(['']), decisionLog: decisions });
  assert.equal(await empty.act(request(), { povLines: [] }), 'move 1');
  assert.equal(decisions[0]!.error, 'empty response');
  assert.deepEqual(empty.decisionStats(), { ...oneMoveStats, fallbacks: 1 });
});

test('transient API errors retry before falling back', async () => {
  const decisions: Record<string, unknown>[] = [];
  const flaky = new LLMEngine('p1', 'flaky', {
    provider: new ScriptedProvider([new ApiError(503, 'overloaded'), decision([1])]),
    decisionLog: decisions,
  });
  assert.equal(await flaky.act(request(), { povLines: [] }), 'move 2');
  assert.deepEqual(flaky.decisionStats(), oneMoveStats);

  const persistentProvider = new ScriptedProvider([
    new ApiError(503, 'overloaded'),
    new ApiError(503, 'overloaded'),
    new ApiError(503, 'overloaded'),
  ]);
  const persistent = new LLMEngine('p1', 'persistent', {
    provider: persistentProvider,
    decisionLog: [],
  });
  await assert.rejects(persistent.act(request(), { povLines: [] }), /overloaded/);
  assert.equal(persistentProvider.calls.length, 3);
});

test('tool calls resolve before the final choice', async () => {
  const provider = new ScriptedProvider([
    {
      text: '',
      usage: { input_tokens: 1 },
      toolCalls: [{ id: '1', name: 'lookup_move', arguments: { name: 'Earthquake' } }],
    },
    { text: decision([1], 'spread', 'spread'), usage: { output_tokens: 1 }, toolCalls: [] },
  ]);
  const traces: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [], traceLog: traces });
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
  assert.deepEqual((traces[0]!.tool_calls as Array<Record<string, unknown>>)[0]!.arguments, { name: 'Earthquake' });
  assert.match(String((traces[0]!.tool_calls as Array<Record<string, unknown>>)[0]!.result), /BP 100/);
});

test('readable decisions, technical traces, and post-game reflections stay separate', async () => {
  const provider = new ScriptedProvider([
    decision([1], 'Second is safer into the shown board.', 'Preserve Mon1 for the endgame.'),
    JSON.stringify({
      summary: 'Won by preserving the endgame attacker.',
      adjustment: 'Keep tracking opposing speed order.',
      notebook: 'Mon1 is the preferred endgame; verify opposing speed order.',
    }),
  ]);
  const decisions: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions, traceLog: traces });
  engine.beginGame({ gameId: 'game-1', gameNumber: 1, seriesId: 'series-1' });
  assert.equal(await engine.act(request(), { povLines: ['|turn|1'] }), 'move 2');
  await engine.endGame({
    gameNumber: 1,
    outcome: { winner: 'p1-scripted', won: true, turns: 1, errors: 0, fallbacks: 0 },
    seriesScore: { p1: 1, p2: 0 },
  });

  assert.equal(decisions[0]!.kind, 'decision');
  assert.equal(decisions[0]!.rationale, 'Second is safer into the shown board.');
  assert.equal(decisions[0]!.notebook, 'Preserve Mon1 for the endgame.');
  assert.ok(!('raw_response' in decisions[0]!));
  assert.ok(!('menus' in decisions[0]!));
  assert.equal(decisions[1]!.kind, 'game_reflection');
  assert.match(String(decisions[1]!.adjustment), /speed order/);
  assert.equal(traces[0]!.kind, 'decision_trace');
  assert.ok('prompt' in traces[0]! && 'raw_response' in traces[0]! && 'menus' in traces[0]!);
  assert.equal(traces[1]!.kind, 'reflection_trace');
  assert.match(provider.calls[1]!.system, /reviewing one completed game/);
  assert.deepEqual(engine.decisionStats(), {
    ...oneMoveStats,
    reflections: 1,
  });
});

test('readable logs suppress unchanged notebooks and tendency counters remain post-hoc', async () => {
  const protectRequest = request();
  protectRequest.active![0]!.moves = [
    { move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self', disabled: false },
    { move: 'Second', id: 'second', pp: 10, maxpp: 10, target: 'self', disabled: false },
  ];
  protectRequest.side!.pokemon![0]!.moves = ['protect', 'second'];
  const logs: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', {
    provider: new ScriptedProvider([
      decision([0], 'Scout once.', 'Preserve the attacker.'),
      decision([0], 'Accept the consecutive-use risk.', 'Preserve the attacker.'),
    ]),
    decisionLog: logs,
  });
  engine.beginGame({ gameId: 'game-1', gameNumber: 1, seriesId: 'series-1' });
  await engine.act(protectRequest, { povLines: ['|turn|1'] });
  await engine.act(protectRequest, { povLines: ['|turn|2'] });

  assert.equal(logs[0]!.notebook, 'Preserve the attacker.');
  assert.ok(!('notebook' in logs[1]!));
  assert.deepEqual(engine.decisionStats(), {
    ...emptyStats,
    decisions: 2,
    move_selections: 2,
    protect_selections: 2,
    consecutive_protect_selections: 1,
    repeated_joint_actions: 1,
  });
});

test('team-preview adaptation counters compare public bring and lead choices', async () => {
  const preview = request();
  preview.teamPreview = true;
  preview.maxChosenTeamSize = 4;
  preview.side!.pokemon = Array.from({ length: 6 }, (_, index) => ({
    ident: `p1: Mon${index + 1}`,
    details: `Species${index + 1}, L50`,
    condition: '100/100',
    active: false,
  }));
  delete preview.active;
  const engine = new LLMEngine('p1', 'scripted', {
    provider: new ScriptedProvider([decision([0, 1, 2, 3]), decision([1, 2, 3, 4])]),
    decisionLog: [],
  });
  engine.beginGame({ gameId: 'game-1', gameNumber: 1, seriesId: 'series-1' });
  await engine.act(preview, { povLines: [] });
  engine.beginGame({ gameId: 'game-2', gameNumber: 2, seriesId: 'series-1' });
  await engine.act(preview, { povLines: [] });
  assert.deepEqual(engine.decisionStats(), {
    ...emptyStats,
    decisions: 2,
    team_previews: 2,
    bring_changes: 1,
    lead_changes: 1,
  });
});

test('abandoned decisions cannot mutate memory or statistics', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider: Provider = {
    async complete() {
      started.resolve();
      await release.promise;
      return { text: decision([0], 'late result', 'should not stick'), usage: {}, toolCalls: [] };
    },
  };
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  const action = engine.act(request(), { povLines: ['|turn|1'] });
  await started.promise;
  engine.abandonDecision();
  release.resolve();
  assert.equal(await action, '');
  assert.deepEqual(engine.decisionStats(), emptyStats);
});
