import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { boardRow, createBoardSearch } from './board-search.js';
import { completeWithDexTools } from './dex-lookups.js';
import type { BoardInfo, DraftBoardMonView, DraftPickView } from './gui/api.js';
import { BOARDS_DIR, defaultPsDir } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
  resolveSpecOverride,
} from './providers.js';
import type { Rng } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import { loadShowdown } from './showdown.js';
import { evidenceSuppliedRecord, normalizeStageEvidence, type StageEvidence } from './stage-evidence.js';
import type { JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';
import { clip, text } from './value.js';

const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DRAFT_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}.',
    '',
    'LEAGUE RULES',
    '- {{coaches}} coaches snake-draft {{picks}} Pokémon each from the shared board below.',
    '- Every coach has {{budget}} points. A Pokémon drafted by one coach is gone for everyone else.',
    '- You may not draft two entries that share a base species, so Charizard and Mega Charizard Y are alternatives, not a pair.',
    '- A Mega entry plays as its base forme holding its Mega Stone, with the option to Mega Evolve during a game;',
    '  drafting the base forme instead means it can hold any item but never a Mega Stone. The board lists both, priced differently.',
    '- If you bring more than one Mega entry to a match, which of them evolves is a choice you make in play, game by game.',
    '{{rosterPolicy}}',
    '- Before each match you choose 6 of your {{picks}} and build every set yourself: item, ability, nature, moves, and EVs.',
    '  Nothing about a set is fixed by the draft.',
    '- Games are 4-of-6 doubles. You will see your opponent’s full roster before you build, and they will see yours.',
    '',
    'You have the Showdown dex tools. Use them to check anything the board summary does not answer: what a Mega',
    'becomes, how a type matchup reads, what a spread outruns, or roughly how hard an attack hits. They compute',
    'from the simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;',
    'a hypothetical damage result does not imply omitted abilities or field effects. search_board filters and re-sorts the',
    'board itself by type, price, ability, base stat total, or which entries legally learn a given move.',
    '',
    'Your roster is judged matchup by matchup: over the season it needs a winning 6 against each of the other',
    'rosters taking shape around you.',
    '',
    '{{board}}',
  ],
  turnInstruction:
    'Reply with one JSON object containing {"pick":"<board-id>"}. Optional evidence fields are "reasoning":"<concise reason>" and, only when your durable plan changed, "notebook":"<complete replacement notes for later picks>".',
  turnTemplate:
    'Overall pick {{pick}} of {{total}}. You have {{budget}} points and {{remaining}} left, and every remaining ' +
    'slot has to be filled from what is still on the board.',
  boardHeading: 'DRAFT BOARD (id | cost | name | types | base stats | abilities):',
  boardOrder: 'cost-descending' as 'cost-descending' | 'name',
  takenHeading: 'ALREADY DRAFTED:',
  nothingTaken: '- (nothing yet; you have the first pick)',
  rosterHeading: 'YOUR ROSTER:',
  notebookHeading: 'YOUR PRIVATE DRAFT NOTE FROM YOUR PREVIOUS PICK:',
  emptyRoster: '- (empty)',
  rejectionTemplate: 'That pick was rejected: {{error}}. Reply again with only the JSON object.',
  fallbackNote:
    'Harness note: every reply for pick {{pick}} was rejected (last reason: {{error}}), so a random legal pick was ' +
    'made for you — {{mon}} is now on your roster. Your note above predates that pick.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before naming a pick. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.',
  notebookLimit: 4_000,
  rationaleLimit: 2_000,
  maxTokens: 65_536,
  timeoutSeconds: 3600,
  attempts: 3,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 8,
  maxCallsPerRound: 6,
} as const;

const FRANCHISE_NAME_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}. The competitive draft is complete.',
    'Choose a concise, playful franchise name for the spectator-facing league display based on your finished roster.',
    "Wordplay and personality are welcome. The Shadow Cabinet, Prankster's Paradise, and Drought Dodgers are examples of the tone, not names to copy.",
    'The name is presentation only: coaches never see franchise names during competitive decisions.',
    'Reply with exactly one JSON object {"team_name":"<your franchise name>"} and nothing else.',
  ],
  rosterHeading: 'YOUR COMPLETED ROSTER:',
  rejectionTemplate: 'That name was rejected: {{error}} Reply again with only the JSON object.',
  maxTokens: 4_096,
  timeoutSeconds: 240,
  attempts: 3,
  nameLimit: 60,
} as const;

export function draftScaffoldRevision(): string {
  return createHash('sha256')
    .update(JSON.stringify({ draft: DRAFT_PROMPT_POLICY, naming: FRANCHISE_NAME_PROMPT_POLICY }))
    .digest('hex')
    .slice(0, 12);
}

export interface DraftBoardMon {
  id: string;
  name: string;
  species: string;
  forme?: string;
  item?: string;
  base: string;
  types: string[];
  cost: number;
  origin: 'base' | 'regmb';
  anchor?: string;
  usage?: string;
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

function cheapestCostsByBase(mons: readonly DraftBoardMon[]): number[] {
  const costs = new Map<string, number>();
  for (const mon of mons) {
    const current = costs.get(mon.base);
    if (current === undefined || mon.cost < current) costs.set(mon.base, mon.cost);
  }
  return [...costs.values()].sort((a, b) => a - b);
}

export function boardInfo(board: DraftBoard): BoardInfo {
  const cheapest = cheapestCostsByBase(board.mons);
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
  const resolvedFormat = Dex.formats.get(format);
  if (!resolvedFormat.exists) throw new Error(`${file} names an unknown format`);
  const dex = Dex.mod(resolvedFormat.mod || 'base');
  const entries = Array.isArray(manifest.mons) ? manifest.mons : [];
  const seen = new Set<string>();
  const mons = entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid board entry in ${file}`);
    }
    const record = entry as Record<string, unknown>;
    const origin = text(record.origin);
    if (origin !== 'base' && origin !== 'regmb') {
      throw new Error(`board entry ${JSON.stringify(record.id)} in ${file} needs a valid origin`);
    }
    const mon: DraftBoardMon = {
      id: text(record.id),
      name: text(record.name),
      species: text(record.species),
      ...(record.forme ? { forme: text(record.forme) } : {}),
      ...(record.item ? { item: text(record.item) } : {}),
      base: text(record.base),
      types: Array.isArray(record.types) ? record.types.map((type) => String(type)) : [],
      cost: Number(record.cost),
      origin,
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
    if (mon.base !== species.baseSpecies) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} has the wrong base species`);
    }
    if (Boolean(mon.forme) !== Boolean(mon.item)) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} needs both a Mega forme and stone`);
    }
    if (mon.item) {
      const item = dex.items.get(mon.item);
      const megaStone = item.megaStone;
      const target = typeof megaStone === 'string' ? megaStone : megaStone?.[species.name];
      if (!item.exists || target !== mon.forme) {
        throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} has an invalid Mega forme or stone`);
      }
    }
    const battleForme = dex.species.get(mon.forme ?? mon.species);
    if (
      !battleForme.exists ||
      mon.types.length !== battleForme.types.length ||
      mon.types.some((type, index) => type !== battleForme.types[index])
    ) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} has invalid battle types`);
    }
    if (
      (mon.usage === undefined) !== (mon.listed === undefined) ||
      (mon.listed !== undefined && (!Number.isInteger(mon.listed) || mon.listed < 1))
    ) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} has invalid repricing metadata`);
    }
    if (seen.has(mon.id)) throw new Error(`duplicate board entry ${JSON.stringify(mon.id)} in ${file}`);
    seen.add(mon.id);
    return mon;
  });
  if (mons.length < picks * 2) throw new Error(`${file} needs at least ${picks * 2} draftable entries`);
  const cheapest = cheapestCostsByBase(mons).slice(0, picks);
  if (cheapest.length < picks || cheapest.reduce((sum, cost) => sum + cost, 0) > budget) {
    throw new Error(`${file} needs a budget that can afford one ${picks}-Pokémon roster`);
  }
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
  };
}

export interface DraftState {
  board: DraftBoard;
  taken: Map<string, number>;
  rosters: DraftBoardMon[][];
  budgets: number[];
  teamNames: string[];
}

function cheapestByBase(state: DraftState, drafter: number, exclude?: DraftBoardMon): number[] {
  const owned = new Set(state.rosters[drafter]!.map((mon) => mon.base));
  if (exclude) owned.add(exclude.base);
  const floor = new Map<string, number>();
  for (const mon of state.board.mons) {
    if (state.taken.has(mon.id) || owned.has(mon.base)) continue;
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
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

interface FranchiseNameSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  error?: string;
}

export interface RunDraftOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  recovery?: RecoveryGate;
  rosterPolicy?: string;
  onPick?: (view: DraftPickView, state: DraftState) => void;
  onName?: (entrant: number, teamName: string, state: DraftState) => void;
  makeDraftProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
}

function replayTranscript(
  file: string,
  state: DraftState,
  context: {
    models: string[];
    board: DraftBoard;
    order: number[];
    picks: DraftPickView[];
    notebooks: string[];
    onPick?: (view: DraftPickView, state: DraftState) => void;
  },
): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const rows = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const [index, row] of rows.entries()) {
    const drafter = context.order[index];
    if (drafter === undefined) throw new Error(`${file} holds more picks than the draft has slots`);
    if (row.model !== context.models[drafter]) {
      throw new Error(`${file} pick ${index + 1} belongs to ${String(row.model)}, expected ${context.models[drafter]}`);
    }
    const mon = context.board.mons.find((entry) => entry.id === row.mon);
    if (!mon) {
      throw new Error(
        `${file} pick ${index + 1} drafted ${String(row.mon)}, which board ${context.board.id} does not hold`,
      );
    }
    if (state.taken.has(mon.id)) throw new Error(`${file} pick ${index + 1} drafted ${mon.id} twice`);
    state.taken.set(mon.id, drafter);
    state.rosters[drafter]!.push(mon);
    state.budgets[drafter]! -= mon.cost;
    if (typeof row.budget_left === 'number' && row.budget_left !== state.budgets[drafter]) {
      throw new Error(
        `${file} pick ${index + 1} leaves ${state.budgets[drafter]} points, but the transcript recorded ${row.budget_left}`,
      );
    }
    if (typeof row.team_name === 'string' && row.team_name && !state.teamNames[drafter])
      state.teamNames[drafter] = row.team_name;
    if (typeof row.notebook === 'string') context.notebooks[drafter] = row.notebook;
    const view: DraftPickView = {
      pick: index + 1,
      entrant: drafter,
      mon: mon.id,
      rationale: typeof row.rationale === 'string' ? clip(row.rationale, DRAFT_PROMPT_POLICY.rationaleLimit) : '',
      fallback: row.fallback === true,
    };
    context.picks.push(view);
    context.onPick?.(view, state);
  }
  return rows.length;
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

export function draftBoardTable(
  board: DraftBoard,
  psDir: string,
  mons: readonly DraftBoardMon[] = board.mons,
  heading: string = DRAFT_PROMPT_POLICY.boardHeading,
): string {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(board.format).mod || 'base');
  const lines: string[] = [heading];
  const order =
    DRAFT_PROMPT_POLICY.boardOrder === 'name'
      ? (a: DraftBoardMon, b: DraftBoardMon) => a.name.localeCompare(b.name)
      : (a: DraftBoardMon, b: DraftBoardMon) => b.cost - a.cost || a.name.localeCompare(b.name);
  for (const mon of [...mons].sort(order)) {
    lines.push(boardRow(mon, dex));
  }
  return lines.join('\n');
}

function draftSystemPrompt(
  board: DraftBoard,
  models: string[],
  drafter: number,
  psDir: string,
  rosterPolicy: string,
): string {
  const values: Record<string, string> = {
    model: models[drafter]!,
    format: board.format,
    coaches: String(models.length),
    picks: String(board.picks),
    budget: String(board.budget),
    board: draftBoardTable(board, psDir),
    rosterPolicy,
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

export function draftUserPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  notebook: string,
): string {
  const lines: string[] = [];
  const slotsLeft = state.board.picks - state.rosters[drafter]!.length;

  lines.push(DRAFT_PROMPT_POLICY.takenHeading);
  const taken = [...state.taken.entries()];
  if (!taken.length) lines.push(DRAFT_PROMPT_POLICY.nothingTaken);
  for (const [index, model] of models.entries()) {
    const roster = state.rosters[index]!;
    if (!roster.length) continue;
    const label = index === drafter ? 'you' : model;
    const budget = `${state.budgets[index]} points left`;
    lines.push(`- ${label} (${budget}): ${roster.map((mon) => `${mon.name} (${mon.cost})`).join(', ')}`);
  }

  lines.push('', DRAFT_PROMPT_POLICY.rosterHeading);
  lines.push(
    ...(state.rosters[drafter]!.length
      ? state.rosters[drafter]!.map(
          (mon) => `- ${mon.name} (${mon.cost}) · ${mon.types.join('/')}${mon.item ? ` · ${mon.item}` : ''}`,
        )
      : [DRAFT_PROMPT_POLICY.emptyRoster]),
  );
  if (notebook) lines.push('', DRAFT_PROMPT_POLICY.notebookHeading, notebook);
  lines.push(
    '',
    DRAFT_PROMPT_POLICY.turnTemplate
      .replace('{{pick}}', String(pickNumber + 1))
      .replace('{{total}}', String(models.length * state.board.picks))
      .replace('{{budget}}', String(state.budgets[drafter]))
      .replace('{{remaining}}', `${slotsLeft} ${slotsLeft === 1 ? 'pick' : 'picks'}`),
  );
  lines.push('', DRAFT_PROMPT_POLICY.turnInstruction);
  return lines.join('\n');
}

interface ParsedPick {
  mon: DraftBoardMon;
  reasoning: string;
  notebook?: string;
  evidence: StageEvidence;
}

function rejection(
  pickId: string,
  legal: DraftBoardMon[],
  state: DraftState,
  drafter: number,
  models?: readonly string[],
): string {
  const entry = state.board.mons.find((candidate) => candidate.id === pickId || slug(candidate.name) === pickId);
  if (!entry) return `"${pickId}" is not a board id. Copy an id exactly as it appears in the board list.`;
  const owner = state.taken.get(entry.id);
  if (owner !== undefined) {
    return `${entry.name} was already drafted by ${models?.[owner] || `coach ${owner + 1}`}.`;
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
  models?: readonly string[],
  currentNotebook = '',
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
  if (!mon) return rejection(pickId, legal, state, drafter, models);
  const evidence = normalizeStageEvidence(record.reasoning, record.notebook, {
    currentNotebook,
    rationaleLimit: DRAFT_PROMPT_POLICY.rationaleLimit,
    notebookLimit: DRAFT_PROMPT_POLICY.notebookLimit,
  });
  return {
    mon,
    reasoning: evidence.rationale,
    ...(evidence.supplied.notebookUpdate ? { notebook: evidence.notebook } : {}),
    evidence,
  };
}

interface ParsedFranchiseName {
  teamName: string;
}

export function parseFranchiseName(response: string): ParsedFranchiseName | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the reply must be one JSON object';
  }
  const value = (parsed as Record<string, unknown>).team_name;
  if (typeof value !== 'string') return '"team_name" must be a non-empty string';
  const teamName = value.trim().replace(/\s+/g, ' ').slice(0, FRANCHISE_NAME_PROMPT_POLICY.nameLimit);
  return teamName ? { teamName } : '"team_name" must be a non-empty string';
}

function franchiseNameSystemPrompt(model: string): string {
  return FRANCHISE_NAME_PROMPT_POLICY.systemTemplate.map((line) => line.replace('{{model}}', model)).join('\n');
}

function franchiseNameUserPrompt(roster: readonly DraftBoardMon[]): string {
  return [
    FRANCHISE_NAME_PROMPT_POLICY.rosterHeading,
    ...roster.map((mon) => `- ${mon.name}${mon.item ? ` (${mon.item})` : ''}`),
  ].join('\n');
}

function replayFranchiseNames(file: string, models: readonly string[], state: DraftState): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const entrant = Number(row.entrant);
    if (!Number.isInteger(entrant) || entrant < 0 || entrant >= models.length) {
      throw new Error(`${file} holds an invalid franchise-name entrant`);
    }
    if (row.model !== models[entrant]) {
      throw new Error(`${file} names ${String(row.model)} for entrant ${entrant}, expected ${models[entrant]}`);
    }
    const parsed = parseFranchiseName(JSON.stringify({ team_name: row.team_name }));
    if (typeof parsed === 'string') throw new Error(`${file} holds an invalid franchise name for entrant ${entrant}`);
    if (state.teamNames[entrant] && state.teamNames[entrant] !== parsed.teamName) {
      throw new Error(`${file} conflicts with the draft transcript for entrant ${entrant}`);
    }
    state.teamNames[entrant] = parsed.teamName;
  }
}

async function nameFranchises(
  models: string[],
  providers: Array<Provider | undefined>,
  state: DraftState,
  options: RunDraftOptions,
): Promise<void> {
  const transcript = path.join(options.logDir, 'franchise-names.jsonl');
  replayFranchiseNames(transcript, models, state);
  await Promise.all(
    models.map(async (model, entrant) => {
      if (state.teamNames[entrant]) {
        options.onName?.(entrant, state.teamNames[entrant]!, state);
        return;
      }
      const provider = providers[entrant];
      const fallbackName = model === 'random' ? `Random Coach ${entrant + 1}` : `Coach ${entrant + 1}`;
      let teamName = '';
      let fallback = false;
      if (provider) {
        const system = franchiseNameSystemPrompt(model);
        const messages: ProviderMessage[] = [
          { role: 'user', content: franchiseNameUserPrompt(state.rosters[entrant]!) },
        ];
        const seatLog = path.join(options.logDir, `namer-${entrant}-${slug(model)}.jsonl`);
        for (let attempt = 1; attempt <= FRANCHISE_NAME_PROMPT_POLICY.attempts && !teamName; attempt += 1) {
          options.signal?.throwIfAborted();
          const user = messages[messages.length - 1]!.content ?? '';
          let response = '';
          let usage: Record<string, number> | undefined;
          let error: string | undefined;
          try {
            const completion = await provider.complete(system, messages, {
              maxTokens: FRANCHISE_NAME_PROMPT_POLICY.maxTokens,
              timeout: FRANCHISE_NAME_PROMPT_POLICY.timeoutSeconds,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            response = completion.text;
            usage = completion.usage;
            const parsed = parseFranchiseName(response);
            if (typeof parsed === 'string') {
              error = parsed;
              messages.push({ role: 'assistant', content: response || '[the reply contained no visible text]' });
              messages.push({
                role: 'user',
                content: FRANCHISE_NAME_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', parsed),
              });
            } else teamName = parsed.teamName;
          } catch (cause) {
            if (options.signal?.aborted) throw cause;
            error = classifyProviderFailure(cause, model).summary;
            fallback = true;
          }
          fs.appendFileSync(
            seatLog,
            `${JSON.stringify({
              attempt,
              ...(attempt === 1 ? { system } : {}),
              user,
              response,
              ...(usage ? { usage } : {}),
              ...(error ? { error } : {}),
            } satisfies FranchiseNameSeatLog)}\n`,
            'utf8',
          );
          if (fallback) break;
        }
      }
      if (!teamName) {
        teamName = fallbackName;
        fallback = true;
      }
      state.teamNames[entrant] = teamName;
      fs.appendFileSync(
        transcript,
        `${JSON.stringify({
          entrant,
          model,
          team_name: teamName,
          fallback,
          timestamp: new Date().toISOString(),
        })}\n`,
        'utf8',
      );
      options.onName?.(entrant, teamName, state);
    }),
  );
}

export interface DraftOutcome {
  rosters: DraftBoardMon[][];
  picks: DraftPickView[];
  budgets: number[];
  teamNames: string[];
  notebooks: string[];
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
      ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => {
        const resolved = resolveSpecOverride(spec);
        return makeProvider(parseSpec(resolved), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(resolved === spec && apiKey !== undefined ? { apiKey } : {}),
        });
      });
    return make(model, options.apiKeys?.[model], reasoningForModel(model, options));
  });
  const reference = new ShowdownReference(board.format, psDir);
  const boardSearch = createBoardSearch(board, psDir);
  const rosterPolicy =
    options.rosterPolicy ??
    '- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.';
  const systemPrompts = models.map((_, drafter) => draftSystemPrompt(board, models, drafter, psDir, rosterPolicy));
  const seatLogs = models.map((model, index) => path.join(options.logDir, `drafter-${index}-${slug(model)}.jsonl`));
  const transcript = path.join(options.logDir, 'draft.jsonl');
  const picks: DraftPickView[] = [];
  const notebooks = models.map(() => '');

  const order = snakeOrder(models.length, board.picks);
  const replayed = replayTranscript(transcript, state, {
    models,
    board,
    order,
    picks,
    notebooks,
    ...(options.onPick ? { onPick: options.onPick } : {}),
  });
  for (const [pickNumber, drafter] of order.entries()) {
    if (pickNumber < replayed) continue;
    options.signal?.throwIfAborted();
    const legal = legalPicks(state, drafter);
    if (legal.length === 0) {
      throw new Error(
        `coach ${models[drafter]} has no legal pick left (budget ${state.budgets[drafter]}, board exhausted)`,
      );
    }
    let chosen: DraftBoardMon | undefined;
    let reasoning = '';
    let evidence: StageEvidence = {
      rationale: '',
      notebook: notebooks[drafter]!,
      supplied: { rationale: false, notebookUpdate: false },
    };
    let fallback = false;
    const provider = providers[drafter];
    if (provider) {
      const system = systemPrompts[drafter]!;
      const messages: ProviderMessage[] = [
        { role: 'user', content: draftUserPrompt(state, drafter, models, pickNumber, notebooks[drafter]!) },
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
        const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
        try {
          response = '';
          const completion = await completeWithDexTools({
            provider,
            system,
            messages,
            spec: models[drafter]!,
            reference,
            boardSearch,
            policy: DRAFT_PROMPT_POLICY,
            ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onLookup: (call) => lookups.push(call),
          });
          response = completion.text;
          usage = completion.usage;
          const truncated = completion.finishReason === 'length';
          if (!response.trim() && !truncated && completion.reasoning) {
            const salvaged = parsePick(completion.reasoning, legal, state, drafter, models, notebooks[drafter]!);
            if (typeof salvaged !== 'string') response = completion.reasoning;
          }
          const parsed = parsePick(response, legal, state, drafter, models, notebooks[drafter]!);
          if (typeof parsed === 'string') {
            error = truncated ? `the reply used its whole token budget before naming a pick` : parsed;
            lastError = error;
            messages.push({
              role: 'assistant',
              content: truncated
                ? '[reply cut off before a pick]'
                : response || '[the reply contained no visible text]',
            });
            messages.push({
              role: 'user',
              content: truncated
                ? DRAFT_PROMPT_POLICY.truncatedTemplate.replace('{{budget}}', String(DRAFT_PROMPT_POLICY.maxTokens))
                : DRAFT_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', parsed),
            });
          } else {
            chosen = parsed.mon;
            reasoning = parsed.reasoning;
            evidence = parsed.evidence;
            notebooks[drafter] = evidence.notebook;
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
          await options.recovery?.pause(models[drafter]!, pauseFailure, options.signal);
          attempt -= 1;
        }
      }
      if (!chosen) {
        chosen = legal[Math.floor(options.rng() * legal.length)]!;
        reasoning = `random legal pick after ${DRAFT_PROMPT_POLICY.attempts} rejected replies (${lastError})`;
        fallback = true;
        const note = DRAFT_PROMPT_POLICY.fallbackNote
          .replace('{{pick}}', String(pickNumber + 1))
          .replace('{{error}}', lastError || 'no usable reply')
          .replace('{{mon}}', `${chosen.name} (${chosen.cost})`);
        const room = DRAFT_PROMPT_POLICY.notebookLimit - note.length - 1;
        notebooks[drafter] = `${clip(notebooks[drafter]!, Math.max(0, room))}\n${note}`.trim();
        evidence = {
          rationale: reasoning,
          notebook: notebooks[drafter]!,
          supplied: { rationale: false, notebookUpdate: false },
        };
      }
    } else {
      chosen = legal[Math.floor(options.rng() * legal.length)]!;
      reasoning = 'random baseline pick';
      evidence = {
        rationale: reasoning,
        notebook: notebooks[drafter]!,
        supplied: { rationale: false, notebookUpdate: false },
      };
    }

    state.taken.set(chosen.id, drafter);
    state.rosters[drafter]!.push(chosen);
    state.budgets[drafter]! -= chosen.cost;
    const view: DraftPickView = {
      pick: pickNumber + 1,
      entrant: drafter,
      mon: chosen.id,
      rationale: clip(reasoning, DRAFT_PROMPT_POLICY.rationaleLimit),
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
        cost: chosen.cost,
        budget_left: state.budgets[drafter],
        action: { pick: chosen.id },
        rationale: reasoning,
        evidence_supplied: evidenceSuppliedRecord(evidence),
        ...(evidence.supplied.notebookUpdate || notebooks[drafter] ? { notebook: notebooks[drafter] } : {}),
        fallback,
        timestamp: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
    options.onPick?.(view, state);
  }

  await nameFranchises(models, providers, state, options);

  return { rosters: state.rosters, picks, budgets: state.budgets, teamNames: state.teamNames, notebooks };
}
