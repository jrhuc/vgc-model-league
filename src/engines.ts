import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { MenuHints, SlotMenu, TargetNames } from './choices.js';
import { buildMenus } from './choices.js';
import { REFLECTION_SYSTEM, renderDecision, SYSTEM } from './prompts.js';
import type { ReasoningLevel } from './providers.js';
import { ApiError, assistantToolMessage, makeProvider, parseSpec, toolResultMessage } from './providers.js';
import type { Rng } from './random.js';
import { seededRng } from './random.js';
import { DEX_TOOLS, ShowdownReference } from './reference.js';
import { BattleState } from './state.js';
import type {
  AgentContext,
  BattleAgent,
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

export interface GameStart {
  gameId: string;
  gameNumber: number;
  seriesId: string;
  seriesScore?: Record<Pid, number>;
}

export interface GameEnd {
  outcome: JsonObject;
  gameNumber: number;
  seriesScore?: Record<Pid, number>;
}

export type DecisionLog = string | JsonObject[] | ((row: JsonObject) => void);

export interface ChoiceSubstitution {
  requested: number[];
  reason: string;
}

export abstract class BaseEngine implements BattleAgent {
  constructor(readonly pid: Pid) {}

  beginGame(_context: GameStart): void {}
  endGame(_context: GameEnd): Promise<void> | void {}
  observe(_lines: string[]): void {}
  abandonDecision(): void {}
  decisionStats(): Record<string, number> {
    return {};
  }

  async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const menus = buildMenus(request, this.menuHints(request));
    if (!menus.length) return '';
    let automatic = menus.every((menu) => menu.length === 1);
    let choices = automatic ? menus.map(() => 0) : await this.decideJoint(menus, request, context);
    let parts: string[];
    let substitution: ChoiceSubstitution | undefined;
    try {
      parts = BaseEngine.parts(menus, choices);
    } catch (caught) {
      substitution = { requested: choices, reason: caught instanceof Error ? caught.message : String(caught) };
      [choices, parts] = BaseEngine.defaults(menus);
      automatic = false;
    }
    this.actionCommitted(request, context, menus, choices, parts, automatic, substitution);
    return request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
  }

  protected abstract decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> | number[];
  protected actionCommitted(
    _request: BattleRequest,
    _context: AgentContext,
    _menus: SlotMenu[],
    _choices: number[],
    _parts: string[],
    _automatic: boolean,
    _substitution?: ChoiceSubstitution,
  ): void {}
  protected menuHints(_request: BattleRequest): MenuHints | undefined {
    return undefined;
  }

  static parts(menus: SlotMenu[], choices: number[]): string[] {
    if (choices.length !== menus.length) throw new Error(`choices must contain exactly ${menus.length} indices`);
    const parts: string[] = [];
    choices.forEach((choice, slot) => {
      const menu = menus[slot]!;
      if (!Number.isInteger(choice) || choice < 0 || choice >= menu.length)
        throw new Error(`choice for slot ${slot + 1} is outside its menu`);
      const item = menu[choice]!;
      if (!BaseEngine.remaining(menu, parts).includes(item)) {
        if (item.part.endsWith(' mega') && parts.some((part) => part.endsWith(' mega')))
          throw new Error(`slot ${slot + 1} also chose Mega Evolve; only one Pokémon can Mega Evolve per battle`);
        if (item.kind === 'switch')
          throw new Error(`slot ${slot + 1} switches to a Pokémon an earlier slot already switches to`);
        throw new Error(`choice for slot ${slot + 1} conflicts with an earlier slot`);
      }
      parts.push(item.part);
    });
    const forced = menus.flatMap((menu, index) => (menu.some((item) => item.kind === 'switch') ? [index] : []));
    if (forced.some((index) => parts[index] === 'pass')) {
      const replacements = new Set(
        forced.flatMap((index) => menus[index]!.filter((item) => item.kind === 'switch').map((item) => item.part)),
      );
      const allowed = Math.max(0, forced.length - replacements.size);
      if (forced.filter((index) => parts[index] === 'pass').length > allowed)
        throw new Error('cannot pass a forced switch while a replacement remains');
    }
    return parts;
  }

  static defaults(menus: SlotMenu[]): [number[], string[]] {
    const choices: number[] = [];
    const parts: string[] = [];
    for (const menu of menus) {
      const item = BaseEngine.remaining(menu, parts)[0];
      if (!item) {
        choices.push(-1);
        parts.push('pass');
      } else {
        choices.push(menu.indexOf(item));
        parts.push(item.part);
      }
    }
    return [choices, parts];
  }

  static remaining(menu: SlotMenu, chosen: string[]): SlotMenu {
    const switches = new Set(chosen.filter((part) => part.startsWith('switch ')));
    const selected = new Set(chosen);
    const mega = chosen.some((part) => part.endsWith(' mega'));
    return menu.filter(
      (item) =>
        !(item.kind === 'switch' && switches.has(item.part)) &&
        !(item.kind === 'team' && selected.has(item.part)) &&
        !(mega && item.part.endsWith(' mega')),
    );
  }
}

export class RandomEngine extends BaseEngine {
  private readonly random: Rng;

  constructor(pid: Pid, seed: string | number = Math.random()) {
    super(pid);
    this.random = seededRng(seed);
  }

  protected decideJoint(menus: SlotMenu[]): number[] {
    const choices: number[] = [];
    const parts: string[] = [];
    for (const menu of menus) {
      const candidates = BaseEngine.remaining(menu, parts);
      if (!candidates.length) {
        choices.push(-1);
        parts.push('pass');
        continue;
      }
      const weights = candidates.map((item) => (item.part.endsWith(' mega') ? 0.25 : 1));
      const target = this.random() * weights.reduce((sum, value) => sum + value, 0);
      let total = 0;
      let index = 0;
      while (index < weights.length - 1 && total + weights[index]! <= target) {
        total += weights[index]!;
        index += 1;
      }
      const item = candidates[index]!;
      choices.push(menu.indexOf(item));
      parts.push(item.part);
    }
    return choices;
  }
}

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
  fallback?: boolean;
  error?: string;
  latencyMs?: number;
  toolCalls?: ToolTrace[];
  parseFailures?: number;
  toolRounds?: number;
  providerRetries?: number;
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
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRY_MIN_REMAINING_MS = 15_000;
const FORCE_COMMIT_MS = 25_000;
const FORCE_COMMIT_TURN_FRACTION = 0.5;
const BANK_HEALTHY_SECONDS = 300;
const BANK_LOW_SECONDS = 120;
const DECISION_MAX_TOKENS = 4096;
const DECISION_MAX_TOKENS_DEEP: Partial<Record<ReasoningLevel, number>> = {
  high: 8192,
  xhigh: 16_384,
  max: 16_384,
};
const DECISION_MAX_TOOL_ROUNDS = 2;
const DECISION_MAX_STANDARD_TOOL_CALLS = 2;
const DECISION_MAX_ORDER_TOOL_CALLS = 1;
const DECISION_PARSE_ATTEMPTS = 2;
const DECISION_NOTE_LIMIT = 1600;
const DECISION_RATIONALE_LIMIT = 500;
const DECISION_LIST_LIMIT = 3;
const DECISION_LIST_ITEM_LIMIT = 240;
const DECISION_TEMPERATURE = 0.2;
const REFLECTION_MAX_TOKENS = 2048;
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

function boundedToolCalls(calls: ToolCall[]): ToolCall[] {
  const order = calls.find((call) => call.name === ACTION_ORDER_TOOL.name);
  const standard = calls
    .filter((call) => call.name !== ACTION_ORDER_TOOL.name)
    .slice(0, DECISION_MAX_STANDARD_TOOL_CALLS);
  const selected = order
    ? [...standard, order].slice(0, DECISION_MAX_STANDARD_TOOL_CALLS + DECISION_MAX_ORDER_TOOL_CALLS)
    : standard;
  const selectedIds = new Set(selected.map((call) => call.id));
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
          maxTokens: DECISION_MAX_TOKENS,
          maxTokensDeep: DECISION_MAX_TOKENS_DEEP,
          forceCommitTurnFraction: FORCE_COMMIT_TURN_FRACTION,
          bankHealthySeconds: BANK_HEALTHY_SECONDS,
          bankLowSeconds: BANK_LOW_SECONDS,
          maxToolRounds: DECISION_MAX_TOOL_ROUNDS,
          maxStandardToolCalls: DECISION_MAX_STANDARD_TOOL_CALLS,
          maxOrderToolCalls: DECISION_MAX_ORDER_TOOL_CALLS,
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
        },
        reflectionMaxTokens: REFLECTION_MAX_TOKENS,
        goldenDecision: goldenDecisionRender(),
        referenceRender: ShowdownReference.renderRevision(),
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

function isTransientError(error: unknown): boolean {
  if (error instanceof ApiError)
    return (
      error.status === 0 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  return error instanceof TypeError;
}

export class LLMEngine extends BaseEngine {
  readonly provider: Provider;
  readonly reference: ShowdownReference;
  private state: BattleState;
  private transcript: string[] = [];
  private notebook = '';
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
  private callRetries = 0;
  private threatTurns = 0;
  private threatHits = 0;
  private pendingThreats: { gameId: string; threats: string[] } | undefined;
  private loggedNotebook = '';
  private previousPreview: { brought: string; leads: string } | undefined;
  private previousTurnAction: { gameId: string; turn: number; action: string } | undefined;
  private previousProtect = new Map<string, { gameId: string; turn: number }>();
  private pending: PendingDecision | undefined;
  private generation = 0;
  private abandonWaiters = new Set<() => void>();
  private decisionController: AbortController | undefined;

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
    for (const abort of this.abandonWaiters) abort();
    this.abandonWaiters.clear();
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
    const deadline = turnSeconds === undefined ? undefined : started + 1000 * turnSeconds;
    const forceCommitMs =
      turnSeconds === undefined
        ? FORCE_COMMIT_MS
        : Math.max(FORCE_COMMIT_MS, turnSeconds * 1000 * FORCE_COMMIT_TURN_FRACTION);
    const maxTokens =
      (this.options.reasoning && DECISION_MAX_TOKENS_DEEP[this.options.reasoning]) || DECISION_MAX_TOKENS;
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
      const pace =
        bank >= BANK_HEALTHY_SECONDS
          ? 'The bank is healthy: think as deeply as this decision warrants before committing.'
          : bank <= BANK_LOW_SECONDS
            ? 'The bank is low: commit quickly and rebuild time on easy turns.'
            : 'Spend time only where it changes the choice.';
      prompt += `\n\nShowdown timer: ${Math.round(turnSeconds)} seconds this turn; ${Math.round(bank)} seconds remain in the clock bank. ${pace}`;
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
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    const remainingMs = () => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - performance.now());
    const abandonToTimer = (caught: unknown): Promise<number[]> => {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.abandonedDecisions += 1;
      if (this.pending?.generation === generation) this.pending = undefined;
      this.remember(`[No choice submitted: ${message.slice(0, 200)}. The battle timer acts when time expires.]`);
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
      this.writeLog(this.options.decisionLog, {
        kind: 'decision',
        ...base,
        selection: [],
        action: 'abandoned',
        rationale: 'No decision was submitted; the battle timer decides.',
        threats: [],
        candidates: [],
        automatic: false,
        fallback: true,
        error: message,
        parse_failures: parseFailures,
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
        latency_ms: performance.now() - started,
        timer,
        parse_failures: parseFailures,
        tool_rounds: toolRounds,
        provider_retries: this.callRetries,
        tool_calls: toolCalls,
        fallback: true,
        error: message,
      });
      return new Promise<number[]>((_resolve, reject) =>
        this.abandonWaiters.add(() => reject(new DecisionAbandonedError())),
      );
    };
    while (!parsed && parseFailures < DECISION_PARSE_ATTEMPTS) {
      if (generation !== this.generation) throw new DecisionAbandonedError();
      if (parseFailures) {
        messages.push({ role: 'assistant', content: rawResponse });
        messages.push({
          role: 'user',
          content: `Your previous response was invalid. Error: ${error}. Reply again following the required JSON format.`,
        });
      }
      rawResponse = '';
      for (let round = 0; round <= DECISION_MAX_TOOL_ROUNDS; round += 1) {
        if (generation !== this.generation) throw new DecisionAbandonedError();
        if (request.timer && remainingMs() < 2000) return abandonToTimer(new Error('turn time exhausted'));
        const finalRound = round === DECISION_MAX_TOOL_ROUNDS || remainingMs() < forceCommitMs;
        let completion: Completion;
        try {
          completion = await this.completeWithRetry(
            messages,
            {
              maxTokens,
              temperature: DECISION_TEMPERATURE,
              tools: DECISION_TOOLS,
              toolChoice: finalRound ? 'none' : 'auto',
            },
            generation,
            SYSTEM,
            deadline,
            decisionSignal,
          );
        } catch (caught) {
          if (generation !== this.generation) throw new DecisionAbandonedError();
          if (request.timer && !this.options.signal?.aborted && isTransientError(caught)) return abandonToTimer(caught);
          throw caught;
        }
        for (const [key, value] of Object.entries(completion.usage)) usage[key] = (usage[key] ?? 0) + Math.trunc(value);
        if (completion.reasoning) reasoningParts.push(completion.reasoning);
        if (completion.toolCalls.length && !finalRound) {
          toolRounds += 1;
          const calls = boundedToolCalls(completion.toolCalls);
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
        rawResponse = completion.text;
        break;
      }
      if (!rawResponse) {
        error = 'empty response';
        break;
      }
      try {
        parsed = LLMEngine.extractChoices(rawResponse, menus);
        BaseEngine.parts(menus, parsed.choices);
      } catch (caught) {
        parsed = undefined;
        error = caught instanceof Error ? caught.message : String(caught);
        parseFailures += 1;
      }
    }
    const fallback = !parsed;
    const decision =
      parsed ??
      ({
        choices: BaseEngine.defaults(menus)[0],
        rationale: 'Recorded legal fallback.',
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
        fallback,
        error: fallback ? error : undefined,
        latencyMs: performance.now() - started,
        toolCalls,
        parseFailures,
        toolRounds,
        providerRetries: this.callRetries,
        generation,
      });
    return decision.choices;
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
        return await this.provider.complete(system, messages, attemptOptions);
      } catch (error) {
        if (
          attempt >= RETRY_ATTEMPTS - 1 ||
          generation !== this.generation ||
          signal?.aborted ||
          !isTransientError(error) ||
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
      this.notebook = notebook;
      this.decisions += 1;
      if (pending.fallback) this.fallbacks += 1;
      this.parseFailureCount += pending.parseFailures ?? 0;
      this.providerRetryCount += pending.providerRetries ?? 0;
      if (substitution) this.substitutedActions += 1;
    }
    const action = request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
    this.remember(`Decision: ${action}.`);
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
      ...substituted,
      parse_failures: pending.parseFailures ?? 0,
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
      latency_ms: pending.latencyMs ?? 0,
      timer,
      parse_failures: pending.parseFailures ?? 0,
      tool_rounds: pending.toolRounds ?? 0,
      provider_retries: pending.providerRetries ?? 0,
      tool_calls: pending.toolCalls ?? [],
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
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
      `Turns: ${String(context.outcome.turns ?? '?')}. Decision errors: ${String(context.outcome.errors ?? 0)}. Legal fallbacks: ${String(context.outcome.fallbacks ?? 0)}.`,
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
    try {
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        const completion = await this.completeWithRetry(
          messages,
          { maxTokens: REFLECTION_MAX_TOKENS, temperature: DECISION_TEMPERATURE, timeout: 60 },
          this.generation,
          REFLECTION_SYSTEM,
        );
        for (const [key, value] of Object.entries(completion.usage)) usage[key] = (usage[key] ?? 0) + Math.trunc(value);
        rawResponse = completion.text;
        try {
          parsed = LLMEngine.extractReflection(rawResponse);
          error = undefined;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          if (attempt === 0) {
            messages.push({ role: 'assistant', content: rawResponse });
            messages.push({
              role: 'user',
              content: `Invalid review: ${error}. Reply with exactly the required JSON object.`,
            });
          }
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const fallback = !parsed;
    const review =
      parsed ??
      ({
        summary: `Game ${result}; model reflection unavailable.`,
        adjustment: 'Retain the existing series plan and reassess from the next team preview.',
        notebook: this.notebook,
      } satisfies { summary: string; adjustment: string; notebook: string });
    this.reflections += 1;
    if (fallback) this.reflectionFallbacks += 1;
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
      fallback,
      error: error ?? null,
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
    });
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
    let length = this.transcript.reduce((total, line) => total + line.length, this.transcript.length - 1);
    while (length > TRANSCRIPT_CHARACTER_LIMIT && this.transcript.length > 1) {
      length -= this.transcript.shift()!.length + 1;
    }
    if (length > TRANSCRIPT_CHARACTER_LIMIT)
      this.transcript[0] = this.transcript[0]!.slice(-TRANSCRIPT_CHARACTER_LIMIT);
  }

  private rememberEvents(lines: string[]): void {
    const summary = summarizeBattleEvents(lines);
    if (summary.length) this.remember(summary.join('\n'));
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

function summarizeBattleEvents(lines: string[]): string[] {
  const summary: string[] = [];
  const ident = (value = '') => value.replace(/^p[12][a-z]?:\s*/, '');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const [, kind = '', ...args] = line.split('|');
    if (kind === 'turn') summary.push(`Turn ${args[0]} begins.`);
    else if ((kind === 'switch' || kind === 'drag' || kind === 'replace') && args.length >= 3)
      summary.push(`${ident(args[0])} entered as ${args[1]!.split(',', 1)[0]} at ${args[2]}.`);
    else if (kind === 'move' && args.length >= 2)
      summary.push(`${ident(args[0])} used ${args[1]}${args[2] ? ` into ${ident(args[2])}` : ''}.`);
    else if ((kind === '-damage' || kind === '-heal') && args.length >= 2)
      summary.push(`${ident(args[0])} HP became ${args[1]}${kind === '-heal' ? ' after healing' : ''}.`);
    else if (kind === 'faint' && args[0]) summary.push(`${ident(args[0])} fainted.`);
    else if (kind === 'cant' && args.length >= 2) summary.push(`${ident(args[0])} could not act (${args[1]}).`);
    else if (kind === '-status' && args.length >= 2) summary.push(`${ident(args[0])} became ${args[1]}.`);
    else if (kind === '-curestatus' && args.length >= 2) summary.push(`${ident(args[0])} was cured of ${args[1]}.`);
    else if (kind === '-ability' && args.length >= 2) summary.push(`${ident(args[0])} revealed ${args[1]}.`);
    else if (kind === '-mega' && args[0]) summary.push(`${ident(args[0])} Mega Evolved.`);
    else if (kind === '-miss' && args.length >= 2) summary.push(`${ident(args[0])} missed ${ident(args[1])}.`);
    else if (kind === '-immune' && args[0]) summary.push(`${ident(args[0])} was immune.`);
    else if (kind === '-fail' && args[0]) summary.push(`${ident(args[0])}'s action failed.`);
    else if (kind === '-crit' && args[0]) summary.push(`A critical hit landed on ${ident(args[0])}.`);
    else if (kind === '-supereffective' && args[0]) summary.push(`The hit on ${ident(args[0])} was super effective.`);
    else if (kind === '-resisted' && args[0]) summary.push(`${ident(args[0])} resisted the hit.`);
    else if (kind === '-activate' && args.length >= 2) summary.push(`${ident(args[0])} activated ${args[1]}.`);
    else if ((kind === '-start' || kind === '-end') && args.length >= 2)
      summary.push(`${ident(args[0])} ${kind === '-start' ? 'gained' : 'lost'} ${args[1]}.`);
    else if ((kind === '-boost' || kind === '-unboost') && args.length >= 3)
      summary.push(`${ident(args[0])} ${args[1]} ${kind === '-boost' ? 'rose' : 'fell'} by ${args[2]}.`);
    else if (kind === '-weather' && !args.includes('[upkeep]')) summary.push(`Weather became ${args[0] || 'none'}.`);
    else if (kind === '-fieldstart' && args[0]) summary.push(`Field started: ${args[0]}.`);
    else if (kind === '-fieldend' && args[0]) summary.push(`Field ended: ${args[0]}.`);
    else if ((kind === '-sidestart' || kind === '-sideend') && args.length >= 2)
      summary.push(`${args[0]} ${kind === '-sidestart' ? 'gained' : 'lost'} ${args[1]}.`);
    else if (kind === 'win' && args[0]) summary.push(`${args[0]} won the game.`);
    else if (kind === 'tie') summary.push('The game tied.');
    else if (kind === 'timer' && args[0])
      summary.push(
        args[0] === 'autodefault'
          ? 'Move time expired; the simulator chose default actions.'
          : args[0] === 'forfeit'
            ? 'The time bank ran out; the game was lost on time.'
            : 'The game was declared a tie on time.',
      );
  }
  return summary.slice(-60);
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
