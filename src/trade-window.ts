import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { completeWithDexTools } from './dex-lookups.js';
import type { DraftBoard, DraftBoardMon } from './draft.js';
import { draftBoardTable } from './draft.js';
import type { DraftTableRow } from './gui/api.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
  resolveSpecOverride,
} from './providers.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import type { JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';
import { clip } from './value.js';

export const DEFAULT_TRADE_WINDOW = { afterWeek: 3 } as const;
export const MAX_TRADE_SWAPS = 6;

const TRADE_WINDOW_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}.',
    '',
    'The league has reached its one mid-season free-agency window. This is a roster decision, not an instruction to change it.',
    '- You may submit zero to {{maxSwaps}} swaps. Each swap pairs one Pokémon you drop with one undrafted Pokémon you add.',
    '- Adds use their board price and drops refund their full board price.',
    '- Your resulting roster must contain exactly {{picks}} Pokémon, cost no more than {{budget}} points, and contain only one entry from each base species.',
    '- A Mega entry may replace its base entry or be added without owning that base entry. Its listed Mega Stone remains locked.',
    '- Every swap is validated and applied together. If any swap is illegal, none are applied and you reply again.',
    '- Coaches act in inverse standings order. Pokémon dropped by an earlier coach are available now.',
    '',
    'You have the same Showdown dex tools as during the draft. Use them only where the supplied evidence and board do not answer the question.',
  ],
  rejectionTemplate: 'That transaction list was rejected: {{error}} Reply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before completing the JSON object. Reply now with only the JSON object.',
  notebookLimit: 4_000,
  rationaleLimit: 2_000,
  maxTokens: 32_768,
  timeoutSeconds: 600,
  attempts: 3,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 8,
  maxCallsPerRound: 6,
} as const;

export interface TradeWindowConfig {
  afterWeek: number;
}

export interface TradeSwap {
  drop: string;
  add: string;
}

export interface TradeWindowDecision {
  entrant: number;
  model: string;
  swaps: TradeSwap[];
  reasoning: string;
  notebook: string;
  fallback: boolean;
}

export interface TradeWindowRoster {
  model: string;
  team_name: string;
  budget_left: number;
  spent: number;
  roster: Array<{ id: string; name: string; cost: number }>;
}

export interface TradeWindowArtifact {
  after_week: number;
  order: number[];
  decisions: TradeWindowDecision[];
  rosters: TradeWindowRoster[];
}

export interface TradeWindowResult {
  entrant: number;
  opponent: number;
  week: number;
  score: [number, number];
  result: 'won' | 'lost' | 'drew';
  opponentRoster: string;
}

export interface TradeWindowState {
  board: DraftBoard;
  models: string[];
  teamNames: string[];
  rosters: DraftBoardMon[][];
  budgets: number[];
  notebooks: string[];
  standings: DraftTableRow[];
  results: TradeWindowResult[][];
  reflections: string[][];
}

export interface RunTradeWindowOptions extends ModelReasoningConfig {
  runDir: string;
  psDir: string;
  afterWeek: number;
  recovery?: RecoveryGate;
  signal?: AbortSignal;
  apiKeys?: Readonly<Record<string, string>>;
  makeTradeProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
  onDecision?: (decision: TradeWindowDecision) => void;
}

interface ParsedTradeDecision {
  swaps: TradeSwap[];
  reasoning: string;
  notebook: string;
}

interface TradeSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

export function tradeWindowScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(TRADE_WINDOW_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'model'
  );
}

function ownerMap(state: TradeWindowState): Map<string, number> {
  const owners = new Map<string, number>();
  for (const [entrant, roster] of state.rosters.entries()) {
    for (const mon of roster) owners.set(mon.id, entrant);
  }
  return owners;
}

export function parseTradeDecision(
  response: string,
  state: TradeWindowState,
  entrant: number,
): ParsedTradeDecision | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return 'the reply must be one JSON object';
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.swaps)) return '"swaps" must be an array, including when it is empty';
  if (record.swaps.length > MAX_TRADE_SWAPS) return `a coach may make at most ${MAX_TRADE_SWAPS} swaps`;
  if (typeof record.notebook !== 'string') return '"notebook" must be a string to carry into later matches';

  const swaps: TradeSwap[] = [];
  for (const [index, value] of record.swaps.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `swap ${index + 1} must be an object with "drop" and "add" board ids`;
    }
    const swap = value as Record<string, unknown>;
    const drop = typeof swap.drop === 'string' ? slug(swap.drop) : '';
    const add = typeof swap.add === 'string' ? slug(swap.add) : '';
    if (!drop || !add) return `swap ${index + 1} must name both "drop" and "add" board ids`;
    swaps.push({ drop, add });
  }

  const dropIds = new Set(swaps.map((swap) => swap.drop));
  const addIds = new Set(swaps.map((swap) => swap.add));
  if (dropIds.size !== swaps.length) return 'the same roster entry cannot be dropped twice';
  if (addIds.size !== swaps.length) return 'the same free agent cannot be added twice';

  const roster = state.rosters[entrant];
  if (!roster) return `unknown entrant ${entrant}`;
  const byId = new Map(state.board.mons.map((mon) => [mon.id, mon] as const));
  const owners = ownerMap(state);
  for (const [index, swap] of swaps.entries()) {
    if (!roster.some((mon) => mon.id === swap.drop)) {
      return `swap ${index + 1} cannot drop ${JSON.stringify(swap.drop)} because it is not on this roster`;
    }
    const added = byId.get(swap.add);
    if (!added) return `swap ${index + 1} adds ${JSON.stringify(swap.add)}, which is not a board id`;
    const owner = owners.get(added.id);
    if (owner !== undefined) {
      return `swap ${index + 1} cannot add ${added.name} because ${state.teamNames[owner] || state.models[owner]} owns it`;
    }
  }

  const kept = roster.filter((mon) => !dropIds.has(mon.id));
  const additions = swaps.map((swap) => byId.get(swap.add)!);
  const next = [...kept, ...additions];
  if (next.length !== state.board.picks)
    return `the resulting roster must contain exactly ${state.board.picks} entries`;
  if (new Set(next.map((mon) => mon.id)).size !== next.length) return 'the resulting roster contains a duplicate entry';
  if (new Set(next.map((mon) => mon.base)).size !== next.length) {
    return 'the resulting roster contains two entries from the same base species';
  }
  const spent = next.reduce((sum, mon) => sum + mon.cost, 0);
  if (spent > state.board.budget) {
    return `the resulting roster costs ${spent} points, above the ${state.board.budget}-point budget`;
  }
  return {
    swaps,
    reasoning: clip(String(record.reasoning ?? '').trim(), TRADE_WINDOW_PROMPT_POLICY.rationaleLimit),
    notebook: clip(record.notebook.trim(), TRADE_WINDOW_PROMPT_POLICY.notebookLimit),
  };
}

export function applyTradeDecision(state: TradeWindowState, entrant: number, decision: ParsedTradeDecision): void {
  const drops = new Set(decision.swaps.map((swap) => swap.drop));
  const byId = new Map(state.board.mons.map((mon) => [mon.id, mon] as const));
  state.rosters[entrant] = [
    ...state.rosters[entrant]!.filter((mon) => !drops.has(mon.id)),
    ...decision.swaps.map((swap) => byId.get(swap.add)!),
  ];
  state.budgets[entrant] = state.board.budget - state.rosters[entrant]!.reduce((sum, mon) => sum + mon.cost, 0);
  state.notebooks[entrant] = decision.notebook;
}

function systemPrompt(state: TradeWindowState, entrant: number): string {
  const values: Record<string, string> = {
    model: state.models[entrant]!,
    format: state.board.format,
    maxSwaps: String(MAX_TRADE_SWAPS),
    picks: String(state.board.picks),
    budget: String(state.board.budget),
  };
  return TRADE_WINDOW_PROMPT_POLICY.systemTemplate
    .map((line) =>
      Object.entries(values).reduce(
        (rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value),
        line as string,
      ),
    )
    .join('\n');
}

function rosterLine(roster: readonly DraftBoardMon[]): string {
  return roster.map((mon) => `${mon.id} (${mon.cost})`).join(', ');
}

function userPrompt(state: TradeWindowState, entrant: number, psDir: string): string {
  const owners = ownerMap(state);
  const available = state.board.mons.filter((mon) => !owners.has(mon.id));
  const lines = ['LEAGUE STANDINGS (rank | team | W-L | games):'];
  for (const [rank, row] of state.standings.entries()) {
    lines.push(
      `${rank + 1}. ${state.teamNames[row.entrant] || state.models[row.entrant]} | ${row.w}-${row.l} | ${row.gw}-${row.gl}`,
    );
  }
  lines.push('', 'YOUR ROUND-ROBIN RESULTS:');
  const results = state.results[entrant] ?? [];
  if (!results.length) lines.push('- (none recorded)');
  for (const result of results) {
    lines.push(
      `- Week ${result.week}: ${result.result} ${state.teamNames[result.opponent] || state.models[result.opponent]} ` +
        `${result.score[0]}-${result.score[1]}; opposing roster: ${result.opponentRoster}`,
    );
  }
  lines.push('', 'YOUR PRIVATE WORDS:');
  lines.push(`- Final draft notebook: ${state.notebooks[entrant] || '(empty)'}`);
  for (const [index, reflection] of (state.reflections[entrant] ?? []).entries()) {
    lines.push(`- Series reflection ${index + 1}: ${reflection || '(empty)'}`);
  }
  lines.push('', 'PUBLIC CURRENT ROSTERS:');
  for (const [index, roster] of state.rosters.entries()) {
    lines.push(`- ${state.teamNames[index] || state.models[index]}: ${rosterLine(roster)}`);
  }
  lines.push(
    '',
    draftBoardTable(
      state.board,
      psDir,
      available,
      'UNDRAFTED FREE AGENTS (id | cost | name | types | base stats | abilities):',
    ),
    '',
    `YOUR ROSTER: ${rosterLine(state.rosters[entrant]!)}`,
    `Budget: ${state.board.budget - state.budgets[entrant]!}/${state.board.budget} spent; each drop refunds its listed price.`,
    '',
    'Reply with one JSON object {"swaps":[{"drop":"<board-id>","add":"<board-id>"},...],"reasoning":"<roster diagnosis>","notebook":"<updated private plan>"}, where "swaps" may instead be [].',
    'The populated list and {"swaps":[],"reasoning":"<roster diagnosis>","notebook":"<updated private plan>"} are equally complete responses.',
  );
  return lines.join('\n');
}

function rosterArtifact(state: TradeWindowState): TradeWindowRoster[] {
  return state.models.map((model, entrant) => ({
    model,
    team_name: state.teamNames[entrant]!,
    budget_left: state.budgets[entrant]!,
    spent: state.board.budget - state.budgets[entrant]!,
    roster: state.rosters[entrant]!.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
  }));
}

function replayDecisions(file: string, order: readonly number[], state: TradeWindowState): TradeWindowDecision[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const { timestamp: _timestamp, ...decision } = JSON.parse(line) as TradeWindowDecision & {
        timestamp?: string;
      };
      return decision as TradeWindowDecision;
    });
  for (const [index, row] of rows.entries()) {
    const entrant = order[index];
    if (entrant === undefined) throw new Error(`${file} holds more decisions than the trade window has seats`);
    if (row.entrant !== entrant || row.model !== state.models[entrant]) {
      throw new Error(`${file} decision ${index + 1} does not match the trade-window order`);
    }
    const parsed = parseTradeDecision(JSON.stringify(row), state, entrant);
    if (typeof parsed === 'string') throw new Error(`${file} decision ${index + 1} is invalid: ${parsed}`);
    applyTradeDecision(state, entrant, parsed);
  }
  return rows;
}

export async function runTradeWindow(
  state: TradeWindowState,
  options: RunTradeWindowOptions,
): Promise<TradeWindowArtifact> {
  const order = state.standings.map((row) => row.entrant).reverse();
  const transcript = path.join(options.runDir, 'window.jsonl');
  const logDir = path.join(options.runDir, 'window');
  fs.mkdirSync(logDir, { recursive: true });
  const decisions = replayDecisions(transcript, order, state);
  const providers = state.models.map((model) => {
    if (model === 'random') return undefined;
    const make =
      options.makeTradeProvider ??
      ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => {
        const resolved = resolveSpecOverride(spec);
        return makeProvider(parseSpec(resolved), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(resolved === spec && apiKey !== undefined ? { apiKey } : {}),
        });
      });
    return make(model, options.apiKeys?.[model], reasoningForModel(model, options));
  });
  const reference = new ShowdownReference(state.board.format, options.psDir);

  for (const [position, entrant] of order.entries()) {
    if (position < decisions.length) continue;
    options.signal?.throwIfAborted();
    const provider = providers[entrant];
    let parsed: ParsedTradeDecision | undefined;
    let fallback = false;
    let lastError = '';
    const system = systemPrompt(state, entrant);
    if (provider) {
      const messages: ProviderMessage[] = [{ role: 'user', content: userPrompt(state, entrant, options.psDir) }];
      const seatLog = path.join(logDir, `seat-${entrant}-${slug(state.models[entrant]!)}.jsonl`);
      for (let attempt = 1; attempt <= TRADE_WINDOW_PROMPT_POLICY.attempts && !parsed; attempt += 1) {
        const promptForAttempt = messages[messages.length - 1]!.content ?? '';
        let response = '';
        let usage: Record<string, number> | undefined;
        let error: string | undefined;
        let terminalError: Error | undefined;
        let pauseFailure: ProviderFailure | undefined;
        const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
        try {
          const completion = await completeWithDexTools({
            provider,
            system,
            messages,
            spec: state.models[entrant]!,
            reference,
            policy: TRADE_WINDOW_PROMPT_POLICY,
            ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onLookup: (call) => lookups.push(call),
          });
          response = completion.text;
          usage = completion.usage;
          const candidate = parseTradeDecision(response || completion.reasoning || '', state, entrant);
          if (typeof candidate === 'string') {
            error =
              completion.finishReason === 'length'
                ? 'the reply was cut off before completing the transaction list'
                : candidate;
            lastError = error;
            messages.push({ role: 'assistant', content: response || '[the reply contained no visible text]' });
            messages.push({
              role: 'user',
              content:
                completion.finishReason === 'length'
                  ? TRADE_WINDOW_PROMPT_POLICY.truncatedTemplate.replace(
                      '{{budget}}',
                      String(TRADE_WINDOW_PROMPT_POLICY.maxTokens),
                    )
                  : TRADE_WINDOW_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', candidate),
            });
          } else {
            parsed = candidate;
          }
        } catch (cause) {
          const failure = classifyProviderFailure(cause, state.models[entrant]);
          error = failure.summary;
          lastError = error;
          if (failure.pausable && options.recovery) pauseFailure = failure;
          else terminalError = new Error(`${failure.summary} The trade window cannot continue.`, { cause });
        }
        fs.appendFileSync(
          seatLog,
          `${JSON.stringify({
            attempt,
            ...(attempt === 1 ? { system } : {}),
            user: promptForAttempt,
            response,
            ...(usage ? { usage } : {}),
            ...(lookups.length ? { tool_lookups: lookups } : {}),
            ...(error ? { error } : {}),
          } satisfies TradeSeatLog)}\n`,
          'utf8',
        );
        if (terminalError) throw terminalError;
        if (pauseFailure) {
          await options.recovery?.pause(
            state.models[entrant]!,
            pauseFailure.kind,
            pauseFailure.summary,
            options.signal,
          );
          attempt -= 1;
        }
      }
    }
    if (!parsed) {
      parsed = {
        swaps: [],
        reasoning: provider
          ? `kept the roster after ${TRADE_WINDOW_PROMPT_POLICY.attempts} rejected replies (${lastError})`
          : 'random baseline kept its drafted roster',
        notebook: state.notebooks[entrant]!,
      };
      fallback = Boolean(provider);
    }
    applyTradeDecision(state, entrant, parsed);
    const decision: TradeWindowDecision = {
      entrant,
      model: state.models[entrant]!,
      swaps: parsed.swaps,
      reasoning: parsed.reasoning,
      notebook: parsed.notebook,
      fallback,
    };
    decisions.push(decision);
    fs.appendFileSync(transcript, `${JSON.stringify({ ...decision, timestamp: new Date().toISOString() })}\n`, 'utf8');
    options.onDecision?.(decision);
  }

  const artifact: TradeWindowArtifact = {
    after_week: options.afterWeek,
    order,
    decisions,
    rosters: rosterArtifact(state),
  };
  fs.writeFileSync(path.join(options.runDir, 'window.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

export function readTradeWindow(runDir: string): TradeWindowArtifact | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'window.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as TradeWindowArtifact;
  return Array.isArray(record.rosters) && Array.isArray(record.decisions) && Array.isArray(record.order)
    ? record
    : undefined;
}

export function readCurrentRosterArtifact(runDir: string): unknown {
  const window = readTradeWindow(runDir);
  if (window) return window.rosters;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'rosters.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}
