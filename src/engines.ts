import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { SlotMenu, TargetNames } from './choices.js';
import { buildMenus, compose } from './choices.js';
import { renderDecision, SYSTEM } from './prompts.js';
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

export abstract class BaseEngine implements BattleAgent {
  constructor(readonly pid: Pid) {}

  beginGame(_context: GameStart): void {}
  endGame(_context: GameEnd): void {}
  observe(_lines: string[]): void {}
  abandonDecision(): void {}
  decisionStats(): Record<string, number> {
    return {};
  }

  async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const menus = buildMenus(request, this.menuNames(request));
    if (!menus.length) return '';
    let automatic = menus.every((menu) => menu.length === 1);
    let choices = automatic ? menus.map(() => 0) : await this.decideJoint(menus, request, context);
    let parts: string[];
    try {
      parts = BaseEngine.parts(menus, choices);
    } catch {
      [choices, parts] = BaseEngine.defaults(menus);
      automatic = false;
    }
    this.actionCommitted(request, context, menus, choices, parts, automatic);
    return request.teamPreview ? `team ${parts.join('')}` : compose(parts);
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
  ): void {}
  protected menuNames(_request: BattleRequest): TargetNames | undefined {
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
      if (!BaseEngine.remaining(menu, parts).includes(item))
        throw new Error(`choice for slot ${slot + 1} conflicts with an earlier slot`);
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
      const item = candidates[index < 0 ? candidates.length - 1 : index]!;
      choices.push(menu.indexOf(item));
      parts.push(item.part);
    }
    return choices;
  }
}

interface TranscriptEntry {
  full: string;
  brief: string;
}
interface PendingDecision extends JsonObject {
  events?: string[];
  rawResponse?: string;
  notes?: string;
  generation: number;
  usage?: Record<string, number>;
  fallback?: boolean;
  error?: string;
  latencyMs?: number;
  toolCalls?: number;
}

export interface LLMEngineOptions {
  provider?: Provider;
  decisionLog?: DecisionLog;
  format?: string;
  psDir?: string;
  reference?: ShowdownReference;
  reasoning?: ReasoningLevel;
  signal?: AbortSignal;
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;

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
  private static readonly NOTE_LIMIT = 2400;
  readonly provider: Provider;
  readonly reference: ShowdownReference;
  private state: BattleState;
  private transcript: TranscriptEntry[] = [];
  private notebook = '';
  private gameId: string;
  private seriesId?: string;
  private gameNumber = 1;
  private seriesScore: Record<Pid, number> = { p1: 0, p2: 0 };
  private decisions = 0;
  private fallbacks = 0;
  private pending: PendingDecision | undefined;
  private generation = 0;

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
    this.gameId = context.gameId;
    this.gameNumber = context.gameNumber;
    this.seriesId = context.seriesId;
    this.seriesScore = { ...(context.seriesScore ?? { p1: 0, p2: 0 }) };
    this.state = new BattleState(this.pid);
    this.pending = undefined;
    this.compactTranscript();
    this.remember(`[Game ${context.gameNumber} begins; series score ${this.scoreText()}]`);
  }

  override endGame(context: GameEnd): void {
    this.seriesScore = { ...(context.seriesScore ?? this.seriesScore) };
    this.remember(
      `[Game ${context.gameNumber} ended; winner ${text(context.outcome.winner, 'tie') || 'tie'}; series score ${this.scoreText()}]`,
    );
    this.compactTranscript();
  }

  override observe(lines: string[]): void {
    const valid = lines.filter((line) => typeof line === 'string');
    if (!valid.length) return;
    this.state.feed(valid);
    this.remember(
      `Observed after the final decision:\n${valid.join('\n')}`,
      'Observed after the final decision: (events elided)',
    );
    this.compactTranscript();
  }

  override abandonDecision(): void {
    this.generation += 1;
    this.pending = undefined;
  }

  override async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const events = context.povLines.filter((line) => typeof line === 'string');
    const generation = this.generation;
    this.state.feed(events);
    this.pending = { events, rawResponse: '', notes: this.notebook, generation };
    const choice = await super.act(request, context);
    return generation === this.generation ? choice : '';
  }

  protected override async decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> {
    const started = performance.now();
    const turnSeconds = request.timer?.turnSeconds;
    const deadline = turnSeconds === undefined ? undefined : started + 1000 * turnSeconds;
    const generation = this.generation;
    let prompt = renderDecision({
      state: this.state.render(request),
      slotNames: menus.map((_, slot) => this.state.slotName(slot, request)),
      menus,
      transcript: this.transcript.map((entry) => entry.brief),
      notebook: this.notebook,
      seriesContext: `Series ${this.seriesId ?? '?'}; game ${this.gameNumber}; score ${this.scoreText()}`,
    });
    if (turnSeconds !== undefined)
      prompt += `\n\nShowdown timer: ${turnSeconds} seconds for this decision; ${request.timer?.seconds ?? turnSeconds} seconds remain in your clock bank.`;
    if (context.error) prompt += `\n\nThe simulator rejected the previous joint action: ${context.error}`;

    let rawResponse = '';
    const usage: Record<string, number> = {};
    let parsed: [number[], string] | undefined;
    let error = 'no choices found';
    let parseFailures = 0;
    let toolCalls = 0;
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];
    while (!parsed && parseFailures < 2) {
      if (generation !== this.generation) return menus.map(() => 0);
      if (parseFailures) {
        messages.push({ role: 'assistant', content: rawResponse });
        messages.push({
          role: 'user',
          content: `Your previous response was invalid. Error: ${error}. Reply again following the required JSON format.`,
        });
      }
      rawResponse = '';
      for (let round = 0; round < 6; round += 1) {
        if (generation !== this.generation) return menus.map(() => 0);
        const finalRound = round === 5;
        const completion = await this.completeWithRetry(
          messages,
          {
            maxTokens: 8192,
            temperature: 0.6,
            tools: DEX_TOOLS,
            toolChoice: finalRound ? 'none' : 'auto',
            ...(deadline === undefined ? {} : { timeout: Math.max(0.1, (deadline - performance.now()) / 1000 + 1) }),
          },
          generation,
        );
        for (const [key, value] of Object.entries(completion.usage)) usage[key] = (usage[key] ?? 0) + Math.trunc(value);
        if (completion.toolCalls.length && !finalRound) {
          toolCalls += completion.toolCalls.length;
          messages.push(assistantToolMessage(completion));
          for (const call of completion.toolCalls)
            messages.push(toolResultMessage(call.id, this.reference.lookup(call.name, call.arguments)));
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
        BaseEngine.parts(menus, parsed[0]);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        parseFailures += 1;
      }
    }
    const fallback = !parsed;
    const [choices, notes] = parsed ?? [BaseEngine.defaults(menus)[0], this.notebook];
    if (generation === this.generation && this.pending)
      Object.assign(this.pending, {
        rawResponse,
        notes,
        usage,
        fallback,
        error: fallback ? error : undefined,
        latencyMs: performance.now() - started,
        toolCalls,
        generation,
      });
    return choices;
  }

  private async completeWithRetry(
    messages: ProviderMessage[],
    options: CompleteOptions,
    generation: number,
  ): Promise<Completion> {
    const signal = this.options.signal;
    const withSignal: CompleteOptions = signal ? { ...options, signal } : options;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.provider.complete(SYSTEM, messages, withSignal);
      } catch (error) {
        if (
          attempt >= RETRY_ATTEMPTS - 1 ||
          generation !== this.generation ||
          signal?.aborted ||
          !isTransientError(error)
        )
          throw error;
        if (signal) await delay(RETRY_BASE_MS * 2 ** attempt, undefined, { signal });
        else await delay(RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }

  protected override actionCommitted(
    _request: BattleRequest,
    _context: AgentContext,
    menus: SlotMenu[],
    choices: number[],
    parts: string[],
    automatic: boolean,
  ): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.generation !== this.generation) return;
    const notes = pending.notes ?? this.notebook;
    if (!automatic) {
      this.notebook = notes;
      this.decisions += 1;
      if (pending.fallback) this.fallbacks += 1;
    }
    const entry = pending.events?.length
      ? [`Events from your point of view:\n${pending.events.join('\n')}`, `Chosen joint action: ${compose(parts)}`]
      : [`Chosen joint action: ${compose(parts)}`];
    if (automatic) entry.push('(automatic; no model call required)');
    this.remember(entry.join('\n'), pending.events?.length ? entry.slice(1).join('\n') : entry.join('\n'));
    this.compactTranscript();
    if (automatic) return;
    this.writeDecision({
      game_id: this.gameId,
      series_id: this.seriesId ?? null,
      game_number: this.gameNumber,
      turn: this.state.turn,
      pid: this.pid,
      menus: menus.map((menu) => menu.map((item) => item.label)),
      choices,
      parts,
      notes,
      fallback: pending.fallback ?? false,
      error: pending.error ?? null,
      raw_response: pending.rawResponse ?? '',
      usage: pending.usage ?? {},
      latency_ms: pending.latencyMs ?? 0,
      tool_calls: pending.toolCalls ?? 0,
    });
  }

  override decisionStats(): Record<string, number> {
    return { decisions: this.decisions, fallbacks: this.fallbacks };
  }

  protected override menuNames(request: BattleRequest): TargetNames | undefined {
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
    return names;
  }

  static extractChoices(response: string, menus: SlotMenu[]): [number[], string] {
    const objects = jsonObjects(response).filter((value) => 'choices' in value || 'choice' in value);
    const object = objects.at(-1);
    if (!object) throw new Error('no JSON object with a choices key');
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
    const notes =
      typeof object.notes === 'string' ? object.notes : object.notes == null ? '' : JSON.stringify(object.notes);
    return [choices, notes.slice(0, LLMEngine.NOTE_LIMIT)];
  }

  private remember(full: string, brief = full): void {
    this.transcript.push({ full, brief });
  }

  private compactTranscript(): void {
    for (const entry of this.transcript) entry.full = entry.brief;
  }

  private scoreText(): string {
    return `p1 ${this.seriesScore.p1}, p2 ${this.seriesScore.p2}`;
  }

  private writeDecision(row: JsonObject): void {
    const output = this.options.decisionLog;
    if (!output) return;
    if (typeof output === 'function') output(row);
    else if (Array.isArray(output)) output.push(row);
    else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.appendFileSync(output, `${JSON.stringify(row)}\n`, 'utf8');
    }
  }
}

function jsonObjects(input: string): JsonObject[] {
  const values: JsonObject[] = [];
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
          if (isRecord(value)) values.push(value);
        } catch {}
        break;
      }
    }
  }
  return values;
}
