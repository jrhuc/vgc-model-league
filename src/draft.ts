import fs from 'node:fs';
import path from 'node:path';

import type { BoardInfo, DraftBoardMonView, DraftPickView } from './gui/api.js';
import { BOARDS_DIR, defaultPsDir } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { makeProvider, parseSpec } from './providers.js';
import type { Rng } from './random.js';
import { loadShowdown } from './showdown.js';
import type { Provider } from './types.js';
import { text } from './value.js';

const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface DraftBoardMon {
  id: string;
  name: string;
  species: string;
  tier: string;
  cost: number;
  packed: string;
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
  return {
    id: board.id,
    format: board.format,
    monCount: board.mons.length,
    budget: board.budget,
    picks: board.picks,
    maxEntrants: Math.min(8, Math.floor((board.mons.length - board.picks) / board.picks)),
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

export function loadBoard(name: string, boardsDir = BOARDS_DIR): DraftBoard {
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
  if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(picks) || picks < 4) {
    throw new Error(`${file} needs an integer budget and at least 4 picks per entrant`);
  }
  const entries = Array.isArray(manifest.mons) ? manifest.mons : [];
  const seen = new Set<string>();
  const mons = entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    const mon: DraftBoardMon = {
      id: text(record.id),
      name: text(record.name),
      species: text(record.species),
      tier: text(record.tier),
      cost: Number(record.cost),
      packed: text(record.packed),
    };
    if (!BOARD_SLUG.test(mon.id) || !mon.name || !mon.species || !mon.packed || !Number.isInteger(mon.cost)) {
      throw new Error(`invalid board entry ${JSON.stringify(record.id)} in ${file}`);
    }
    if (seen.has(mon.id)) throw new Error(`duplicate board entry ${JSON.stringify(mon.id)} in ${file}`);
    seen.add(mon.id);
    return mon;
  });
  if (mons.length < picks * 2) throw new Error(`${file} needs at least ${picks * 2} draftable sets`);
  return { id, format, budget, picks, source: text(manifest.source), mons };
}

export function describeBoardMon(mon: DraftBoardMon, psDir = defaultPsDir()): DraftBoardMonView {
  const { Teams } = loadShowdown(psDir);
  const set = (Teams.unpack(mon.packed) ?? [])[0];
  return {
    id: mon.id,
    name: mon.name,
    tier: mon.tier,
    cost: mon.cost,
    item: set?.item ?? '',
    ability: set?.ability ?? '',
    moves: set?.moves ?? [],
    teraType: set?.teraType ?? '',
  };
}

/** Pokémon-Showdown set objects are format-defined; keep them opaque. */
type ShowdownSet = NonNullable<ReturnType<ReturnType<typeof loadShowdown>['Teams']['unpack']>>[number];

const MIN_COST = 3;

export interface DraftState {
  board: DraftBoard;
  taken: Map<string, number>;
  rosters: DraftBoardMon[][];
  budgets: number[];
}

function unpackMon(mon: DraftBoardMon, psDir: string): ShowdownSet {
  const { Teams } = loadShowdown(psDir);
  const set = (Teams.unpack(mon.packed) ?? [])[0];
  if (!set) throw new Error(`board entry ${mon.id} does not unpack`);
  return set;
}

/**
 * A pick is legal when the mon is undrafted, leaves enough budget to finish the
 * roster at minimum cost, and keeps the partial team valid under the real
 * format validator — which enforces species and item clauses exactly. Only the
 * team-size complaint is ignored while the roster is short.
 */
export function legalPicks(state: DraftState, drafter: number, psDir = defaultPsDir()): DraftBoardMon[] {
  const { TeamValidator } = loadShowdown(psDir);
  const validator = new TeamValidator(state.board.format);
  const roster = state.rosters[drafter]!;
  const picksLeft = state.board.picks - roster.length;
  const budget = state.budgets[drafter]!;
  const rosterSets = roster.map((mon) => unpackMon(mon, psDir));
  return state.board.mons.filter((mon) => {
    if (state.taken.has(mon.id)) return false;
    if (mon.cost > budget - MIN_COST * (picksLeft - 1)) return false;
    const problems: string[] = validator.validateTeam([...rosterSets, unpackMon(mon, psDir)]) ?? [];
    return problems.every((problem) => /must bring at least/i.test(problem));
  });
}

export interface DraftSeatLog {
  pick: number;
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  error?: string;
}

export interface RunDraftOptions {
  psDir?: string;
  reasoning?: ReasoningLevel;
  apiKeys?: Readonly<Record<string, string>>;
  /** Per-drafter prompt/response logs and the shared draft transcript land here. */
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  onPick?: (view: DraftPickView, state: DraftState) => void;
  /** Test seam; defaults to real provider construction. */
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

function draftSystemPrompt(board: DraftBoard, models: string[], drafter: number): string {
  return [
    `You are ${models[drafter]}, drafting a roster for a Pokémon VGC draft league in the format ${board.format}.`,
    `League rules: ${models.length} coaches snake-draft ${board.picks} Pokémon each from a shared board.`,
    'Every set is fixed (moves, item, ability, EVs cannot be changed). A drafted Pokémon is exclusive to its coach.',
    `Each coach has ${board.budget} points; higher-tier Pokémon cost more. You must be able to afford ${board.picks} picks in total.`,
    'Item Clause applies: you cannot draft two Pokémon holding the same item.',
    'After the draft you keep this roster for a round robin of best-of-three matches, then playoffs. Games are 4v4 doubles picked from your 6.',
    'Draft for a coherent team: consider synergy, speed control, mode coverage, and what opponents have already taken.',
    'Reply with a single JSON object: {"pick": "<board-id>", "reasoning": "<2-4 sentences on why>"} and nothing else.',
  ].join('\n');
}

function describeSet(mon: DraftBoardMon, psDir: string): string {
  const set = unpackMon(mon, psDir);
  const evs = set.evs
    ? Object.entries(set.evs)
        .filter(([, value]) => Number(value) > 0)
        .map(([stat, value]) => `${value} ${stat}`)
        .join('/')
    : '';
  const parts = [
    `@ ${set.item || 'no item'}`,
    set.ability,
    set.teraType ? `Tera ${set.teraType}` : '',
    (set.moves ?? []).join(' / '),
    evs ? `EVs ${evs}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function draftUserPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  psDir: string,
): string {
  const legal = new Set(legalPicks(state, drafter, psDir).map((mon) => mon.id));
  const lines: string[] = [];
  lines.push(
    `Overall pick ${pickNumber + 1}. You have ${state.budgets[drafter]} points left and ${
      state.board.picks - state.rosters[drafter]!.length
    } picks remaining (minimum cost per pick is ${MIN_COST}).`,
  );
  lines.push('', 'BOARD (id | tier | cost | set):');
  for (const mon of state.board.mons) {
    const owner = state.taken.get(mon.id);
    const status =
      owner === undefined ? (legal.has(mon.id) ? 'available' : 'unavailable to you') : `taken by ${models[owner]}`;
    lines.push(`- ${mon.id} | ${mon.tier} | ${mon.cost} | ${describeSet(mon, psDir)} [${status}]`);
  }
  lines.push('', 'YOUR ROSTER:');
  lines.push(
    ...(state.rosters[drafter]!.length
      ? state.rosters[drafter]!.map((mon) => `- ${mon.name} (${mon.cost}) · ${describeSet(mon, psDir)}`)
      : ['- (empty)']),
  );
  for (const [index, model] of models.entries()) {
    if (index === drafter) continue;
    lines.push(
      '',
      `${model.toUpperCase()} ROSTER: ${
        state.rosters[index]!.length
          ? state.rosters[index]!.map((mon) => `${mon.name} (${mon.tier})`).join(', ')
          : '(empty)'
      }`,
    );
  }
  lines.push('', 'Choose one Pokémon marked [available]. Reply with only the JSON object.');
  return lines.join('\n');
}

function parsePick(response: string, legal: DraftBoardMon[]): { mon: DraftBoardMon; reasoning: string } | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  const record = parsed as Record<string, unknown>;
  const pickId = String(record.pick ?? '')
    .trim()
    .toLowerCase();
  const mon = legal.find((candidate) => candidate.id === pickId);
  if (!mon) return `"${pickId}" is not an available board id`;
  return { mon, reasoning: String(record.reasoning ?? '').trim() };
}

export interface DraftOutcome {
  rosters: DraftBoardMon[][];
  picks: DraftPickView[];
  budgets: number[];
}

export async function runDraft(models: string[], board: DraftBoard, options: RunDraftOptions): Promise<DraftOutcome> {
  const psDir = options.psDir ?? defaultPsDir();
  fs.mkdirSync(options.logDir, { recursive: true });
  const state: DraftState = {
    board,
    taken: new Map(),
    rosters: models.map(() => []),
    budgets: models.map(() => board.budget),
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
    return make(model, options.apiKeys?.[model], options.reasoning);
  });
  const seatLogs = models.map((model, index) => path.join(options.logDir, `drafter-${index}-${slug(model)}.jsonl`));
  const transcript = path.join(options.logDir, 'draft.jsonl');
  const picks: DraftPickView[] = [];

  const order = snakeOrder(models.length, board.picks);
  for (const [pickNumber, drafter] of order.entries()) {
    options.signal?.throwIfAborted();
    const legal = legalPicks(state, drafter, psDir);
    if (legal.length === 0) {
      throw new Error(
        `drafter ${models[drafter]} has no legal pick left (budget ${state.budgets[drafter]}, board exhausted by clauses)`,
      );
    }
    let chosen: DraftBoardMon | undefined;
    let reasoning = '';
    let fallback = false;
    const provider = providers[drafter];
    if (provider) {
      const system = draftSystemPrompt(board, models, drafter);
      const messages: Array<{ role: 'user'; content: string }> = [
        { role: 'user', content: draftUserPrompt(state, drafter, models, pickNumber, psDir) },
      ];
      let lastError = '';
      for (let attempt = 1; attempt <= 3 && !chosen; attempt += 1) {
        options.signal?.throwIfAborted();
        const promptForAttempt = messages[messages.length - 1]!.content;
        let response = '';
        let usage: Record<string, number> | undefined;
        let error: string | undefined;
        try {
          const completion = await provider.complete(system, messages, {
            maxTokens: 8192,
            timeout: 240,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          response = completion.text;
          usage = completion.usage;
          const parsed = parsePick(response, legal);
          if (typeof parsed === 'string') {
            error = parsed;
            lastError = parsed;
            messages.push({
              role: 'user',
              content: `That pick was rejected: ${parsed}. Reply again with only the JSON object.`,
            });
          } else {
            chosen = parsed.mon;
            reasoning = parsed.reasoning;
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          lastError = error;
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
            ...(error ? { error } : {}),
          } satisfies DraftSeatLog)}\n`,
          'utf8',
        );
      }
      if (!chosen) {
        chosen = legal[Math.floor(options.rng() * legal.length)]!;
        reasoning = `fallback pick after failed attempts (${lastError})`;
        fallback = true;
      }
    } else {
      chosen = legal[Math.floor(options.rng() * legal.length)]!;
      reasoning = 'random baseline pick';
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
        mon: chosen.id,
        name: chosen.name,
        tier: chosen.tier,
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

  return { rosters: state.rosters, picks, budgets: state.budgets };
}
