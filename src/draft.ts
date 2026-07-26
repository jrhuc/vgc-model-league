import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { completeWithDexTools } from './dex-lookups.js';
import type { BoardInfo, DraftBoardMonView, DraftPickView } from './gui/api.js';
import { BOARDS_DIR, defaultPsDir } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { classifyProviderFailure, makeProvider, parseSpec, reasoningForModel } from './providers.js';
import type { Rng } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import { loadShowdown } from './showdown.js';
import type { Provider, ProviderFailure, ProviderMessage } from './types.js';
import { text } from './value.js';

const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DRAFT_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}.',
    '',
    'LEAGUE RULES',
    '- {{coaches}} coaches snake-draft {{picks}} Pokémon each from the shared board below.',
    '- Every coach has {{budget}} points. A Pokémon drafted by one coach is gone for everyone else.',
    '- You may not draft two entries that share a base species, so Charizard and Mega Charizard Y are alternatives, not a pair.',
    '- Mega entries are drafted separately from their base forme. Drafting a Mega locks that Pokémon to its Mega Stone;',
    '  drafting the base forme means it can never hold a Mega Stone. The board lists both, priced differently.',
    '- After the draft you keep this roster for the whole season: a round robin of best-of-three matches, then playoffs.',
    '- Before each match you choose 6 of your {{picks}} and build every set yourself: item, ability, nature, moves, and EVs.',
    '  Nothing about a set is fixed by the draft, so draft for options and roles rather than for one preset build.',
    '- Games are 4-of-6 doubles. You will see your opponent’s full roster before you build, and they will see yours.',
    '',
    'You have the Showdown dex tools. Use them to check anything the board summary does not answer: what a Mega',
    'becomes, how a type matchup reads, what a spread outruns, or roughly how hard an attack hits. They compute',
    'from the simulator this league runs on, so trust them over recollection.',
    '',
    'Draft a coherent, deep roster: speed control, offensive modes, defensive backbone, and answers to what your',
    'opponents have already taken. Cheap Pokémon exist to round out a roster once you have spent on your core.',
    '',
    '{{board}}',
  ],
  firstTurnInstruction:
    'This is your first pick, so also choose your franchise name: a sports-style team name in the WDL house style, ' +
    'such as "East Coast Egg Eaters", "Melbourne Rotoms" or "Jubilife Piplups". Reply with a single JSON object ' +
    '{"pick": "<board-id>", "team_name": "<your franchise name>", "reasoning": "<2-4 sentences>"} and nothing else.',
  turnInstruction:
    'Reply with a single JSON object {"pick": "<board-id>", "reasoning": "<2-4 sentences>"} and nothing else.',
  turnTemplate:
    'Overall pick {{pick}} of {{total}}. You have {{budget}} points and {{remaining}} left, so you must keep ' +
    '{{reserve}} points back for the rest of your roster: the most you can spend now is {{affordable}}.',
  boardHeading: 'DRAFT BOARD (id | cost | name | types | base stats | abilities):',
  takenHeading: 'ALREADY DRAFTED:',
  nothingTaken: '- (nothing yet; you have the first pick)',
  rosterHeading: 'YOUR ROSTER:',
  emptyRoster: '- (empty)',
  rejectionTemplate: 'That pick was rejected: {{error}}. Reply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before naming a pick. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.',
  maxTokens: 32_768,
  timeoutSeconds: 600,
  attempts: 3,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 3,
  maxCallsPerRound: 6,
  fallback: 'uniform-random-legal',
} as const;

export function draftScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(DRAFT_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

export interface DraftBoardMon {
  id: string;
  name: string;
  /** Registered forme: the base species, plus its stone for Mega entries. */
  species: string;
  /** Mega forme this entry becomes in battle; absent for non-Mega entries. */
  forme?: string;
  /** Mega Stone this entry is locked to; absent for non-Mega entries. */
  item?: string;
  /** Species-clause key: two entries sharing it cannot join one roster. */
  base: string;
  types: string[];
  cost: number;
  origin: string;
  anchor?: string;
  /** Reg M-B ladder usage behind a re-priced entry. */
  usage?: string;
  /** The pre-adjustment price, present only when usage moved it. */
  listed?: number;
}

export interface DraftBoard {
  id: string;
  format: string;
  budget: number;
  picks: number;
  source: string;
  mons: DraftBoardMon[];
}

export function boardInfo(board: DraftBoard): BoardInfo {
  const cheapest = [...new Set(board.mons.map((mon) => mon.base))]
    .map((base) => Math.min(...board.mons.filter((mon) => mon.base === base).map((mon) => mon.cost)))
    .sort((a, b) => a - b);
  const affordable = cheapest.slice(0, board.picks).reduce((sum, cost) => sum + cost, 0) <= board.budget;
  return {
    id: board.id,
    format: board.format,
    monCount: board.mons.length,
    budget: board.budget,
    picks: board.picks,
    maxEntrants: affordable ? Math.min(8, Math.floor(cheapest.length / board.picks)) : 0,
  };
}

export function listBoards(boardsDir = BOARDS_DIR): BoardInfo[] {
  if (!fs.existsSync(boardsDir)) return [];
  const infos: BoardInfo[] = [];
  for (const entry of fs.readdirSync(boardsDir).sort()) {
    if (!entry.endsWith('.json')) continue;
    try {
      infos.push(boardInfo(loadBoard(entry.slice(0, -'.json'.length), boardsDir)));
    } catch {}
  }
  return infos;
}

export function loadBoard(name: string, boardsDir = BOARDS_DIR, psDir = defaultPsDir()): DraftBoard {
  if (!BOARD_SLUG.test(name)) throw new Error('board name must be lowercase letters, digits, and dashes');
  const file = path.join(boardsDir, `${name}.json`);
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`invalid board ${file}`);
  const manifest = data as Record<string, unknown>;
  const id = text(manifest.id);
  const format = text(manifest.format);
  const budget = Number(manifest.budget);
  const picks = Number(manifest.picks);
  if (!id || !format.endsWith('bo3')) throw new Error(`${file} needs an id and a BO3 format`);
  if (id !== name) throw new Error(`${file} id must match its filename`);
  if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(picks) || picks < 4) {
    throw new Error(`${file} needs an integer budget and at least 4 picks per entrant`);
  }
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(format).mod || 'base');
  const entries = Array.isArray(manifest.mons) ? manifest.mons : [];
  const seen = new Set<string>();
  const mons = entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    const mon: DraftBoardMon = {
      id: text(record.id),
      name: text(record.name),
      species: text(record.species),
      ...(record.forme ? { forme: text(record.forme) } : {}),
      ...(record.item ? { item: text(record.item) } : {}),
      base: text(record.base),
      types: Array.isArray(record.types) ? record.types.map((type) => String(type)) : [],
      cost: Number(record.cost),
      origin: text(record.origin),
      ...(record.anchor ? { anchor: text(record.anchor) } : {}),
      ...(record.usage ? { usage: text(record.usage) } : {}),
      ...(record.listed === undefined ? {} : { listed: Number(record.listed) }),
    };
    if (!BOARD_SLUG.test(mon.id) || !mon.name || !mon.base || !Number.isInteger(mon.cost) || mon.cost < 1) {
      throw new Error(`invalid board entry ${JSON.stringify(record.id)} in ${file}`);
    }
    const species = dex.species.get(mon.species);
    if (!species.exists || species.isNonstandard) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} is not a legal species in ${format}`);
    }
    if (mon.item && !dex.items.get(mon.item).exists) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} names an unknown item`);
    }
    if (seen.has(mon.id)) throw new Error(`duplicate board entry ${JSON.stringify(mon.id)} in ${file}`);
    seen.add(mon.id);
    return mon;
  });
  if (mons.length < picks * 2) throw new Error(`${file} needs at least ${picks * 2} draftable entries`);
  return { id, format, budget, picks, source: text(manifest.source), mons };
}

export function describeBoardMon(mon: DraftBoardMon, psDir = defaultPsDir(), format?: string): DraftBoardMonView {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(format ? Dex.formats.get(format).mod || 'base' : 'champions');
  const species = dex.species.get(mon.forme ?? mon.species);
  return {
    id: mon.id,
    name: mon.name,
    spriteId: species.spriteid,
    cost: mon.cost,
    types: mon.types,
    item: mon.item ?? '',
    abilities: Object.values(species.abilities ?? {}).filter(Boolean) as string[],
    baseStats: species.baseStats as unknown as Record<string, number>,
    origin: mon.origin,
    anchor: mon.anchor ?? '',
    usage: mon.usage ?? '',
    listed: mon.listed ?? null,
  };
}

export interface DraftState {
  board: DraftBoard;
  taken: Map<string, number>;
  rosters: DraftBoardMon[][];
  budgets: number[];
  teamNames: string[];
}

/**
 * Cheapest cost per remaining base species, ascending. A roster holds at most
 * one entry per base species, so the k cheapest of these are exactly the
 * cheapest legal way to fill k slots.
 */
function cheapestByBase(state: DraftState, drafter: number, exclude?: DraftBoardMon): number[] {
  const owned = new Set(state.rosters[drafter]!.map((mon) => mon.base));
  if (exclude) owned.add(exclude.base);
  const floor = new Map<string, number>();
  for (const mon of state.board.mons) {
    if (state.taken.has(mon.id) || owned.has(mon.base) || mon === exclude) continue;
    const current = floor.get(mon.base);
    if (current === undefined || mon.cost < current) floor.set(mon.base, mon.cost);
  }
  return [...floor.values()].sort((a, b) => a - b);
}

export function legalPicks(state: DraftState, drafter: number): DraftBoardMon[] {
  const roster = state.rosters[drafter]!;
  if (roster.length >= state.board.picks) return [];
  const owned = new Set(roster.map((mon) => mon.base));
  const slotsLeft = state.board.picks - roster.length;
  return state.board.mons.filter((mon) => {
    if (state.taken.has(mon.id) || owned.has(mon.base)) return false;
    if (mon.cost > state.budgets[drafter]!) return false;
    const rest = cheapestByBase(state, drafter, mon);
    if (rest.length < slotsLeft - 1) return false;
    const reserve = rest.slice(0, slotsLeft - 1).reduce((sum, cost) => sum + cost, 0);
    return reserve <= state.budgets[drafter]! - mon.cost;
  });
}

export function maxAffordable(legal: readonly DraftBoardMon[]): number {
  return legal.length ? Math.max(...legal.map((mon) => mon.cost)) : 0;
}

interface DraftSeatLog {
  pick: number;
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: string[];
  error?: string;
}

export interface RunDraftOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  recovery?: RecoveryGate;
  onPick?: (view: DraftPickView, state: DraftState) => void;
  makeDraftProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
}

export function snakeOrder(entrants: number, rounds: number): number[] {
  const order: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let seat = 0; seat < entrants; seat += 1) {
      order.push(round % 2 ? entrants - 1 - seat : seat);
    }
  }
  return order;
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

function boardTable(board: DraftBoard, psDir: string): string {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(board.format).mod || 'base');
  const lines: string[] = [DRAFT_PROMPT_POLICY.boardHeading];
  for (const mon of [...board.mons].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))) {
    const species = dex.species.get(mon.forme ?? mon.species);
    const stats = species.baseStats;
    const abilities = Object.values(species.abilities ?? {})
      .filter(Boolean)
      .join('/');
    lines.push(
      `- ${mon.id} | ${mon.cost} | ${mon.name} | ${mon.types.join('/')} | ` +
        `${stats.hp}/${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe} | ${abilities}` +
        (mon.item ? ` | holds ${mon.item}` : ''),
    );
  }
  return lines.join('\n');
}

function draftSystemPrompt(board: DraftBoard, models: string[], drafter: number, psDir: string): string {
  const values: Record<string, string> = {
    model: models[drafter]!,
    format: board.format,
    coaches: String(models.length),
    picks: String(board.picks),
    budget: String(board.budget),
    board: boardTable(board, psDir),
  };
  return DRAFT_PROMPT_POLICY.systemTemplate
    .map((line) =>
      Object.entries(values).reduce(
        (rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value),
        line as string,
      ),
    )
    .join('\n');
}

function draftUserPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  legal: readonly DraftBoardMon[],
): string {
  const lines: string[] = [];
  const slotsLeft = state.board.picks - state.rosters[drafter]!.length;
  const affordable = maxAffordable(legal);
  lines.push(
    DRAFT_PROMPT_POLICY.turnTemplate
      .replace('{{pick}}', String(pickNumber + 1))
      .replace('{{total}}', String(models.length * state.board.picks))
      .replace('{{budget}}', String(state.budgets[drafter]))
      .replace('{{remaining}}', `${slotsLeft} ${slotsLeft === 1 ? 'pick' : 'picks'}`)
      .replace('{{reserve}}', String(state.budgets[drafter]! - affordable))
      .replace('{{affordable}}', `${affordable} ${affordable === 1 ? 'point' : 'points'}`),
  );

  lines.push('', DRAFT_PROMPT_POLICY.takenHeading);
  const taken = [...state.taken.entries()];
  if (!taken.length) lines.push(DRAFT_PROMPT_POLICY.nothingTaken);
  for (const [index, model] of models.entries()) {
    const roster = state.rosters[index]!;
    if (!roster.length) continue;
    const label = index === drafter ? 'you' : state.teamNames[index] || model;
    lines.push(
      `- ${label}${index === drafter ? '' : ` (${model})`}: ` +
        `${roster.map((mon) => `${mon.name} (${mon.cost})`).join(', ')} — ${state.budgets[index]} points left`,
    );
  }

  lines.push('', DRAFT_PROMPT_POLICY.rosterHeading);
  lines.push(
    ...(state.rosters[drafter]!.length
      ? state.rosters[drafter]!.map(
          (mon) => `- ${mon.name} (${mon.cost}) · ${mon.types.join('/')}${mon.item ? ` · ${mon.item}` : ''}`,
        )
      : [DRAFT_PROMPT_POLICY.emptyRoster]),
  );
  lines.push(
    '',
    state.rosters[drafter]!.length ? DRAFT_PROMPT_POLICY.turnInstruction : DRAFT_PROMPT_POLICY.firstTurnInstruction,
  );
  return lines.join('\n');
}

interface ParsedPick {
  mon: DraftBoardMon;
  reasoning: string;
  teamName: string;
}

/**
 * Says which rule the pick broke. A single "not available" message conflates
 * four different causes, and models were observed retrying the same
 * unaffordable pick because the rejection never named the price.
 */
function rejection(pickId: string, legal: DraftBoardMon[], state: DraftState, drafter: number): string {
  const entry = state.board.mons.find((candidate) => candidate.id === pickId || slug(candidate.name) === pickId);
  if (!entry) return `"${pickId}" is not a board id. Copy an id exactly as it appears in the board list.`;
  const owner = state.taken.get(entry.id);
  if (owner !== undefined) {
    return `${entry.name} was already drafted by ${state.teamNames[owner] || `coach ${owner + 1}`}.`;
  }
  const clash = state.rosters[drafter]!.find((candidate) => candidate.base === entry.base);
  if (clash) {
    return `${entry.name} shares the species ${entry.base} with your ${clash.name}, and a roster holds only one of each.`;
  }
  const affordable = maxAffordable(legal);
  return (
    `${entry.name} costs ${entry.cost}, but you can spend at most ${affordable} ` +
    `${affordable === 1 ? 'point' : 'points'} on this pick and still fill your remaining slots.`
  );
}

export function parsePick(
  response: string,
  legal: DraftBoardMon[],
  state: DraftState,
  drafter: number,
): ParsedPick | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  const record = parsed as Record<string, unknown>;
  const pickId = slug(String(record.pick ?? ''));
  const mon = legal.find((candidate) => candidate.id === pickId || slug(candidate.name) === pickId);
  if (!mon) return rejection(pickId, legal, state, drafter);
  return {
    mon,
    reasoning: String(record.reasoning ?? '').trim(),
    teamName: String(record.team_name ?? '')
      .trim()
      .slice(0, 60),
  };
}

export interface DraftOutcome {
  rosters: DraftBoardMon[][];
  picks: DraftPickView[];
  budgets: number[];
  teamNames: string[];
}

export async function runDraft(models: string[], board: DraftBoard, options: RunDraftOptions): Promise<DraftOutcome> {
  const psDir = options.psDir ?? defaultPsDir();
  fs.mkdirSync(options.logDir, { recursive: true });
  const state: DraftState = {
    board,
    taken: new Map(),
    rosters: models.map(() => []),
    budgets: models.map(() => board.budget),
    teamNames: models.map(() => ''),
  };
  const providers = models.map((model) => {
    if (model === 'random') return undefined;
    const make =
      options.makeDraftProvider ??
      ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) =>
        makeProvider(parseSpec(spec), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(apiKey === undefined ? {} : { apiKey }),
        }));
    return make(model, options.apiKeys?.[model], reasoningForModel(model, options));
  });
  const reference = new ShowdownReference(board.format, psDir);
  const systemPrompts = models.map((_, drafter) => draftSystemPrompt(board, models, drafter, psDir));
  const seatLogs = models.map((model, index) => path.join(options.logDir, `drafter-${index}-${slug(model)}.jsonl`));
  const transcript = path.join(options.logDir, 'draft.jsonl');
  const picks: DraftPickView[] = [];

  const order = snakeOrder(models.length, board.picks);
  for (const [pickNumber, drafter] of order.entries()) {
    options.signal?.throwIfAborted();
    const legal = legalPicks(state, drafter);
    if (legal.length === 0) {
      throw new Error(
        `coach ${models[drafter]} has no legal pick left (budget ${state.budgets[drafter]}, board exhausted)`,
      );
    }
    let chosen: DraftBoardMon | undefined;
    let reasoning = '';
    let fallback = false;
    const provider = providers[drafter];
    if (provider) {
      const system = systemPrompts[drafter]!;
      const messages: ProviderMessage[] = [
        { role: 'user', content: draftUserPrompt(state, drafter, models, pickNumber, legal) },
      ];
      let lastError = '';
      for (let attempt = 1; attempt <= DRAFT_PROMPT_POLICY.attempts && !chosen; attempt += 1) {
        options.signal?.throwIfAborted();
        const promptForAttempt = messages[messages.length - 1]!.content ?? '';
        let response = '';
        let usage: Record<string, number> | undefined;
        let error: string | undefined;
        let terminalError: Error | undefined;
        let pauseFailure: ProviderFailure | undefined;
        const lookups: string[] = [];
        try {
          response = '';
          const completion = await completeWithDexTools({
            provider,
            system,
            messages,
            spec: models[drafter]!,
            reference,
            policy: DRAFT_PROMPT_POLICY,
            ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onLookup: (call) => lookups.push(call.name),
          });
          response = completion.text;
          usage = completion.usage;
          const truncated = completion.finishReason === 'length';
          const parsed = parsePick(response, legal, state, drafter);
          if (typeof parsed === 'string') {
            error = truncated ? `the reply used its whole token budget before naming a pick` : parsed;
            lastError = error;
            // Replaying an overrun reply spends the retry's budget on the very
            // reasoning that overran, so summarise it instead.
            messages.push({ role: 'assistant', content: truncated ? '[reply cut off before a pick]' : response });
            messages.push({
              role: 'user',
              content: truncated
                ? DRAFT_PROMPT_POLICY.truncatedTemplate.replace('{{budget}}', String(DRAFT_PROMPT_POLICY.maxTokens))
                : DRAFT_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', parsed),
            });
          } else {
            chosen = parsed.mon;
            reasoning = parsed.reasoning;
            if (parsed.teamName && !state.teamNames[drafter]) state.teamNames[drafter] = parsed.teamName;
          }
        } catch (cause) {
          const failure = classifyProviderFailure(cause, models[drafter]);
          error = failure.summary;
          lastError = error;
          if (failure.pausable && options.recovery) pauseFailure = failure;
          else terminalError = new Error(`${failure.summary} The draft cannot continue.`, { cause });
        }
        fs.appendFileSync(
          seatLogs[drafter]!,
          `${JSON.stringify({
            pick: pickNumber + 1,
            attempt,
            ...(attempt === 1 ? { system } : {}),
            user: promptForAttempt,
            response,
            ...(usage ? { usage } : {}),
            ...(lookups.length ? { tool_lookups: lookups } : {}),
            ...(error ? { error } : {}),
          } satisfies DraftSeatLog)}\n`,
          'utf8',
        );
        if (terminalError) throw terminalError;
        if (pauseFailure) {
          await options.recovery?.pause(models[drafter]!, pauseFailure.kind, pauseFailure.summary, options.signal);
          attempt -= 1;
        }
      }
      if (!chosen) {
        chosen = legal[Math.floor(options.rng() * legal.length)]!;
        reasoning = `random legal pick after ${DRAFT_PROMPT_POLICY.attempts} rejected replies (${lastError})`;
        fallback = true;
      }
    } else {
      chosen = legal[Math.floor(options.rng() * legal.length)]!;
      reasoning = 'random baseline pick';
      if (!state.teamNames[drafter]) state.teamNames[drafter] = `Random Coach ${drafter + 1}`;
    }

    state.taken.set(chosen.id, drafter);
    state.rosters[drafter]!.push(chosen);
    state.budgets[drafter]! -= chosen.cost;
    const view: DraftPickView = {
      pick: pickNumber + 1,
      entrant: drafter,
      mon: chosen.id,
      rationale: reasoning.slice(0, 600),
      fallback,
    };
    picks.push(view);
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        pick: pickNumber + 1,
        model: models[drafter],
        team_name: state.teamNames[drafter],
        mon: chosen.id,
        name: chosen.name,
        cost: chosen.cost,
        budget_left: state.budgets[drafter],
        rationale: reasoning,
        fallback,
        timestamp: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    options.onPick?.(view, state);
  }

  return { rosters: state.rosters, picks, budgets: state.budgets, teamNames: state.teamNames };
}
