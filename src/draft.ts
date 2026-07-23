import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BoardInfo, DraftBoardMonView, DraftPickView } from './gui/api.js';
import { BOARDS_DIR, defaultPsDir } from './paths.js';
import type { ModelReasoningConfig, ProviderFailure, ReasoningLevel } from './providers.js';
import { classifyProviderFailure, makeProvider, parseSpec, reasoningForModel } from './providers.js';
import type { Rng } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { loadShowdown } from './showdown.js';
import type { Provider, ProviderMessage } from './types.js';
import { text } from './value.js';

const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DRAFT_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, drafting a roster for a Pokémon VGC draft league in the format {{format}}.',
    'League rules: {{coaches}} coaches snake-draft {{picks}} Pokémon each from a shared board.',
    'Every set is fixed (moves, item, ability, EVs cannot be changed). A drafted Pokémon is exclusive to its coach.',
    'Each coach has {{budget}} points; higher-tier Pokémon cost more. You must be able to afford {{picks}} picks in total.',
    'Item Clause applies: you cannot draft two Pokémon holding the same item.',
    'After the draft you keep this roster for a round robin of best-of-three matches, then playoffs. Games are 4v4 doubles picked from your {{picks}}.',
    'Draft for a coherent team: consider synergy, speed control, mode coverage, and what opponents have already taken.',
    'Reply with a single JSON object: {"pick": "<board-id>", "reasoning": "<2-4 sentences on why>"} and nothing else.',
  ],
  turnTemplate:
    'Overall pick {{pick}}. You have {{budget}} points left and {{remaining}} picks remaining; every choice must leave enough budget to complete the roster.',
  boardHeading: 'BOARD (id | tier | cost | set):',
  rosterHeading: 'YOUR ROSTER:',
  emptyRoster: '- (empty)',
  availableStatus: 'available',
  unavailableStatus: 'unavailable to you',
  takenTemplate: 'taken by {{model}}',
  pickInstruction: 'Choose one Pokémon marked [available]. Reply with only the JSON object.',
  rejectionTemplate: 'That pick was rejected: {{error}}. Reply again with only the JSON object.',
  maxTokens: 8192,
  timeoutSeconds: 240,
  attempts: 3,
  fallback: 'uniform-random-legal',
} as const;

export function draftScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(DRAFT_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

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
  const entries = Array.isArray(manifest.mons) ? manifest.mons : [];
  const seen = new Set<string>();
  const { Teams } = loadShowdown(psDir);
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
    if (
      !BOARD_SLUG.test(mon.id) ||
      !mon.name ||
      !mon.species ||
      !mon.packed ||
      !Number.isInteger(mon.cost) ||
      mon.cost < 1
    ) {
      throw new Error(`invalid board entry ${JSON.stringify(record.id)} in ${file}`);
    }
    if ((Teams.unpack(mon.packed) ?? []).length !== 1) {
      throw new Error(`board entry ${JSON.stringify(mon.id)} in ${file} must contain exactly one packed set`);
    }
    if (seen.has(mon.id)) throw new Error(`duplicate board entry ${JSON.stringify(mon.id)} in ${file}`);
    seen.add(mon.id);
    return mon;
  });
  if (mons.length < picks * 2) throw new Error(`${file} needs at least ${picks * 2} draftable sets`);
  const minimumRosterCost = mons
    .map((mon) => mon.cost)
    .sort((a, b) => a - b)
    .slice(0, picks)
    .reduce((sum, cost) => sum + cost, 0);
  if (minimumRosterCost > budget) {
    throw new Error(`${file} needs a budget that can afford at least one ${picks}-Pokémon roster`);
  }
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

type ShowdownSet = NonNullable<ReturnType<ReturnType<typeof loadShowdown>['Teams']['unpack']>>[number];
type ShowdownValidator = { validateTeam(team: ShowdownSet[]): string[] | null };

interface DraftCandidate {
  index: number;
  mon: DraftBoardMon;
  set: ShowdownSet;
  species: string;
  item: string;
}

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

function canCompleteDraft(
  validator: ShowdownValidator,
  rosters: DraftCandidate[][],
  candidates: DraftCandidate[],
  slots: number[],
  budgets: number[],
): boolean {
  let availableMask = 0n;
  for (const candidate of candidates) availableMask |= 1n << BigInt(candidate.index);
  const failed = new Set<string>();
  const formatLegality = new Map<bigint, boolean>();

  const rosterIsLegal = (roster: DraftCandidate[]): boolean => {
    let mask = 0n;
    for (const candidate of roster) mask |= 1n << BigInt(candidate.index);
    const cached = formatLegality.get(mask);
    if (cached !== undefined) return cached;
    const legal = (validator.validateTeam(roster.map((candidate) => candidate.set)) ?? []).every((problem) =>
      /must bring at least/i.test(problem),
    );
    formatLegality.set(mask, legal);
    return legal;
  };

  const search = (mask: bigint, remainingSlots: number[]): boolean => {
    const key = `${mask}:${remainingSlots.join(',')}`;
    if (failed.has(key)) return false;

    let entrant = -1;
    let eligible: DraftCandidate[] = [];
    let tightness = Number.POSITIVE_INFINITY;
    for (const [index, needed] of remainingSlots.entries()) {
      if (needed === 0) continue;
      const species = new Set(rosters[index]!.map((candidate) => candidate.species));
      const items = new Set(rosters[index]!.map((candidate) => candidate.item).filter(Boolean));
      const choices = candidates.filter(
        (candidate) =>
          (mask & (1n << BigInt(candidate.index))) !== 0n &&
          !species.has(candidate.species) &&
          !(candidate.item && items.has(candidate.item)),
      );
      if (choices.length < needed) {
        failed.add(key);
        return false;
      }
      let minimumCost = 0;
      for (let offset = 0; offset < needed; offset += 1) minimumCost += choices[offset]!.mon.cost;
      if (minimumCost > budgets[index]!) {
        failed.add(key);
        return false;
      }
      if (choices.length - needed < tightness) {
        entrant = index;
        eligible = choices;
        tightness = choices.length - needed;
      }
    }
    if (entrant < 0) return true;

    const selected: DraftCandidate[] = [];
    const species = new Set(rosters[entrant]!.map((candidate) => candidate.species));
    const items = new Set(rosters[entrant]!.map((candidate) => candidate.item).filter(Boolean));
    const assign = (start: number, needed: number, points: number, selectedMask: bigint): boolean => {
      if (needed === 0) {
        if (!rosterIsLegal([...rosters[entrant]!, ...selected])) return false;
        const nextSlots = [...remainingSlots];
        nextSlots[entrant] = 0;
        return search(mask & ~selectedMask, nextSlots);
      }
      if (eligible.length - start < needed) return false;

      let minimumCost = 0;
      for (let offset = 0; offset < needed; offset += 1) minimumCost += eligible[start + offset]!.mon.cost;
      if (minimumCost > points) return false;

      for (let index = start; index <= eligible.length - needed; index += 1) {
        const candidate = eligible[index]!;
        if (candidate.mon.cost > points) break;
        if (species.has(candidate.species) || (candidate.item && items.has(candidate.item))) continue;
        const bit = 1n << BigInt(candidate.index);
        selected.push(candidate);
        species.add(candidate.species);
        if (candidate.item) items.add(candidate.item);
        const complete = assign(index + 1, needed - 1, points - candidate.mon.cost, selectedMask | bit);
        selected.pop();
        species.delete(candidate.species);
        if (candidate.item) items.delete(candidate.item);
        if (complete) return true;
      }
      return false;
    };

    const complete = assign(0, remainingSlots[entrant]!, budgets[entrant]!, 0n);
    if (!complete) failed.add(key);
    return complete;
  };

  return search(availableMask, slots);
}

export function legalPicks(state: DraftState, drafter: number, psDir = defaultPsDir()): DraftBoardMon[] {
  const roster = state.rosters[drafter]!;
  if (roster.length >= state.board.picks) return [];

  const { Dex, TeamValidator } = loadShowdown(psDir);
  const validator = new TeamValidator(state.board.format);
  const candidates = state.board.mons.map((mon, index): DraftCandidate => {
    const set = unpackMon(mon, psDir);
    return {
      index,
      mon,
      set,
      species: Dex.species.get(set.species || set.name).baseSpecies,
      item: Dex.items.get(set.item).id,
    };
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.mon.id, candidate]));
  const rosters = state.rosters.map((mons) => mons.map((mon) => candidateById.get(mon.id)!));
  const rosterSets = rosters.map((candidates) => candidates.map((candidate) => candidate.set));
  const available = candidates.filter((candidate) => !state.taken.has(candidate.mon.id));
  const cheapest = [...available].sort((a, b) => a.mon.cost - b.mon.cost);

  return available
    .filter((candidate) => {
      const selectedSets = rosterSets[drafter]!;
      selectedSets.push(candidate.set);
      const valid = (validator.validateTeam(selectedSets) ?? []).every((problem) =>
        /must bring at least/i.test(problem),
      );
      selectedSets.pop();
      if (!valid) return false;

      const future = cheapest.filter((other) => other !== candidate);
      const projectedRosters = rosters.map((otherRoster, entrant) =>
        entrant === drafter ? [...otherRoster, candidate] : otherRoster,
      );
      const slots = state.rosters.map(
        (otherRoster, entrant) => state.board.picks - otherRoster.length - (entrant === drafter ? 1 : 0),
      );
      const budgets = state.budgets.map((budget, entrant) => budget - (entrant === drafter ? candidate.mon.cost : 0));
      return (
        budgets.every((budget) => budget >= 0) && canCompleteDraft(validator, projectedRosters, future, slots, budgets)
      );
    })
    .map((candidate) => candidate.mon);
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

function draftSystemPrompt(board: DraftBoard, models: string[], drafter: number): string {
  const values: Record<string, string> = {
    model: models[drafter]!,
    format: board.format,
    coaches: String(models.length),
    picks: String(board.picks),
    budget: String(board.budget),
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
  legalPicks: readonly DraftBoardMon[],
  psDir: string,
): string {
  const legal = new Set(legalPicks.map((mon) => mon.id));
  const lines: string[] = [];
  lines.push(
    DRAFT_PROMPT_POLICY.turnTemplate
      .replace('{{pick}}', String(pickNumber + 1))
      .replace('{{budget}}', String(state.budgets[drafter]))
      .replace('{{remaining}}', String(state.board.picks - state.rosters[drafter]!.length)),
  );
  lines.push('', DRAFT_PROMPT_POLICY.boardHeading);
  for (const mon of state.board.mons) {
    const owner = state.taken.get(mon.id);
    const status =
      owner === undefined
        ? legal.has(mon.id)
          ? DRAFT_PROMPT_POLICY.availableStatus
          : DRAFT_PROMPT_POLICY.unavailableStatus
        : DRAFT_PROMPT_POLICY.takenTemplate.replace('{{model}}', models[owner]!);
    lines.push(`- ${mon.id} | ${mon.tier} | ${mon.cost} | ${describeSet(mon, psDir)} [${status}]`);
  }
  lines.push('', DRAFT_PROMPT_POLICY.rosterHeading);
  lines.push(
    ...(state.rosters[drafter]!.length
      ? state.rosters[drafter]!.map((mon) => `- ${mon.name} (${mon.cost}) · ${describeSet(mon, psDir)}`)
      : [DRAFT_PROMPT_POLICY.emptyRoster]),
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
  lines.push('', DRAFT_PROMPT_POLICY.pickInstruction);
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
    return make(model, options.apiKeys?.[model], reasoningForModel(model, options));
  });
  const systemPrompts = models.map((_, drafter) => draftSystemPrompt(board, models, drafter));
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
      const system = systemPrompts[drafter]!;
      const messages: ProviderMessage[] = [
        { role: 'user', content: draftUserPrompt(state, drafter, models, pickNumber, legal, psDir) },
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
        try {
          await options.recovery?.wait(options.signal);
          const completion = await provider.complete(system, messages, {
            maxTokens: DRAFT_PROMPT_POLICY.maxTokens,
            timeout: DRAFT_PROMPT_POLICY.timeoutSeconds,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          response = completion.text;
          usage = completion.usage;
          const parsed = parsePick(response, legal);
          if (typeof parsed === 'string') {
            error = parsed;
            lastError = parsed;
            messages.push({ role: 'assistant', content: response });
            messages.push({
              role: 'user',
              content: DRAFT_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', parsed),
            });
          } else {
            chosen = parsed.mon;
            reasoning = parsed.reasoning;
          }
        } catch (cause) {
          const failure = classifyProviderFailure(cause, models[drafter]);
          error = failure.summary;
          lastError = error;
          if (failure.pausable && options.recovery && (failure.terminal || attempt >= DRAFT_PROMPT_POLICY.attempts)) {
            pauseFailure = failure;
          } else if (failure.terminal) {
            terminalError = new Error(`${failure.summary} The run cannot continue.`, { cause });
          }
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
        if (terminalError) throw terminalError;
        if (pauseFailure) {
          await options.recovery?.pause(models[drafter]!, pauseFailure.kind, pauseFailure.summary, options.signal);
          attempt -= 1;
        }
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
