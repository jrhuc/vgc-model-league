import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ChoiceSubstitution, DecisionLog, GameEnd, GameStart } from './battle-agent.js';
import { BaseEngine } from './battle-agent.js';
import { summarizeBattleEvents } from './battle-transcript.js';
import type { MenuHints, SlotMenu, TargetNames } from './choices.js';
import { buildMenus } from './choices.js';
import { REFLECTION_SYSTEM, renderDecision, SYSTEM } from './prompts.js';
import type { ReasoningLevel } from './providers.js';
import {
  ApiError,
  assistantToolMessage,
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  toolResultMessage,
} from './providers.js';
import type { RecoveryGate } from './recovery.js';
import { DEX_TOOLS, ShowdownReference } from './reference.js';
import { BattleState } from './state.js';
import type {
  AgentContext,
  BattleRequest,
  CompleteOptions,
  Completion,
  JsonObject,
  Pid,
  Provider,
  ProviderMessage,
  ToolCall,
  ToolDefinition,
} from './types.js';
import { isRecord, text } from './value.js';

interface ParsedDecision {
  choices: number[];
  rationale: string;
  notebook: string;
  threats: string[];
  candidates: string[];
}

interface ToolTrace extends JsonObject {
  name: string;
  arguments: JsonObject;
  result: string;
}

/** Thrown when a decision was superseded or yielded to the battle timer; the stale act() must not commit. */
class DecisionAbandonedError extends Error {
  constructor() {
    super('decision abandoned');
    this.name = 'DecisionAbandonedError';
  }
}

interface PendingDecision extends JsonObject {
  prompt?: string;
  rawResponse?: string;
  rationale?: string;
  notebook?: string;
  threats?: string[];
  candidates?: string[];
  reasoning?: string;
  generation: number;
  usage?: Record<string, number>;
  upstreamProviders?: string[];
  fallback?: boolean;
  error?: string;
  latencyMs?: number;
  toolCalls?: ToolTrace[];
  parseFailures?: number;
  toolRounds?: number;
  providerRetries?: number;
  errorSummary?: string;
  maxTokens?: number;
  timer?: { turnSeconds?: number; seconds?: number };
}

export interface LLMEngineOptions {
  provider?: Provider;
  decisionLog?: DecisionLog;
  traceLog?: DecisionLog;
  format?: string;
  psDir?: string;
  reference?: ShowdownReference;
  reasoning?: ReasoningLevel;
  signal?: AbortSignal;
  recovery?: RecoveryGate;
  initialNotebook?: string;
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRY_MIN_REMAINING_MS = 15_000;
const CONSECUTIVE_DECISION_FAILURE_LIMIT = 3;
const FORCE_COMMIT_MS = 25_000;
const FORCE_COMMIT_TURN_FRACTION = 0.5;
const BANK_HEALTHY_SECONDS = 300;
const BANK_LOW_SECONDS = 120;
const DECISION_MIN_TOKENS = 1024;
const DECISION_MAX_TOKENS_DEEP: Partial<Record<ReasoningLevel, number>> = {
  high: 8192,
  xhigh: 16_384,
  max: 16_384,
};
/** Timed budgets follow generation pace so replies arrive before the deadline. The untimed ceiling and wall
 * clock only stop runaway reasoning loops. */
const DECISION_MAX_TOKENS_CEILING = 32_768;
const UNTIMED_CALL_TIMEOUT_S = 600;
const ASSUMED_TOKENS_PER_SECOND = 75;
const PACE_SAFETY = 0.8;
const PACE_SAMPLE_MIN_TOKENS = 256;
const PACE_SAMPLE_MIN_MS = 2000;
/** Timed tool budgets keep lookups from burning the battle clock; untimed budgets exist only to bound
 * runaway loops, so they allow wide mechanical verification. */
const DECISION_MAX_TOOL_ROUNDS = 2;
const DECISION_MAX_STANDARD_TOOL_CALLS = 2;
const DECISION_MAX_ORDER_TOOL_CALLS = 1;
const UNTIMED_MAX_TOOL_ROUNDS = 4;
const UNTIMED_MAX_STANDARD_TOOL_CALLS = 4;
const UNTIMED_MAX_ORDER_TOOL_CALLS = 2;
const DECISION_PARSE_ATTEMPTS = 2;
const UNTIMED_DECISION_PARSE_ATTEMPTS = 4;
const UNTIMED_EMPTY_RESPONSE_RETRIES = 2;
const DECISION_NOTE_LIMIT = 1600;
const DECISION_RATIONALE_LIMIT = 500;
const DECISION_LIST_LIMIT = 3;
const DECISION_LIST_ITEM_LIMIT = 240;
const DECISION_TEMPERATURE = 0.2;
const REFLECTION_MAX_TOKENS = 8192;
const REFLECTION_TIMEOUT_S = 240;
const TRANSCRIPT_CHARACTER_LIMIT = 2400;

const ACTION_ORDER_TOOL: ToolDefinition = {
  name: 'compare_action_order',
  description:
    'Compare two active Pokémon using live Speed state without revealing hidden EVs. Applies visible items, boosts, status, Tailwind, weather abilities, move priority, and Trick Room; also explains Encore timing and redundant locks.',
  parameters: {
    type: 'object',
    properties: {
      first: { type: 'string', description: 'Active species name or ally/foe slot, such as ally 1.' },
      second: { type: 'string', description: 'Active species name or ally/foe slot, such as foe 2.' },
      first_move: { type: 'string', description: 'Optional move being considered for the first Pokémon.' },
      second_move: { type: 'string', description: 'Optional move being considered for the second Pokémon.' },
    },
    required: ['first', 'second'],
    additionalProperties: false,
  },
};

const DECISION_TOOLS = [...DEX_TOOLS, ACTION_ORDER_TOOL];

/** reasoning_tokens is a breakdown of output_tokens, so summing input and output covers the full spend. */
function totalTokens(usage: Record<string, number> | undefined): number {
  return Math.trunc((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0));
}

/** Absent means the provider did not report a reasoning breakdown; zero means it reported none used. */
function reasoningField(usage: Record<string, number> | undefined): Record<string, number> {
  const value = usage?.reasoning_tokens;
  return value === undefined ? {} : { reasoning_tokens: Math.trunc(value) };
}

export function decisionTokenBudget(remainingMs: number, tokensPerSecond: number): number {
  if (!Number.isFinite(remainingMs)) return DECISION_MAX_TOKENS_CEILING;
  const feasible = Math.floor(((remainingMs / 1000) * tokensPerSecond * PACE_SAFETY) / 256) * 256;
  return Math.min(DECISION_MAX_TOKENS_CEILING, Math.max(DECISION_MIN_TOKENS, feasible));
}

export function updatedPace(previous: number | undefined, outputTokens: number, elapsedMs: number): number | undefined {
  if (outputTokens < PACE_SAMPLE_MIN_TOKENS || elapsedMs < PACE_SAMPLE_MIN_MS) return previous;
  const rate = (1000 * outputTokens) / elapsedMs;
  return previous === undefined ? rate : (previous + rate) / 2;
}

function boundedToolCalls(calls: ToolCall[], standardMax: number, orderMax: number): ToolCall[] {
  const order = calls.filter((call) => call.name === ACTION_ORDER_TOOL.name).slice(0, orderMax);
  const standard = calls.filter((call) => call.name !== ACTION_ORDER_TOOL.name).slice(0, standardMax);
  const selectedIds = new Set([...standard, ...order].map((call) => call.id));
  return calls.filter((call) => selectedIds.has(call.id));
}

const GOLDEN_LINES = [
  '|player|p1|p1-golden||',
  '|player|p2|p2-golden||',
  '|teamsize|p1|4',
  '|teamsize|p2|4',
  '|start',
  '|switch|p1a: Politoed|Politoed, L50, F|196/196',
  '|switch|p1b: Swampert|Swampert, L50, M|187/187',
  '|switch|p2a: Aerodactyl|Aerodactyl, L50, M|100/100',
  '|switch|p2b: Charizard|Charizard, L50, M|100/100',
  '|-weather|RainDance|[from] ability: Drizzle|[of] p1a: Politoed',
  '|turn|1',
];

const GOLDEN_REQUEST: BattleRequest = {
  active: [
    {
      moves: [
        { move: 'Weather Ball', id: 'weatherball', target: 'normal' },
        { move: 'Protect', id: 'protect', target: 'self' },
      ],
    },
    {
      moves: [
        { move: 'Wave Crash', id: 'wavecrash', target: 'normal' },
        { move: 'Protect', id: 'protect', target: 'self' },
      ],
      canMegaEvo: true,
    },
  ],
  side: {
    pokemon: [
      {
        ident: 'p1: Politoed',
        details: 'Politoed, L50, F',
        condition: '196/196',
        active: true,
        moves: ['weatherball', 'protect'],
        stats: { atk: 85, def: 132, spa: 110, spd: 129, spe: 91 },
        item: 'leftovers',
        ability: 'drizzle',
      },
      {
        ident: 'p1: Swampert',
        details: 'Swampert, L50, M',
        condition: '187/187',
        active: true,
        moves: ['wavecrash', 'protect'],
        stats: { atk: 178, def: 130, spa: 103, spd: 130, spe: 112 },
        item: 'swampertite',
        ability: 'damp',
      },
      {
        ident: 'p1: Gengar',
        details: 'Gengar, L50, F',
        condition: '165/165',
        active: false,
        moves: ['shadowball', 'protect'],
        stats: { atk: 76, def: 101, spa: 150, spd: 105, spe: 148 },
        item: 'gengarite',
        ability: 'cursedbody',
      },
    ],
  },
  timer: { turnSeconds: 55, seconds: 420 },
};

function goldenDecisionRender(): string {
  const state = new BattleState('p1');
  state.feed(GOLDEN_LINES);
  const reference = new ShowdownReference('gen9championsvgc2026regmbbo3');
  const menus = buildMenus(GOLDEN_REQUEST, {
    names: { foe: { 1: 'Aerodactyl', 2: 'Charizard' }, ally: { 1: 'Politoed', 2: 'Swampert' } },
    protectReduced: { 2: true },
  });
  return renderDecision({
    state: state.render(GOLDEN_REQUEST, (mon) => reference.describeCompact(mon)),
    slotNames: menus.map((_, slot) => state.slotName(slot, GOLDEN_REQUEST)),
    menus,
    transcript: ['Turn 1 begins.'],
    notebook: 'golden',
    seriesContext: 'Series golden; game 1; score p1 0, p2 0',
    matchups: ['- golden matchup line'],
  });
}

export function scaffoldRevision(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        system: SYSTEM,
        reflection: REFLECTION_SYSTEM,
        tools: DECISION_TOOLS,
        decisionPolicy: {
          minTokens: DECISION_MIN_TOKENS,
          maxTokensDeep: DECISION_MAX_TOKENS_DEEP,
          maxTokensCeiling: DECISION_MAX_TOKENS_CEILING,
          assumedTokensPerSecond: ASSUMED_TOKENS_PER_SECOND,
          paceSafety: PACE_SAFETY,
          untimedCallTimeoutSeconds: UNTIMED_CALL_TIMEOUT_S,
          forceCommitTurnFraction: FORCE_COMMIT_TURN_FRACTION,
          bankHealthySeconds: BANK_HEALTHY_SECONDS,
          bankLowSeconds: BANK_LOW_SECONDS,
          maxToolRounds: DECISION_MAX_TOOL_ROUNDS,
          maxStandardToolCalls: DECISION_MAX_STANDARD_TOOL_CALLS,
          maxOrderToolCalls: DECISION_MAX_ORDER_TOOL_CALLS,
          untimedMaxToolRounds: UNTIMED_MAX_TOOL_ROUNDS,
          untimedMaxStandardToolCalls: UNTIMED_MAX_STANDARD_TOOL_CALLS,
          untimedMaxOrderToolCalls: UNTIMED_MAX_ORDER_TOOL_CALLS,
          parseAttempts: DECISION_PARSE_ATTEMPTS,
          noteLimit: DECISION_NOTE_LIMIT,
          rationaleLimit: DECISION_RATIONALE_LIMIT,
          listLimit: DECISION_LIST_LIMIT,
          listItemLimit: DECISION_LIST_ITEM_LIMIT,
          temperature: DECISION_TEMPERATURE,
          forceCommitMs: FORCE_COMMIT_MS,
          retries: RETRY_ATTEMPTS,
          retryBaseMs: RETRY_BASE_MS,
          retryMinRemainingMs: RETRY_MIN_REMAINING_MS,
          consecutiveDecisionFailureLimit: CONSECUTIVE_DECISION_FAILURE_LIMIT,
        },
        reflectionMaxTokens: REFLECTION_MAX_TOKENS,
        goldenDecision: goldenDecisionRender(),
        referenceRender: ShowdownReference.renderRevision(),
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

function isRetryableError(error: unknown): boolean {
  const failure = classifyProviderFailure(error);
  return failure.retryable ?? !failure.terminal;
}

export class LLMEngine extends BaseEngine {
  readonly provider: Provider;
  readonly reference: ShowdownReference;
  private state: BattleState;
  private transcript: string[] = [];
  private notebook: string;
  private gameId: string;
  private seriesId?: string;
  private gameNumber = 1;
  private seriesScore: Record<Pid, number> = { p1: 0, p2: 0 };
  private decisions = 0;
  private fallbacks = 0;
  private reflections = 0;
  private reflectionFallbacks = 0;
  private moveSelections = 0;
  private switchSelections = 0;
  private protectSelections = 0;
  private consecutiveProtectSelections = 0;
  private allyTargetSelections = 0;
  private spreadMoveSelections = 0;
  private megaSelections = 0;
  private toolLookups = 0;
  private repeatedJointActions = 0;
  private teamPreviews = 0;
  private bringChanges = 0;
  private leadChanges = 0;
  private substitutedActions = 0;
  private abandonedDecisions = 0;
  private parseFailureCount = 0;
  private providerRetryCount = 0;
  private costTotal = 0;
  private reasoningTotal = 0;
  private callRetries = 0;
  private observedTokensPerSecond: number | undefined;
  private threatTurns = 0;
  private threatHits = 0;
  private pendingThreats: { gameId: string; threats: string[] } | undefined;
  private loggedNotebook = '';
  private previousPreview: { brought: string; leads: string } | undefined;
  private previousTurnAction: { gameId: string; turn: number; action: string } | undefined;
  private previousProtect = new Map<string, { gameId: string; turn: number }>();
  private pending: PendingDecision | undefined;
  private generation = 0;
  private decisionController: AbortController | undefined;
  private consecutiveDecisionFailures = 0;

  constructor(
    pid: Pid,
    readonly spec: string,
    private readonly options: LLMEngineOptions = {},
  ) {
    super(pid);
    this.provider = options.provider ?? makeProvider(parseSpec(spec), { reasoning: options.reasoning });
    this.reference =
      options.reference ?? new ShowdownReference(options.format ?? 'gen9championsvgc2026regmbbo3', options.psDir);
    this.state = new BattleState(pid);
    this.notebook = options.initialNotebook?.trim().slice(0, DECISION_NOTE_LIMIT) ?? '';
    this.gameId = spec;
  }

  override beginGame(context: GameStart): void {
    this.decisionController?.abort(new Error('game changed'));
    this.decisionController = undefined;
    this.gameId = context.gameId;
    this.gameNumber = context.gameNumber;
    this.seriesId = context.seriesId;
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    this.state = new BattleState(this.pid);
    this.pending = undefined;
    this.pendingThreats = undefined;
    this.transcript = [];
    this.remember(`[Game ${context.gameNumber} begins; series score ${this.scoreText()}]`);
  }

  override coachingNote(): string {
    return this.notebook;
  }

  override async endGame(context: GameEnd): Promise<void> {
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    const winner = text(context.outcome.winner, 'tie') || 'tie';
    const won = context.outcome.won === true;
    const result = winner === 'tie' ? 'tied' : won ? 'won' : 'lost';
    this.remember(`[Game ${context.gameNumber} ended; ${result}; winner ${winner}; series score ${this.scoreText()}]`);
    await this.reflect(context, result);
  }

  override observe(lines: string[]): void {
    if (!lines.length) return;
    this.scoreThreats(lines);
    this.state.feed(lines);
    this.rememberEvents(lines);
  }

  override abandonDecision(): void {
    this.decisionController?.abort(new Error('decision abandoned'));
    this.decisionController = undefined;
    this.generation += 1;
    this.pending = undefined;
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const events = context.povLines;
    const generation = this.generation;
    const controller = new AbortController();
    this.decisionController?.abort(new Error('new decision started'));
    this.decisionController = controller;
    this.scoreThreats(events);
    this.state.feed(events);
    this.rememberEvents(events);
    this.pending = {
      rawResponse: '',
      notebook: this.notebook,
      generation,
      ...(request.timer ? { timer: request.timer } : {}),
    };
    try {
      const choice = await super.act(request, context);
      return generation === this.generation ? choice : '';
    } catch (caught) {
      if (caught instanceof DecisionAbandonedError) return '';
      throw caught;
    } finally {
      if (this.decisionController === controller) this.decisionController = undefined;
    }
  }

  private scoreThreats(lines: string[]): void {
    const pending = this.pendingThreats;
    if (!pending) return;
    if (pending.gameId !== this.gameId) {
      this.pendingThreats = undefined;
      return;
    }
    const foe = this.pid === 'p1' ? 'p2' : 'p1';
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let sawFoeAction = false;
    let hit = false;
    for (const line of lines) {
      if (typeof line !== 'string' || !line.startsWith('|')) continue;
      const [, kind = '', ...args] = line.split('|');
      if (!args[0]?.startsWith(foe)) continue;
      if (kind === 'move' && args[1]) {
        sawFoeAction = true;
        const move = normalize(args[1]);
        if (move && pending.threats.some((threat) => threat.includes(move))) hit = true;
      } else if ((kind === 'switch' || kind === 'drag') && args[1]) {
        sawFoeAction = true;
        const species = normalize(args[1].split(',', 1)[0] ?? '');
        if (species && pending.threats.some((threat) => threat.includes(species) || threat.includes('switch')))
          hit = true;
      }
    }
    if (!sawFoeAction) return;
    this.threatTurns += 1;
    if (hit) this.threatHits += 1;
    this.pendingThreats = undefined;
  }

  protected override async decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> {
    const started = performance.now();
    const turnSeconds = request.timer?.turnSeconds;
    let deadline = turnSeconds === undefined ? undefined : started + 1000 * turnSeconds;
    const forceCommitMs =
      turnSeconds === undefined
        ? FORCE_COMMIT_MS
        : Math.max(FORCE_COMMIT_MS, turnSeconds * 1000 * FORCE_COMMIT_TURN_FRACTION);
    const remainingMs = () => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - performance.now());
    const tokenFloor = (this.options.reasoning && DECISION_MAX_TOKENS_DEEP[this.options.reasoning]) || 0;
    const pace = () => this.observedTokensPerSecond ?? ASSUMED_TOKENS_PER_SECOND;
    let maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
    let truncatedBudget = 0;
    const generation = this.generation;
    const decisionSignal = this.decisionController?.signal;
    const renderedState = this.state.render(request, (mon) => this.reference.describeCompact(mon));
    const speed = request.teamPreview ? '' : this.state.renderEffectiveSpeeds(this.reference);
    const state = speed ? `${renderedState}\n${speed}` : renderedState;
    const sides = this.state.activeMatchupSides();
    const matchups = this.reference.renderActiveMatchups(
      [...sides.allies, ...sides.foes],
      [...sides.foes, ...sides.allies],
      this.state.weather?.name ?? '',
    );
    let prompt = renderDecision({
      state,
      slotNames: menus.map((_, slot) => this.state.slotName(slot, request)),
      menus,
      transcript: this.transcript,
      notebook: this.notebook,
      seriesContext: `Series ${this.seriesId ?? '?'}; game ${this.gameNumber}; score ${this.scoreText()}`,
      matchups,
    });
    if (turnSeconds !== undefined) {
      const bank = request.timer?.seconds ?? turnSeconds;
      const bankAdvice =
        bank <= BANK_LOW_SECONDS
          ? 'The bank is low: commit quickly and rebuild time on easy turns.'
          : bank >= BANK_HEALTHY_SECONDS && maxTokens >= 8192
            ? 'The bank is healthy: think as deeply as this decision warrants before committing.'
            : 'Spend time only where it changes the choice.';
      const paceNote =
        tokenFloor > decisionTokenBudget(remainingMs(), pace())
          ? ''
          : ' — what your generation speed fits into the turn';
      prompt += `\n\nShowdown timer: ${Math.round(turnSeconds)} seconds of wall clock this turn; ${Math.round(bank)} seconds remain in the clock bank. Your whole reply, reasoning included, is capped at ${maxTokens} tokens${paceNote}. A reply cut off at the cap submits nothing, so settle on a choice early and answer well inside it. ${bankAdvice}`;
    }
    if (context.error) prompt += `\n\nThe simulator rejected the previous joint action: ${context.error}`;

    let rawResponse = '';
    const usage: Record<string, number> = {};
    let parsed: ParsedDecision | undefined;
    let error = 'no choices found';
    let parseFailures = 0;
    let toolRounds = 0;
    this.callRetries = 0;
    const toolCalls: ToolTrace[] = [];
    const reasoningParts: string[] = [];
    const upstreamProviders = new Set<string>();
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    const failDecision = (caught: unknown): Promise<number[]> => {
      const message = caught instanceof Error ? caught.message : String(caught);
      const failure = classifyProviderFailure(caught, this.spec);
      this.abandonedDecisions += 1;
      this.consecutiveDecisionFailures += 1;
      const repeated = this.consecutiveDecisionFailures >= CONSECUTIVE_DECISION_FAILURE_LIMIT;
      const stop = failure.terminal || repeated;
      if (this.pending?.generation === generation) this.pending = undefined;
      this.rememberTurnDetail(
        `No choice submitted: ${failure.summary} ${stop ? 'The run cannot continue.' : 'The battle timer acts when time expires.'}`,
      );
      const phase = request.teamPreview ? 'team_preview' : request.forceSwitch ? 'forced_switch' : 'turn';
      const timer = request.timer
        ? { turn_seconds: request.timer.turnSeconds ?? null, bank_seconds: request.timer.seconds ?? null }
        : null;
      const base = {
        game_id: this.gameId,
        series_id: this.seriesId ?? null,
        game_number: this.gameNumber,
        turn: this.state.turn,
        pid: this.pid,
        phase,
      };
      const rationale = stop
        ? `${failure.summary} The run cannot continue.`
        : `${failure.summary} No decision was submitted; the battle timer decides.`;
      this.writeLog(this.options.decisionLog, {
        kind: 'decision',
        ...base,
        selection: [],
        action: 'abandoned',
        rationale,
        threats: [],
        candidates: [],
        automatic: false,
        fallback: true,
        failure_kind: failure.kind,
        error_summary: failure.summary,
        error: message,
        parse_failures: parseFailures,
        latency_ms: Math.round(performance.now() - started),
        total_tokens: totalTokens(usage),
        ...reasoningField(usage),
        timer,
        tool_lookups: toolCalls.map((call) => call.name),
      });
      this.writeLog(this.options.traceLog, {
        kind: 'decision_trace',
        ...base,
        prompt,
        menus: menus.map((menu) => menu.map((item) => item.label)),
        choices: [],
        parts: [],
        raw_response: rawResponse,
        reasoning: reasoningParts.join('\n\n').trim() || null,
        threats: [],
        candidates: [],
        usage,
        ...(upstreamProviders.size ? { upstream_providers: [...upstreamProviders] } : {}),
        latency_ms: performance.now() - started,
        timer,
        parse_failures: parseFailures,
        tool_rounds: toolRounds,
        provider_retries: this.callRetries,
        max_tokens: maxTokens,
        tokens_per_second: this.observedTokensPerSecond ? Math.round(this.observedTokensPerSecond) : null,
        tool_calls: toolCalls,
        fallback: true,
        failure_kind: failure.kind,
        error_summary: failure.summary,
        error: message,
      });
      if (stop) {
        const reason = repeated
          ? `${this.spec} failed to submit ${this.consecutiveDecisionFailures} consecutive decisions. ${failure.summary}`
          : `${failure.summary} The run cannot continue.`;
        throw new Error(reason, { cause: caught });
      }
      return new Promise<number[]>((_resolve, reject) => {
        const abort = () => reject(new DecisionAbandonedError());
        if (decisionSignal?.aborted) abort();
        else decisionSignal?.addEventListener('abort', abort, { once: true });
      });
    };
    const parseAttempts = request.timer ? DECISION_PARSE_ATTEMPTS : UNTIMED_DECISION_PARSE_ATTEMPTS;
    let emptyRetries = 0;
    while (!parsed && parseFailures < parseAttempts) {
      if (generation !== this.generation) throw new DecisionAbandonedError();
      if (parseFailures && (rawResponse || truncatedBudget)) {
        /** Replaying a truncated ramble verbatim spends the retry's input budget on the reasoning that
         * already overran, making the retry likelier to overrun too. Summarise it instead and ask for the
         * answer first. */
        messages.push({
          role: 'assistant',
          content: truncatedBudget ? '[response cut off before a choice was submitted]' : rawResponse,
        });
        messages.push({
          role: 'user',
          content: truncatedBudget
            ? `Your previous response ran past its ${truncatedBudget}-token budget before submitting a choice. Reply with the required JSON immediately, keeping reasoning brief enough to finish inside the budget.`
            : `Your previous response was invalid. Error: ${error}. Reply again following the required JSON format.`,
        });
      }
      rawResponse = '';
      truncatedBudget = 0;
      const maxToolRounds = deadline === undefined ? UNTIMED_MAX_TOOL_ROUNDS : DECISION_MAX_TOOL_ROUNDS;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        if (generation !== this.generation) throw new DecisionAbandonedError();
        if (request.timer && remainingMs() < 2000) return failDecision(new Error('turn time exhausted'));
        const finalRound = round === maxToolRounds || remainingMs() < forceCommitMs;
        maxTokens = Math.max(tokenFloor, decisionTokenBudget(remainingMs(), pace()));
        let completion: Completion;
        try {
          completion = await this.completeRecoverably(
            messages,
            {
              maxTokens,
              temperature: DECISION_TEMPERATURE,
              tools: DECISION_TOOLS,
              toolChoice: finalRound ? 'none' : 'auto',
              ...(deadline === undefined ? { timeout: UNTIMED_CALL_TIMEOUT_S } : {}),
            },
            generation,
            SYSTEM,
            () => deadline,
            decisionSignal,
            () => {
              if (turnSeconds !== undefined) deadline = performance.now() + 1000 * turnSeconds;
            },
          );
        } catch (caught) {
          if (generation !== this.generation) throw new DecisionAbandonedError();
          if (request.timer && !this.options.signal?.aborted) return failDecision(caught);
          throw caught;
        }
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === 'cost' ? value : Math.trunc(value));
        }
        if (completion.provider) upstreamProviders.add(completion.provider);
        if (completion.reasoning) reasoningParts.push(completion.reasoning);
        if (completion.toolCalls.length && !finalRound) {
          toolRounds += 1;
          const calls = boundedToolCalls(
            completion.toolCalls,
            deadline === undefined ? UNTIMED_MAX_STANDARD_TOOL_CALLS : DECISION_MAX_STANDARD_TOOL_CALLS,
            deadline === undefined ? UNTIMED_MAX_ORDER_TOOL_CALLS : DECISION_MAX_ORDER_TOOL_CALLS,
          );
          messages.push(
            assistantToolMessage(
              calls.length === completion.toolCalls.length
                ? completion
                : { ...completion, toolCalls: calls, responseMessages: [] },
            ),
          );
          for (const call of calls) {
            const result =
              call.name === ACTION_ORDER_TOOL.name
                ? this.state.compareActionOrder(call.arguments, this.reference)
                : this.reference.lookup(call.name, call.arguments);
            toolCalls.push({ name: call.name, arguments: call.arguments, result });
            messages.push(toolResultMessage(call.id, result));
          }
          if (deadline !== undefined) {
            const seconds = Math.max(0, Math.round(remainingMs() / 1000));
            const last = messages[messages.length - 1];
            if (last) last.content = `${last.content}\n[Timer: ${seconds}s left this turn]`;
          }
          continue;
        }
        /** A model cut off mid-reasoning still returns text, so finishReason alone misses it and the run
         * blames the model's formatting for a budget it never got to spend. Token count is the signal
         * providers agree on. */
        if (completion.finishReason === 'length' || (completion.usage.output_tokens ?? 0) >= maxTokens) {
          truncatedBudget = maxTokens;
        }
        if (!completion.text && !completion.toolCalls.length && truncatedBudget) break;
        rawResponse = completion.text;
        /** Some reasoning models via gateways finish with every token in the reasoning channel and an
         * empty text field; the decision they wrote is salvaged rather than bought again on a retry. */
        if (!rawResponse && !completion.toolCalls.length && completion.reasoning) {
          try {
            LLMEngine.extractChoices(completion.reasoning, menus);
            rawResponse = completion.reasoning;
          } catch {}
        }
        break;
      }
      if (!rawResponse) {
        error = truncatedBudget ? `reasoning exhausted the ${truncatedBudget}-token response budget` : 'empty response';
        if (request.timer) return failDecision(new Error(error));
        if (truncatedBudget) {
          parseFailures += 1;
          continue;
        }
        if (emptyRetries < UNTIMED_EMPTY_RESPONSE_RETRIES) {
          emptyRetries += 1;
          continue;
        }
        break;
      }
      try {
        parsed = LLMEngine.extractChoices(rawResponse, menus);
        BaseEngine.parts(menus, parsed.choices);
      } catch (caught) {
        parsed = undefined;
        error = truncatedBudget
          ? `reasoning exhausted the ${truncatedBudget}-token response budget before a choice was submitted`
          : caught instanceof Error
            ? caught.message
            : String(caught);
        if (!truncatedBudget && /[|｜]\s*DSML\s*[|｜]/.test(rawResponse)) {
          error =
            'the response wrote tool-call markup as plain text, which nothing executes. Call tools through the API tool interface or reply with the required JSON object';
        }
        parseFailures += 1;
      }
    }
    const fallback = !parsed;
    const decision =
      parsed ??
      ({
        choices: BaseEngine.defaults(menus)[0],
        rationale: `No valid decision (${error}); defaulted to the first legal option for each slot.`,
        notebook: this.notebook,
        threats: [],
        candidates: [],
      } satisfies ParsedDecision);
    if (generation === this.generation && this.pending)
      Object.assign(this.pending, {
        prompt,
        rawResponse,
        rationale: decision.rationale,
        notebook: decision.notebook,
        threats: decision.threats,
        candidates: decision.candidates,
        reasoning: reasoningParts.join('\n\n').trim() || undefined,
        usage,
        ...(upstreamProviders.size ? { upstreamProviders: [...upstreamProviders] } : {}),
        fallback,
        error: fallback ? error : undefined,
        errorSummary:
          fallback && truncatedBudget ? classifyProviderFailure(new Error(error), this.spec).summary : undefined,
        latencyMs: performance.now() - started,
        toolCalls,
        parseFailures,
        toolRounds,
        providerRetries: this.callRetries,
        maxTokens,
        generation,
      });
    return decision.choices;
  }

  private async completeRecoverably(
    messages: ProviderMessage[],
    options: CompleteOptions,
    generation: number,
    system = SYSTEM,
    deadline?: () => number | undefined,
    operationSignal?: AbortSignal,
    onResume?: () => void,
  ): Promise<Completion> {
    const runSignal = this.options.signal;
    const signal =
      runSignal && operationSignal ? AbortSignal.any([runSignal, operationSignal]) : (runSignal ?? operationSignal);
    while (true) {
      await this.options.recovery?.wait(signal);
      try {
        return await this.completeWithRetry(messages, options, generation, system, deadline?.(), operationSignal);
      } catch (error) {
        const failure = classifyProviderFailure(error, this.spec);
        if (!this.options.recovery || !failure.pausable || signal?.aborted) throw error;
        await this.options.recovery.pause(this.spec, failure.kind, failure.summary, signal);
        onResume?.();
      }
    }
  }

  private async completeWithRetry(
    messages: ProviderMessage[],
    options: CompleteOptions,
    generation: number,
    system = SYSTEM,
    deadline?: number,
    operationSignal?: AbortSignal,
  ): Promise<Completion> {
    const runSignal = this.options.signal;
    const signal =
      runSignal && operationSignal ? AbortSignal.any([runSignal, operationSignal]) : (runSignal ?? operationSignal);
    const withSignal: CompleteOptions = signal ? { ...options, signal } : options;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const attemptOptions =
          deadline === undefined
            ? withSignal
            : { ...withSignal, timeout: Math.max(1, (deadline - performance.now()) / 1000 + 1) };
        const startedAt = performance.now();
        const completion = await this.provider.complete(system, messages, attemptOptions);
        if (
          !completion.text &&
          !completion.toolCalls.length &&
          !completion.reasoning?.trim() &&
          completion.finishReason !== 'length'
        )
          throw new ApiError(0, 'empty response');
        this.observedTokensPerSecond = updatedPace(
          this.observedTokensPerSecond,
          completion.usage.output_tokens ?? 0,
          performance.now() - startedAt,
        );
        return completion;
      } catch (error) {
        if (
          attempt >= RETRY_ATTEMPTS - 1 ||
          generation !== this.generation ||
          signal?.aborted ||
          !isRetryableError(error) ||
          (deadline !== undefined && deadline - performance.now() < RETRY_MIN_REMAINING_MS)
        )
          throw error;
        this.callRetries += 1;
        if (signal) await delay(RETRY_BASE_MS * 2 ** attempt, undefined, { signal });
        else await delay(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }

  protected override actionCommitted(
    request: BattleRequest,
    _context: AgentContext,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    automatic: boolean,
    substitution?: ChoiceSubstitution,
  ): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.generation !== this.generation) return;
    const notebook = pending.notebook ?? this.notebook;
    const rationale = automatic
      ? 'Automatic: only one legal joint action.'
      : pending.rationale || 'No rationale supplied.';
    if (!automatic) {
      if (!pending.fallback) this.consecutiveDecisionFailures = 0;
      this.notebook = notebook;
      this.decisions += 1;
      if (pending.fallback) this.fallbacks += 1;
      this.parseFailureCount += pending.parseFailures ?? 0;
      this.providerRetryCount += pending.providerRetries ?? 0;
      this.costTotal += pending.usage?.cost ?? 0;
      this.reasoningTotal += Math.trunc(pending.usage?.reasoning_tokens ?? 0);
      if (substitution) this.substitutedActions += 1;
    }
    const action = request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
    this.rememberTurnDetail(`Decision: ${action}`);
    const phase = request.teamPreview ? 'team_preview' : request.forceSwitch ? 'forced_switch' : 'turn';
    const selection = choices.map((choice, slot) => menus[slot]?.[choice]?.label ?? parts[slot] ?? 'pass');
    if (!automatic) this.recordTendencies(phase, menus, choices, parts, action, pending.toolCalls ?? []);
    if (!automatic && phase === 'turn' && pending.threats?.length) {
      this.pendingThreats = {
        gameId: this.gameId,
        threats: pending.threats.map((threat) => threat.toLowerCase().replace(/[^a-z0-9]+/g, '')),
      };
    }
    const timer = pending.timer
      ? { turn_seconds: pending.timer.turnSeconds ?? null, bank_seconds: pending.timer.seconds ?? null }
      : null;
    const substituted = substitution
      ? { requested_choices: substitution.requested, substitution_reason: substitution.reason }
      : {};
    this.writeLog(this.options.decisionLog, {
      kind: 'decision',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      selection,
      action,
      rationale,
      threats: pending.threats ?? [],
      candidates: pending.candidates ?? [],
      ...this.notebookUpdate(),
      automatic,
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
      ...(pending.errorSummary ? { error_summary: pending.errorSummary } : {}),
      ...substituted,
      parse_failures: pending.parseFailures ?? 0,
      latency_ms: Math.round(pending.latencyMs ?? 0),
      total_tokens: totalTokens(pending.usage),
      ...reasoningField(pending.usage),
      ...(pending.usage?.cost !== undefined ? { cost: pending.usage.cost } : {}),
      timer,
      tool_lookups: (pending.toolCalls ?? []).map((call) => call.name),
    });
    if (automatic) return;
    this.writeLog(this.options.traceLog, {
      kind: 'decision_trace',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      phase,
      prompt: pending.prompt ?? '',
      menus: menus.map((menu) => menu.map((item) => item.label)),
      choices,
      parts,
      ...substituted,
      raw_response: pending.rawResponse ?? '',
      reasoning: pending.reasoning ?? null,
      threats: pending.threats ?? [],
      candidates: pending.candidates ?? [],
      usage: pending.usage ?? {},
      ...(pending.upstreamProviders?.length ? { upstream_providers: pending.upstreamProviders } : {}),
      latency_ms: pending.latencyMs ?? 0,
      timer,
      parse_failures: pending.parseFailures ?? 0,
      tool_rounds: pending.toolRounds ?? 0,
      provider_retries: pending.providerRetries ?? 0,
      max_tokens: pending.maxTokens ?? null,
      tokens_per_second: this.observedTokensPerSecond ? Math.round(this.observedTokensPerSecond) : null,
      tool_calls: pending.toolCalls ?? [],
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
      ...(pending.errorSummary ? { error_summary: pending.errorSummary } : {}),
    });
  }

  override decisionStats(): Record<string, number> {
    return {
      decisions: this.decisions,
      fallbacks: this.fallbacks,
      reflections: this.reflections,
      reflection_fallbacks: this.reflectionFallbacks,
      move_selections: this.moveSelections,
      switch_selections: this.switchSelections,
      protect_selections: this.protectSelections,
      consecutive_protect_selections: this.consecutiveProtectSelections,
      ally_target_selections: this.allyTargetSelections,
      spread_move_selections: this.spreadMoveSelections,
      mega_selections: this.megaSelections,
      tool_lookups: this.toolLookups,
      repeated_joint_actions: this.repeatedJointActions,
      team_previews: this.teamPreviews,
      bring_changes: this.bringChanges,
      lead_changes: this.leadChanges,
      substituted_actions: this.substitutedActions,
      abandoned_decisions: this.abandonedDecisions,
      parse_failures: this.parseFailureCount,
      provider_retries: this.providerRetryCount,
      threat_turns: this.threatTurns,
      threat_hits: this.threatHits,
      ...(this.reasoningTotal > 0 ? { reasoning_tokens: this.reasoningTotal } : {}),
      ...(this.costTotal > 0 ? { cost: Math.round(this.costTotal * 1e6) / 1e6 } : {}),
    };
  }

  private recordTendencies(
    phase: string,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    action: string,
    toolCalls: ToolTrace[],
  ): void {
    this.toolLookups += toolCalls.length;
    if (phase === 'team_preview') {
      this.teamPreviews += 1;
      const brought = [...parts].sort().join(',');
      const leads = parts.slice(0, 2).sort().join(',');
      if (this.previousPreview) {
        if (this.previousPreview.brought !== brought) this.bringChanges += 1;
        if (this.previousPreview.leads !== leads) this.leadChanges += 1;
      }
      this.previousPreview = { brought, leads };
    }
    for (const [slot, part] of parts.entries()) {
      const item = menus[slot]?.[choices[slot]!];
      if (item?.kind === 'move') this.moveSelections += 1;
      if (item?.kind === 'switch') this.switchSelections += 1;
      if (/ -[12](?:\s|$)/.test(part)) this.allyTargetSelections += 1;
      if (item?.kind === 'move' && /\((?:both foes|your side|all adjacent|spread)/.test(item.label))
        this.spreadMoveSelections += 1;
      if (part.endsWith(' mega')) this.megaSelections += 1;

      if (phase !== 'turn') continue;
      const activeKey = this.state.sides[this.pid].active[String.fromCharCode('a'.charCodeAt(0) + slot)];
      if (!activeKey) continue;
      const protect = item?.kind === 'move' && /^Protect(?:\b|\s)/i.test(item.label);
      const previous = this.previousProtect.get(activeKey);
      if (protect) {
        this.protectSelections += 1;
        if (previous?.gameId === this.gameId && previous.turn === this.state.turn - 1)
          this.consecutiveProtectSelections += 1;
        this.previousProtect.set(activeKey, { gameId: this.gameId, turn: this.state.turn });
      } else this.previousProtect.delete(activeKey);
    }
    if (phase === 'turn') {
      if (
        this.previousTurnAction?.gameId === this.gameId &&
        this.previousTurnAction.turn === this.state.turn - 1 &&
        this.previousTurnAction.action === action
      )
        this.repeatedJointActions += 1;
      this.previousTurnAction = { gameId: this.gameId, turn: this.state.turn, action };
    } else this.previousTurnAction = undefined;
  }

  private notebookUpdate(): JsonObject {
    if (this.notebook === this.loggedNotebook) return {};
    this.loggedNotebook = this.notebook;
    return { notebook: this.notebook };
  }

  protected override menuHints(request: BattleRequest): MenuHints | undefined {
    if (request.teamPreview || !request.active) return undefined;
    const names: TargetNames = { foe: {}, ally: {} };
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    for (const [group, pid] of [
      ['ally', this.pid],
      ['foe', foe],
    ] as const) {
      const side = this.state.sides[pid];
      for (const [number, slot] of [
        [1, 'a'],
        [2, 'b'],
      ] as const) {
        const key = side.active[slot];
        const mon = key ? side.mons.get(key) : undefined;
        if (mon && !mon.fainted) names[group][number] = mon.species;
      }
    }
    if (!Object.keys(names.ally).length) {
      for (const [index, mon] of (request.side?.pokemon ?? []).filter((pokemon) => pokemon.active).entries()) {
        names.ally[index + 1] = BattleState.requestName(mon);
      }
    }
    return {
      names,
      protectReduced: this.state.protectReducedSlots(),
      moveAnnotation: (_slot, move, targetSide, targetNumber) =>
        this.state.moveAnnotation(move, targetSide, targetNumber),
    };
  }

  static extractChoices(response: string, menus: SlotMenu[]): ParsedDecision {
    const objects = jsonObjects(response, true).filter((value) => 'choices' in value || 'choice' in value);
    if (!objects.length) throw new Error('no JSON object with a choices key');
    let failure: unknown;
    for (const object of objects.reverse()) {
      try {
        return LLMEngine.parseDecision(object, menus);
      } catch (caught) {
        failure ??= caught;
      }
    }
    throw failure;
  }

  private static parseDecision(object: JsonObject, menus: SlotMenu[]): ParsedDecision {
    const rawChoices = object.choices ?? (menus.length === 1 ? [object.choice] : undefined);
    if (!Array.isArray(rawChoices) || rawChoices.length !== menus.length)
      throw new Error(`choices must be an array of exactly ${menus.length} integers`);
    const choices = rawChoices.map((choice, slot) => {
      if (!Number.isInteger(choice)) throw new Error(`choice for slot ${slot + 1} must be an integer`);
      const index = choice as number;
      if (index < 0 || index >= menus[slot]!.length)
        throw new Error(`choice for slot ${slot + 1} must be between 0 and ${menus[slot]!.length - 1}`);
      return index;
    });
    const rationale = typeof object.rationale === 'string' ? object.rationale : undefined;
    const notebook = typeof object.notebook === 'string' ? object.notebook : undefined;
    if (rationale === undefined || notebook === undefined)
      throw new Error('response must contain string rationale and notebook fields');
    const asAuxiliaryList = (value: unknown, objectRationale = false): string[] => {
      if (!Array.isArray(value)) return [];
      const entries: string[] = [];
      for (const entry of value) {
        const normalized =
          typeof entry === 'string'
            ? entry
            : objectRationale && isRecord(entry) && typeof entry.rationale === 'string'
              ? entry.rationale
              : undefined;
        if (normalized !== undefined) entries.push(normalized.slice(0, DECISION_LIST_ITEM_LIMIT));
        if (entries.length === DECISION_LIST_LIMIT) break;
      }
      return entries;
    };
    return {
      choices,
      rationale: rationale.slice(0, DECISION_RATIONALE_LIMIT),
      notebook: notebook.slice(0, DECISION_NOTE_LIMIT),
      threats: asAuxiliaryList(object.threats),
      candidates: asAuxiliaryList(object.candidates, true),
    };
  }

  private async reflect(context: GameEnd, result: string): Promise<void> {
    const seriesOver = context.gameNumber >= 3 || Math.max(this.seriesScore.p1, this.seriesScore.p2) >= 2;
    const prompt = [
      `Series ${this.seriesId ?? '?'}; game ${context.gameNumber}; result: ${result}; series score ${this.scoreText()}.`,
      `Turns: ${String(context.outcome.turns ?? '?')}. Decision errors: ${String(context.outcome.errors ?? 0)}. Model-choice defaults: ${String(context.outcome.model_choice_fallbacks ?? 0)}. Simulator substitutions: ${String(context.outcome.simulator_substitutions ?? 0)}. Timer autodefaults: ${String(context.outcome.timer_autodefaults ?? 0)}.`,
      '',
      'Final authoritative state:',
      this.state.render({}),
      '',
      'Compact private battle timeline:',
      ...this.transcript,
      '',
      `Current private notebook: ${this.notebook || '(empty)'}`,
      '',
      'Return the required concise game review and updated notebook.',
    ].join('\n');
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    const usage: Record<string, number> = {};
    let rawResponse = '';
    let parsed: { summary: string; adjustment: string; notebook: string } | undefined;
    let error: string | undefined;
    let failureSummary: string | undefined;
    let failureKind: string | undefined;
    let terminalError: Error | undefined;
    try {
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        const completion = await this.completeRecoverably(
          messages,
          { maxTokens: REFLECTION_MAX_TOKENS, temperature: DECISION_TEMPERATURE, timeout: REFLECTION_TIMEOUT_S },
          this.generation,
          REFLECTION_SYSTEM,
        );
        for (const [key, value] of Object.entries(completion.usage)) {
          usage[key] = (usage[key] ?? 0) + (key === 'cost' ? value : Math.trunc(value));
        }
        rawResponse = completion.text;
        if (!rawResponse.trim() && completion.reasoning) {
          try {
            LLMEngine.extractReflection(completion.reasoning);
            rawResponse = completion.reasoning;
          } catch {}
        }
        try {
          parsed = LLMEngine.extractReflection(rawResponse);
          error = undefined;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: rawResponse || '[the reply contained no visible text]' });
            messages.push({
              role: 'user',
              content: `Invalid review: ${error}. Reply with exactly the required JSON object.`,
            });
          }
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      const failure = classifyProviderFailure(caught, this.spec);
      failureSummary = failure.summary;
      failureKind = failure.kind;
      if (failure.terminal && caught instanceof ApiError) {
        terminalError = new Error(`${failure.summary} The run cannot continue.`, { cause: caught });
      }
    }
    const fallback = !parsed;
    const review =
      parsed ??
      ({
        summary: `Game ${result}; model reflection unavailable (${failureSummary ?? error ?? 'unparseable review'}).`,
        adjustment: 'Retain the existing series plan and reassess from the next team preview.',
        notebook: this.notebook,
      } satisfies { summary: string; adjustment: string; notebook: string });
    this.reflections += 1;
    if (fallback) this.reflectionFallbacks += 1;
    this.costTotal += usage.cost ?? 0;
    this.reasoningTotal += Math.trunc(usage.reasoning_tokens ?? 0);
    this.notebook = review.notebook;
    this.remember(`Game review: ${review.summary} Next-game adjustment: ${review.adjustment}`);
    this.writeLog(this.options.decisionLog, {
      kind: 'game_reflection',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      result,
      series_over: seriesOver,
      summary: review.summary,
      adjustment: review.adjustment,
      ...this.notebookUpdate(),
      total_tokens: totalTokens(usage),
      ...reasoningField(usage),
      fallback,
      error: error ?? null,
      ...(failureSummary ? { error_summary: failureSummary, failure_kind: failureKind } : {}),
    });
    this.writeLog(this.options.traceLog, {
      kind: 'reflection_trace',
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: context.gameNumber,
      pid: this.pid,
      series_over: seriesOver,
      prompt,
      raw_response: rawResponse,
      usage,
      fallback,
      error: error ?? null,
      ...(failureSummary ? { error_summary: failureSummary, failure_kind: failureKind } : {}),
    });
    if (terminalError) throw terminalError;
  }

  private static extractReflection(response: string): { summary: string; adjustment: string; notebook: string } {
    const object = jsonObjects(response)
      .filter((value) => 'summary' in value || 'adjustment' in value)
      .at(-1);
    if (!object) throw new Error('no JSON game review found');
    if (
      typeof object.summary !== 'string' ||
      typeof object.adjustment !== 'string' ||
      typeof object.notebook !== 'string'
    )
      throw new Error('review must contain string summary, adjustment, and notebook fields');
    return {
      summary: object.summary.slice(0, DECISION_RATIONALE_LIMIT),
      adjustment: object.adjustment.slice(0, DECISION_RATIONALE_LIMIT),
      notebook: object.notebook.slice(0, DECISION_NOTE_LIMIT),
    };
  }

  private remember(value: string): void {
    const lines = value.split('\n').filter(Boolean);
    if (!lines.length) return;
    this.transcript.push(...lines);
    this.trimTranscript();
  }

  private rememberTurnDetail(value: string): void {
    const detail = value.trim().replace(/\.$/, '');
    if (!detail) return;
    let index = this.transcript.findLastIndex((line) => /^Turn \d+:/.test(line));
    if (index < 0) index = this.transcript.findLastIndex((line) => line.startsWith('Setup:'));
    if (index < 0) {
      this.remember(`Setup: ${detail}.`);
      return;
    }
    const current = this.transcript[index]!;
    const base = current.endsWith('.') ? current.slice(0, -1) : current;
    this.transcript[index] = `${base}${base.endsWith(':') ? ' ' : '; '}${detail}.`;
    this.trimTranscript();
  }

  private trimTranscript(): void {
    let length = this.transcript.reduce((total, line) => total + line.length, this.transcript.length - 1);
    while (length > TRANSCRIPT_CHARACTER_LIMIT && this.transcript.length > 1) {
      length -= this.transcript.shift()!.length + 1;
    }
    if (length <= TRANSCRIPT_CHARACTER_LIMIT) return;
    const line = this.transcript[0]!;
    const prefix = /^(?:Turn \d+|Setup):/.exec(line)?.[0] ?? '';
    const retained = Math.max(0, TRANSCRIPT_CHARACTER_LIMIT - prefix.length - 2);
    this.transcript[0] = `${prefix} …${line.slice(-retained)}`;
  }

  private rememberEvents(lines: string[]): void {
    for (const event of summarizeBattleEvents(lines)) {
      const turn = /^Turn (\d+) begins\.$/.exec(event);
      if (turn) this.remember(`Turn ${turn[1]}:`);
      else this.rememberTurnDetail(event);
    }
  }

  private scoreText(): string {
    return `p1 ${this.seriesScore.p1}, p2 ${this.seriesScore.p2}`;
  }

  private writeLog(output: DecisionLog | undefined, row: JsonObject): void {
    if (!output) return;
    if (typeof output === 'function') output(row);
    else if (Array.isArray(output)) output.push(row);
    else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.appendFileSync(output, `${JSON.stringify(row)}\n`, 'utf8');
    }
  }
}

function jsonObjects(input: string, preferOuterDecision = false): JsonObject[] {
  const matches: Array<{ value: JsonObject; start: number; end: number }> = [];
  for (let start = input.indexOf('{'); start >= 0; start = input.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        try {
          const value: unknown = JSON.parse(input.slice(start, index + 1));
          if (isRecord(value)) matches.push({ value, start, end: index });
        } catch {}
        break;
      }
    }
  }
  if (!preferOuterDecision) return matches.map(({ value }) => value);
  return matches
    .filter(
      (match) =>
        !matches.some(
          (parent) =>
            parent.start < match.start &&
            parent.end >= match.end &&
            ('choices' in parent.value || 'choice' in parent.value) &&
            typeof parent.value.rationale === 'string' &&
            typeof parent.value.notebook === 'string',
        ),
    )
    .map(({ value }) => value);
}
