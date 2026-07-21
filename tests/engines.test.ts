import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChoiceSubstitution } from '../src/engines.js';
import { BaseEngine, LLMEngine, RandomEngine } from '../src/engines.js';
import { ApiError } from '../src/providers.js';
import { SimBattle } from '../src/sim.js';
import { loadPool } from '../src/teams.js';
import type {
  AgentContext,
  BattleRequest,
  CompleteOptions,
  Completion,
  Provider,
  ProviderMessage,
} from '../src/types.js';

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
  substituted_actions: 0,
  abandoned_decisions: 0,
  parse_failures: 0,
  provider_retries: 0,
  threat_turns: 0,
  threat_hits: 0,
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
  const cases: Array<[Array<string>, string, boolean, number, number]> = [
    [[decision([1], 'remember speed', 'remember speed')], 'move 2', false, 1, 0],
    [[`I choose this: ${decision([1], 'reason', 'x')}.`], 'move 2', false, 1, 0],
    [[`${decision([0])} then ${decision([1])}`], 'move 2', false, 1, 0],
    [[`${decision([1])} earlier draft was {"choices":[9]}`], 'move 2', false, 1, 0],
    [['{"choices":[1],"notes":"legacy"}', decision([1])], 'move 2', false, 2, 1],
    [['invalid', decision([1])], 'move 2', false, 2, 1],
    [['invalid', decision([9])], 'move 1', true, 2, 2],
  ];
  for (const [responses, expected, fallback, calls, parseFailures] of cases) {
    const provider = new ScriptedProvider(responses);
    const decisions: Record<string, unknown>[] = [];
    const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });
    assert.equal(await engine.act(request(), { povLines: ['|turn|1'] }), expected);
    assert.equal(decisions[0]!.fallback, fallback);
    assert.equal(decisions[0]!.parse_failures, parseFailures);
    assert.deepEqual(engine.decisionStats(), {
      ...oneMoveStats,
      fallbacks: Number(fallback),
      parse_failures: parseFailures,
    });
    assert.equal(provider.calls.length, calls);
  }
});

test('Gemini-like nested candidate objects preserve the complete top-level decision', async () => {
  const longCandidate = 'candidate '.repeat(40);
  const provider = new ScriptedProvider([
    JSON.stringify({
      choices: [1],
      rationale: 'use the top-level choice',
      notebook: 'n'.repeat(1800),
      threats: ['direct threat', { rationale: 'not a threat' }, 7, 'second threat', 'third threat', 'capped'],
      candidates: [
        { choices: [0], rationale: longCandidate, notebook: 'nested notebook' },
        { choices: [0], rationale: 'second nested line', notebook: 'nested notebook' },
        { choices: [0], rationale: 7 },
        { choices: [0], rationale: 'third nested line' },
        { choices: [0], rationale: 'capped line' },
      ],
    }),
  ]);
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });

  assert.equal(await engine.act(request(), { povLines: ['|turn|1'] }), 'move 2');
  assert.equal(provider.calls.length, 1);
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(decisions[0]!.parse_failures, 0);
  assert.equal(decisions[0]!.rationale, 'use the top-level choice');
  assert.equal(String(decisions[0]!.notebook).length, 1600);
  assert.deepEqual(decisions[0]!.threats, ['direct threat', 'second threat', 'third threat']);
  assert.deepEqual(decisions[0]!.candidates, [longCandidate.slice(0, 240), 'second nested line', 'third nested line']);
});

test('missing or malformed optional decision lists default to empty', async () => {
  const provider = new ScriptedProvider([
    JSON.stringify({ choices: [1], rationale: 'complete core decision', notebook: '', threats: { unexpected: true } }),
  ]);
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });

  assert.equal(await engine.act(request(), { povLines: [] }), 'move 2');
  assert.equal(provider.calls.length, 1);
  assert.equal(decisions[0]!.fallback, false);
  assert.deepEqual(decisions[0]!.threats, []);
  assert.deepEqual(decisions[0]!.candidates, []);
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

test('simulator timer restarts while an invalid choice is retried', { timeout: 20_000 }, async () => {
  class InvalidOnceEngine extends RandomEngine {
    private invalid = true;
    readonly timerBanks: number[] = [];

    override async act(battleRequest: BattleRequest, context: AgentContext): Promise<string> {
      if (battleRequest.active && battleRequest.timer?.seconds !== undefined)
        this.timerBanks.push(battleRequest.timer.seconds);
      if (this.invalid && battleRequest.active && !battleRequest.teamPreview) {
        this.invalid = false;
        return 'move 99';
      }
      return super.act(battleRequest, context);
    }
  }

  const pool = loadPool();
  const timerLines: string[] = [];
  const retrying = new InvalidOnceEngine('p1', 1);
  const battle = new SimBattle(
    pool.format,
    {
      p1: { name: 'invalid-once', team: pool.teams[0]!.packed },
      p2: { name: 'random', team: pool.teams[1]!.packed },
    },
    [1, 2, 3, 4],
  );
  const outcome = await battle.run({ p1: retrying, p2: new RandomEngine('p2', 2) }, (lines) =>
    timerLines.push(...lines.filter((line) => line.includes('vgctimer'))),
  );
  assert.ok(outcome.errors.p1 >= 1);
  assert.ok(retrying.timerBanks[1]! < retrying.timerBanks[0]!);
  assert.equal(
    timerLines.filter((line) => line.startsWith('|-vgctimer|p1|')).length,
    timerLines.filter((line) => line === '|-vgctimerstop|p1').length,
  );
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
  assert.match(prompt, /Garchomp; types Dragon\/Ground/);
  assert.match(prompt, /Rock Slide \[Rock\/Physical\/75\/spread\]/);
  assert.doesNotMatch(prompt, /Compact Showdown reference/);
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

test('non-transient provider failures with a live timer fail the run', async () => {
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'dead', {
    provider: new ScriptedProvider([new ApiError(401, 'invalid key')]),
    decisionLog: decisions,
  });
  const timed = request();
  timed.timer = { turnSeconds: 55, seconds: 420 };
  await assert.rejects(engine.act(timed, { povLines: [] }), /invalid key/);
  assert.deepEqual(decisions, []);
  assert.deepEqual(engine.decisionStats(), emptyStats);
});

test('transient provider failures with a live timer leave the choice to the battle timer', async () => {
  const decisions: Record<string, unknown>[] = [];
  const logged = Promise.withResolvers<void>();
  const engine = new LLMEngine('p1', 'dead', {
    provider: new ScriptedProvider([new ApiError(503, 'overloaded')]),
    decisionLog: (row) => {
      decisions.push(row);
      logged.resolve();
    },
  });
  const timed = request();
  timed.timer = { turnSeconds: 10, seconds: 420 };
  let resolved = false;
  const pending = engine.act(timed, { povLines: [] }).then((choice) => {
    resolved = true;
    return choice;
  });
  await logged.promise;
  assert.equal(resolved, false, 'the engine waits for the battle timer instead of throwing');
  assert.equal(decisions[0]!.action, 'abandoned');
  assert.equal(decisions[0]!.fallback, true);
  assert.match(String(decisions[0]!.error), /overloaded/);
  assert.deepEqual(engine.decisionStats(), { ...emptyStats, abandoned_decisions: 1 });
  engine.abandonDecision();
  assert.equal(await pending, '');
});

test('transient API errors retry before falling back', async () => {
  const decisions: Record<string, unknown>[] = [];
  const flaky = new LLMEngine('p1', 'flaky', {
    provider: new ScriptedProvider([new ApiError(503, 'overloaded'), decision([1])]),
    decisionLog: decisions,
  });
  assert.equal(await flaky.act(request(), { povLines: [] }), 'move 2');
  assert.deepEqual(flaky.decisionStats(), { ...oneMoveStats, provider_retries: 1 });

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

test('two capped tool batches resolve before the final choice', async () => {
  const provider = new ScriptedProvider([
    {
      text: '',
      usage: { input_tokens: 1 },
      toolCalls: [
        { id: '1', name: 'lookup_move', arguments: { name: 'Earthquake' } },
        { id: '2', name: 'lookup_move', arguments: { name: 'Protect' } },
        { id: '3', name: 'lookup_move', arguments: { name: 'Tailwind' } },
      ],
    },
    {
      text: '',
      usage: { input_tokens: 1 },
      toolCalls: [
        { id: '4', name: 'lookup_species', arguments: { name: 'Garchomp' } },
        { id: '5', name: 'lookup_species', arguments: { name: 'Dragonite' } },
        { id: '6', name: 'lookup_species', arguments: { name: 'Gholdengo' } },
      ],
    },
    { text: decision([1], 'spread', 'spread'), usage: { output_tokens: 1 }, toolCalls: [] },
  ]);
  const traces: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [], traceLog: traces });
  assert.equal(await engine.act(request(), { povLines: [] }), 'move 2');
  assert.equal(provider.calls.length, 3);
  assert.equal(provider.calls[0]!.options.maxTokens, 4096);
  assert.equal(provider.calls[0]!.options.toolChoice, 'auto');
  assert.equal(provider.calls[1]!.options.toolChoice, 'auto');
  assert.equal(provider.calls[2]!.options.toolChoice, 'none');
  const replayedCalls = provider.calls[2]!.messages.filter((message) => message.role === 'assistant').flatMap(
    (message) => message.toolCalls ?? [],
  );
  assert.deepEqual(
    replayedCalls.map((call) => call.name),
    ['lookup_move', 'lookup_move', 'lookup_species', 'lookup_species'],
  );
  assert.doesNotMatch(JSON.stringify(provider.calls[2]!.messages), /Tailwind|Gholdengo/);
  const toolTrace = traces[0]!.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolTrace.length, 4);
  assert.match(String(toolTrace[0]!.result), /BP 100/);
  assert.match(String(toolTrace[2]!.result), /Garchomp/);
});

test('one action-order call may accompany two standard calls in the single tool round', async () => {
  const provider = new ScriptedProvider([
    {
      text: '',
      usage: {},
      toolCalls: [
        {
          id: '1',
          name: 'estimate_damage',
          arguments: { attacker: 'Gengar-Mega', defender: 'Garchomp', move: 'Shadow Ball' },
        },
        { id: '2', name: 'lookup_move', arguments: { name: 'Shadow Ball' } },
        {
          id: '3',
          name: 'compare_action_order',
          arguments: { first: 'ally 1', first_move: 'Shadow Ball', second: 'foe 1', second_move: 'Earthquake' },
        },
      ],
    },
    { text: decision([0]), usage: {}, toolCalls: [] },
  ]);
  const traces: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [], traceLog: traces });
  const orderedRequest = request();
  orderedRequest.active![0]!.moves = [
    { move: 'Shadow Ball', id: 'shadowball', pp: 10, maxpp: 10, target: 'normal', disabled: false },
    { move: 'Protect', id: 'protect', pp: 10, maxpp: 10, target: 'self', disabled: false },
  ];
  orderedRequest.side!.pokemon![0]!.details = 'Gengar-Mega, L50';
  orderedRequest.side!.pokemon![0]!.stats = { spe: 170 };
  orderedRequest.side!.pokemon![0]!.moves = ['shadowball', 'protect'];
  const action = engine.act(orderedRequest, {
    povLines: [
      '|showteam|p2|Garchomp||LifeOrb|RoughSkin|Earthquake|Jolly|||||50',
      '|switch|p1a: Mon1|Gengar-Mega, L50|165/165',
      '|switch|p2a: Garchomp|Garchomp, L50|100/100',
    ],
  });
  assert.equal(await action, 'move 1');
  assert.ok(provider.calls[0]!.options.tools?.some((tool) => tool.name === 'compare_action_order'));
  const replayed = provider.calls[1]!.messages.filter((message) => message.role === 'assistant').flatMap(
    (message) => message.toolCalls ?? [],
  );
  assert.deepEqual(
    replayed.map((call) => call.name),
    ['estimate_damage', 'lookup_move', 'compare_action_order'],
  );
  const toolTrace = traces[0]!.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolTrace.length, 3);
  assert.match(String(toolTrace[2]!.result), /Gengar-Mega is guaranteed to act first/);
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
  assert.equal(decisions[1]!.series_over, false);
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

test('game transcripts reset while notebook and score persist, with a 2400-character cap', async () => {
  const provider = new ScriptedProvider([
    decision([0], 'game one', 'durable series note'),
    decision([0], 'game two', 'durable series note'),
    decision([0], 'after oversized event', 'durable series note'),
  ]);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  engine.beginGame({
    gameId: 'game-1',
    gameNumber: 1,
    seriesId: 'series-1',
    seriesScore: { p1: 1, p2: 0 },
  });
  engine.observe(['|move|p2a: OldMon|Ancient Memory|p1a: Mon1']);
  await engine.act(request(), { povLines: [] });

  engine.beginGame({ gameId: 'game-2', gameNumber: 2, seriesId: 'series-1' });
  await engine.act(request(), { povLines: [] });
  const nextGamePrompt = String(provider.calls[1]!.messages[0]!.content);
  assert.doesNotMatch(nextGamePrompt, /Ancient Memory|\[Game 1 begins/);
  assert.match(nextGamePrompt, /\[Game 2 begins; series score p1 1, p2 0\]/);
  assert.match(nextGamePrompt, /Private notebook: durable series note/);
  assert.match(nextGamePrompt, /Series series-1; game 2; score p1 1, p2 0/);

  engine.observe([`|move|p2a: NewMon|${'x'.repeat(2600)}LATEST|p1a: Mon1`]);
  await engine.act(request(), { povLines: [] });
  const cappedPrompt = String(provider.calls[2]!.messages[0]!.content);
  const timelineMarker = 'Compact private battle timeline (your POV):\n';
  const timeline = cappedPrompt
    .slice(cappedPrompt.indexOf(timelineMarker) + timelineMarker.length)
    .split('\n\nChoose for ')[0]!;
  assert.equal(timeline.length, 2400);
  assert.match(timeline, /LATEST into Mon1\.$/);
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

test('the closing review of a decided series is marked series_over', async () => {
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider: new ScriptedProvider([]), decisionLog: decisions });
  engine.beginGame({ gameId: 'game-2', gameNumber: 2, seriesId: 'series-1', seriesScore: { p1: 1, p2: 0 } });
  await engine.endGame({
    gameNumber: 2,
    outcome: { winner: 'p1-scripted', won: true, turns: 9 },
    seriesScore: { p1: 2, p2: 0 },
  });
  assert.equal(decisions[0]!.kind, 'game_reflection');
  assert.equal(decisions[0]!.series_over, true);
  assert.equal(decisions[0]!.fallback, true);
});

function megaRequest(): BattleRequest {
  const base = request(2);
  base.active = base.active!.map((active) => ({ ...active!, canMegaEvo: true }));
  return base;
}

test('a double-Mega joint choice is retried with the conflict explained, not silently defaulted', async () => {
  const provider = new ScriptedProvider([decision([1, 1], 'mega both'), decision([1, 0], 'mega one')]);
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });
  assert.equal(await engine.act(megaRequest(), { povLines: ['|turn|1'] }), 'move 1 mega, move 1');
  assert.equal(provider.calls.length, 2);
  assert.match(String(provider.calls[1]!.messages.at(-1)!.content), /only one Pokémon can Mega Evolve/);
  assert.equal(decisions[0]!.fallback, false);
  assert.equal(decisions[0]!.rationale, 'mega one');
  assert.ok(!('requested_choices' in decisions[0]!));
});

test('a persistent illegal joint choice becomes a flagged legal fallback', async () => {
  const provider = new ScriptedProvider([decision([1, 1], 'mega both'), decision([1, 1], 'mega both again')]);
  const decisions: Record<string, unknown>[] = [];
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: decisions });
  assert.equal(await engine.act(megaRequest(), { povLines: ['|turn|1'] }), 'move 1, move 1');
  assert.equal(decisions[0]!.fallback, true);
  assert.equal(decisions[0]!.rationale, 'Recorded legal fallback.');
  assert.equal(decisions[0]!.parse_failures, 2);
});

test('engines that commit conflicting choices record the substitution', async () => {
  class FixedEngine extends BaseEngine {
    committed: { choices: number[]; parts: string[]; substitution?: ChoiceSubstitution } | undefined;
    protected decideJoint(): number[] {
      return [1, 1];
    }
    protected override actionCommitted(
      _request: BattleRequest,
      _context: unknown,
      _menus: unknown,
      choices: number[],
      parts: string[],
      _automatic: boolean,
      substitution?: ChoiceSubstitution,
    ): void {
      this.committed = { choices, parts, ...(substitution ? { substitution } : {}) };
    }
  }
  const engine = new FixedEngine('p1');
  assert.equal(await engine.act(megaRequest(), { povLines: [] }), 'move 1, move 1');
  assert.deepEqual(engine.committed?.choices, [0, 0]);
  assert.deepEqual(engine.committed?.substitution?.requested, [1, 1]);
  assert.match(String(engine.committed?.substitution?.reason), /only one Pokémon can Mega Evolve/);
});

test('threat predictions are scored against the next revealed foe action', async () => {
  const provider = new ScriptedProvider([
    decision([0], 'x', 'n', ['Garchomp will click Rock Slide into our left slot']),
    decision([0], 'x', 'n', ['expecting a Tailwind turn']),
    decision([0], 'x', 'n'),
  ]);
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  engine.beginGame({ gameId: 'game-1', gameNumber: 1, seriesId: 'series-1' });
  await engine.act(request(), { povLines: ['|turn|1'] });
  await engine.act(request(), { povLines: ['|move|p2a: Garchomp|Rock Slide|p1a: Mon1', '|turn|2'] });
  await engine.act(request(), { povLines: ['|move|p2a: Garchomp|Earthquake|p1a: Mon1', '|turn|3'] });
  const stats = engine.decisionStats();
  assert.equal(stats.threat_turns, 2);
  assert.equal(stats.threat_hits, 1);
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

test('abandoning a decision aborts its provider request', async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const provider: Provider = {
    complete(_system, _messages, options) {
      started.resolve();
      return new Promise<Completion>((_resolve, reject) => {
        const signal = options?.signal;
        assert.ok(signal);
        const onAbort = () => {
          aborted.resolve();
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  const engine = new LLMEngine('p1', 'scripted', { provider, decisionLog: [] });
  const action = engine.act(request(), { povLines: ['|turn|1'] });
  await started.promise;

  engine.abandonDecision();

  await aborted.promise;
  assert.equal(await action, '');
  assert.deepEqual(engine.decisionStats(), emptyStats);
});
