import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { connectedDraftPromptRevision, type DraftBoardMon, type DraftState, loadBoard, snakeOrder } from './draft.js';
import { buildDraftLeagueSchedule, draftLeaguePlayoffReview } from './draftleague.js';
import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION } from './frozen-battle-referee.js';
import {
  type AcceptedConstruction,
  type CircuitSeat,
  type CircuitSeriesPlan,
  FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS,
  FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_SCENARIOS,
  FROZEN_CIRCUIT_SEAT_IDS,
  type FrozenCircuitPhase,
  FrozenCircuitRefereeError,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
  type FrozenCircuitTerminalSummary,
  type Seed,
  type Wdl,
} from './frozen-circuit-model.js';
import {
  FROZEN_MATCHDAY_FORMAT,
  FROZEN_MATCHDAY_NOTEBOOK_LIMIT,
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  type FrozenMatchdayTerminalEvidence,
} from './frozen-matchday-referee.js';
import type { TeambuildView } from './gui/api.js';
import { BOARDS_DIR, REPO_ROOT } from './paths.js';
import { seededRng, seriesEntropy, shuffle } from './random.js';
import { canonicalJsonDigest } from './serialization.js';
import { seriesSeedSchedule } from './series.js';
import { loadShowdown } from './showdown.js';
import {
  connectedTeamBuildPromptRevision,
  type TeamBuildCandidate,
  type TeamBuildTask,
  validateTeamBuildSubmission,
} from './teambuild.js';
import { loadPool, type Team } from './teams.js';
import { connectedTradeWindowPromptRevision, DEFAULT_TRADE_WINDOW, MAX_TRADE_SWAPS } from './trade-window.js';
import type { Pid } from './types.js';

const COMMITTED_TEAMS_DIR = path.join(REPO_ROOT, 'teams');
export const PRE_WINDOW_WEEKS = DEFAULT_TRADE_WINDOW.afterWeek;
export const ROUND_ROBIN_SERIES = 28;
export const PLAYOFF_SERIES = 3;

export const FROZEN_CIRCUIT_PROMPT_POLICY = {
  mechanicsTools: 'unavailable' as const,
  draftRosterPolicy:
    '- The league plays seven round-robin weeks. A coach-trade and free-agency window opens after week 3; the top four then qualify for playoffs.',
  action: {
    framing: 'seat-private-observation-plus-authority-accepted-commands-v2',
    instructions: [
      'Choose one command accepted by the frozen Showdown request authority.',
      'Reply with the exact command, or one JSON object {"command":"<exact command>"}.',
      'Open team sheets are already present in your seat-private observation. This format has no Terastallization.',
    ],
  },
  notebook: {
    framing: 'bounded-complete-replacement-or-omission-v1',
    instructions: [
      'This is private to your seat and cannot change the registered six. Reply with one JSON object',
      '{"notebookReplacement":"<complete replacement>"}, or {} to keep the current notebook.',
    ],
  },
  batching: 'construct-entire-blind-block-before-serial-matchdays-v1',
  retry: 'append-bounded-public-problems-v1',
} as const;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function boundedProblems(problems: readonly string[]): string[] {
  return problems.slice(0, 8).map((problem) => problem.slice(0, 1_000));
}

export function exactSeatId(value: unknown): FrozenCircuitSeatId | null {
  return FROZEN_CIRCUIT_SEAT_IDS.includes(value as FrozenCircuitSeatId) ? (value as FrozenCircuitSeatId) : null;
}

export function scenarioId(value: unknown): FrozenCircuitScenarioId {
  if (!FROZEN_CIRCUIT_SCENARIOS.includes(value as FrozenCircuitScenarioId)) {
    throw new FrozenCircuitRefereeError('unknown-scenario', `unknown frozen circuit scenario ${JSON.stringify(value)}`);
  }
  return value as FrozenCircuitScenarioId;
}

export function fixtureTreeDigest(files: readonly string[]): string {
  return canonicalJsonDigest(
    files.map((file) => ({
      file: path.relative(REPO_ROOT, file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })),
  );
}

export function committedPoolFiles(): string[] {
  const directory = path.join(COMMITTED_TEAMS_DIR, 'vr-aug26-top8');
  return fs
    .readdirSync(directory)
    .filter((name) => fs.lstatSync(path.join(directory, name)).isFile())
    .sort()
    .map((name) => path.join(directory, name));
}

export function teamDigest(team: Team): { id: string; seed: number | null; packedSha256: string } {
  return { id: team.id, seed: team.seed ?? null, packedSha256: sha256(team.packed) };
}

export function committedPoolProjection() {
  return loadPool('vr-aug26-top8', COMMITTED_TEAMS_DIR).teams.map(teamDigest);
}

export function candidateForDraftMon(mon: DraftBoardMon): TeamBuildCandidate {
  return {
    id: mon.id,
    name: mon.name,
    species: mon.species,
    ...(mon.forme === undefined ? {} : { forme: mon.forme }),
    ...(mon.item === undefined ? {} : { item: mon.item }),
    base: mon.base,
    types: [...mon.types],
  };
}

export function constructionForPackedTeam(
  packed: string,
  seatId: FrozenCircuitSeatId,
  name: string,
  source: string,
): AcceptedConstruction {
  const { Dex, Teams } = loadShowdown();
  const unpacked = Teams.unpack(packed);
  if (unpacked?.length !== 6) {
    throw new FrozenCircuitRefereeError('invalid-construction', `${seatId} fixed team must unpack to six sets`);
  }
  const candidates: TeamBuildCandidate[] = unpacked.map((set, index) => {
    const species = Dex.species.get(set.species);
    const item = Dex.items.get(set.item);
    const megaName = item.megaStone?.[species.name];
    const forme = megaName ? Dex.species.get(megaName) : undefined;
    return {
      id: `${seatId}-registered-${index + 1}`,
      name: forme?.name ?? species.name,
      species: species.name,
      ...(forme ? { forme: forme.name, item: item.name } : {}),
      base: species.baseSpecies,
      types: [...(forme ?? species).types],
    };
  });
  const task: TeamBuildTask = {
    id: `${seatId}-fixed-construction`,
    model: name,
    format: FROZEN_MATCHDAY_FORMAT,
    sheetPolicy: 'open',
    executionPolicy: 'strict',
    constraint: { kind: 'frozen-candidate-pool', id: `${seatId}-committed-six`, teamSize: 6, candidates },
    objective: { kind: 'general', brief: 'Register this committed top-cut six without changing any set.' },
    notebook: '',
    provenance: { source },
  };
  const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
  const response = JSON.stringify({
    sets: unpacked.map((set, index) => ({
      id: candidates[index]!.id,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: Object.fromEntries(stats.map((stat) => [stat, set.evs?.[stat] ?? 0])),
      note: '',
    })),
  });
  const validation = validateTeamBuildSubmission(task, response, {
    attempts: 0,
    createdAt: '2026-08-13T00:00:00.000Z',
  });
  if (validation.status !== 'accepted') {
    throw new FrozenCircuitRefereeError(
      'invalid-construction',
      `${seatId} committed team failed strict construction: ${validation.problems.join('; ')}`,
    );
  }
  return validation;
}

export function fixedSeats(placement: readonly number[]): CircuitSeat[] {
  const pool = loadPool('vr-aug26-top8', COMMITTED_TEAMS_DIR);
  if (pool.format !== FROZEN_MATCHDAY_FORMAT || pool.teams.length !== 8) {
    throw new FrozenCircuitRefereeError(
      'invalid-construction',
      'the committed Victory Road pool must hold eight pinned-format teams',
    );
  }
  const committed = [...pool.teams].sort((left, right) => left.seed! - right.seed!);
  return committed.map((team, index) => {
    const seatId = FROZEN_CIRCUIT_SEAT_IDS[placement[index]!]!;
    const name = seatId;
    return {
      seatId,
      name,
      fixedConstruction: constructionForPackedTeam(
        team.packed,
        seatId,
        name,
        `committed:teams/vr-aug26-top8/${team.id}`,
      ),
    };
  });
}

export function scenarioDescription(id: FrozenCircuitScenarioId): FrozenCircuitTerminalSummary['scenario'] {
  if (id === 'victory-road-top8-v1') {
    return {
      seats: 8,
      source: 'committed teams/vr-aug26-top8 pool for Victory Road August Challenge #1',
      scope: 'conditional eight-seat single-elimination top-cut re-enactment with committed reconstructed teams',
      claims: [
        'all seven conditional top-cut series are simulated',
        'each Bo3 registers one fixed six and starts a fresh open-sheet preview each game',
      ],
      doesNotClaim: ['Victory Road Swiss replay', 'archived player action replay', 'original unpublished stat spreads'],
    };
  }
  return {
    seats: 8,
    source: 'committed boards/regmb-202607.json Regulation M-B draft board',
    scope: 'snake draft, seven-week round robin, week-three transactions, and qualified top-four playoffs',
    claims: [
      'all 28 round-robin pairs and all three conditional playoff series are simulated',
      'matchup construction and the transaction barrier mirror the current draft-league authorities',
    ],
    doesNotClaim: ['historical event replay', 'archived player action replay'],
  };
}

export function fixedPlans(seed: number): CircuitSeriesPlan[] {
  const random = seededRng(`frozen-circuit:victory-road-top8-v1:${seed}:series-seeds:v2`);
  return Array.from({ length: 7 }, (_, index) => ({
    index,
    stage: 'top-cut' as const,
    week: null,
    entrants: null,
    gameSeeds: seriesEntropy(random).gameSeeds as [Seed, Seed, Seed],
  }));
}

export function leaguePlans(seed: number): CircuitSeriesPlan[] {
  return buildDraftLeagueSchedule(FROZEN_CIRCUIT_SEAT_IDS.length, seed).plans.map((plan) => ({
    index: plan.index,
    stage: plan.stage,
    week: plan.stage === 'roundrobin' ? plan.round : null,
    entrants: plan.entrants ? [...plan.entrants] : null,
    gameSeeds: plan.gameSeeds as [Seed, Seed, Seed],
  }));
}

export function deterministicDraftFallback(
  legal: readonly DraftBoardMon[],
  scenario: FrozenCircuitScenarioId,
  seed: number,
  pickNumber: number,
): DraftBoardMon {
  if (!legal.length) throw new Error('draft fallback has no legal pick');
  const ordered = [...legal].sort((left, right) => left.id.localeCompare(right.id));
  const random = seededRng(`${scenario}:${seed}:draft-default:${pickNumber + 1}`);
  return ordered[Math.floor(random() * ordered.length)]!;
}

export function buildPlayoffContext(
  plan: CircuitSeriesPlan,
  entrant: number,
  notebook: string,
  evidence: FrozenMatchdayTerminalEvidence,
  seats: readonly CircuitSeat[],
  construction: AcceptedConstruction | undefined,
): string {
  const pair = plan.entrants!;
  const side: Pid = pair[0] === entrant ? 'p1' : 'p2';
  const opponent = pair[0] === entrant ? pair[1] : pair[0];
  const won = evidence.result.type === 'win' && evidence.result.winner.pid === side;
  const result = evidence.result.type === 'tie' ? 'drew with' : won ? 'beat' : 'lost to';
  const summary = `${plan.stage === 'playoff' ? `Playoff round ${plan.index < 30 ? 1 : 2}` : `Round-robin week ${plan.week}`}: ${result} ${seats[opponent]!.name} ${evidence.score[side]}-${evidence.score[side === 'p1' ? 'p2' : 'p1']}`;
  if (!construction?.artifact.action) return `${summary}. Final private battle note: ${notebook || '(empty)'}`;
  const view: TeambuildView = {
    seriesIndex: plan.index,
    entrant,
    opponent,
    brought: [...construction.artifact.action.selected],
    sets: structuredClone(construction.artifact.action.sets),
    rationale: construction.artifact.evidence.rationale,
    attempts: construction.artifact.attempts,
  };
  return draftLeaguePlayoffReview(summary, view, notebook);
}

export function initializeFrozenCircuit(options: {
  scenarioId: FrozenCircuitScenarioId;
  episodeId: string;
  seed: number;
  showdownRevision: string;
  promptRevision: string;
}) {
  const selectedScenario = scenarioId(options.scenarioId);
  if (!options.episodeId) throw new Error('episodeId must be a non-empty string');
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    throw new Error('seed must be a non-negative safe integer');
  }
  const indices = FROZEN_CIRCUIT_SEAT_IDS.map((_, index) => index);
  const seatPermutation = shuffle(indices, seededRng(`frozen-circuit:${selectedScenario}:${options.seed}:seats`));
  const plans = selectedScenario === 'draft-league-v1' ? leaguePlans(options.seed) : fixedPlans(options.seed);
  const fixtureDigests = {
    board:
      selectedScenario === 'draft-league-v1' ? fixtureTreeDigest([path.join(BOARDS_DIR, 'regmb-202607.json')]) : null,
    victoryRoadPool: selectedScenario === 'victory-road-top8-v1' ? fixtureTreeDigest(committedPoolFiles()) : null,
  };
  let seats: CircuitSeat[];
  let phase: FrozenCircuitPhase;
  let draftState: DraftState | null = null;
  let draftOrder: number[] = [];
  if (selectedScenario === 'victory-road-top8-v1') {
    seats = fixedSeats(seatPermutation);
    phase = 'tournament';
  } else {
    seats = seatPermutation.map((seatIndex) => ({
      seatId: FROZEN_CIRCUIT_SEAT_IDS[seatIndex]!,
      name: FROZEN_CIRCUIT_SEAT_IDS[seatIndex]!,
      fixedConstruction: null,
    }));
    const board = loadBoard('regmb-202607');
    draftState = {
      board,
      taken: new Map(),
      rosters: seats.map(() => []),
      budgets: seats.map(() => board.budget),
      teamNames: seats.map((seat) => seat.name),
    };
    draftOrder = snakeOrder(seats.length, board.picks);
    phase = 'draft';
  }
  const poolProjection = selectedScenario === 'victory-road-top8-v1' ? committedPoolProjection() : null;
  const boardProjection = draftState
    ? {
        id: draftState.board.id,
        format: draftState.board.format,
        budget: draftState.board.budget,
        picks: draftState.board.picks,
        source: draftState.board.source,
        mons: draftState.board.mons,
      }
    : null;
  const configDigest = canonicalJsonDigest({
    protocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
    promptProtocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
    matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
    battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
    showdownRevision: options.showdownRevision,
    scenarioId: selectedScenario,
    format: FROZEN_MATCHDAY_FORMAT,
    promptRevision: options.promptRevision,
    scenario: scenarioDescription(selectedScenario),
    fixtureDigests,
    derivationSeed: options.seed,
    seatPermutation,
    pool: poolProjection,
    board: boardProjection,
    schedule: plans.map((plan) => ({
      index: plan.index,
      stage: plan.stage,
      week: plan.week,
      entrants: plan.entrants,
    })),
    seriesSeeds: plans.map((plan) =>
      seriesSeedSchedule(
        plan.gameSeeds.map((value) => [...value]),
        plan.stage !== 'roundrobin',
      ),
    ),
    tradeWindow:
      selectedScenario === 'draft-league-v1'
        ? { ...DEFAULT_TRADE_WINDOW, maxFreeAgencySwaps: MAX_TRADE_SWAPS, order: 'inverse-standings' }
        : null,
    batching: selectedScenario === 'draft-league-v1' ? FROZEN_CIRCUIT_PROMPT_POLICY.batching : null,
    retries: {
      draft: FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS,
      construction: FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS,
      transaction: FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS,
    },
    eliminationWinnerPolicy: 'foldSeriesGames-v1-deterministic-up-to-nine',
  });
  return {
    scenarioId: selectedScenario,
    episodeId: options.episodeId,
    seed: options.seed,
    seatPermutation,
    plans,
    fixtureDigests,
    seats,
    phase,
    draftState,
    draftOrder,
    configDigest,
  };
}

export function frozenCircuitPromptRevision(): string {
  return sha256(
    JSON.stringify({
      protocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
      draft: connectedDraftPromptRevision(FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools),
      construction: connectedTeamBuildPromptRevision(
        { kind: 'general' },
        'open',
        FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
      ),
      transaction: connectedTradeWindowPromptRevision(FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools),
      circuit: FROZEN_CIRCUIT_PROMPT_POLICY,
    }),
  ).slice(0, 16);
}

export function parseActionResponse(response: string): string {
  const trimmed = response.trim();
  const match = /\{[\s\S]*\}/u.exec(trimmed);
  if (!match) return trimmed;
  try {
    const value = JSON.parse(match[0]) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const command = (value as Record<string, unknown>).command;
      if (typeof command === 'string') return command.trim();
    }
  } catch {}
  return trimmed;
}

export function parseNotebookResponse(response: string): {
  input: { notebookReplacement?: string };
  diagnostic: string | null;
} {
  if (!response.trim()) return { input: {}, diagnostic: null };
  const match = /\{[\s\S]*\}/u.exec(response);
  if (!match) return { input: {}, diagnostic: 'notebook reply contained no JSON object; treated as omission' };
  try {
    const value = JSON.parse(match[0]) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { input: {}, diagnostic: 'notebook reply was not an object; treated as omission' };
    }
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, 'notebookReplacement')) return { input: {}, diagnostic: null };
    if (typeof record.notebookReplacement !== 'string') {
      return { input: {}, diagnostic: 'notebookReplacement was not a string; treated as omission' };
    }
    if (record.notebookReplacement.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT) {
      return { input: {}, diagnostic: 'notebookReplacement exceeded the circuit limit; treated as omission' };
    }
    return { input: { notebookReplacement: record.notebookReplacement }, diagnostic: null };
  } catch {
    return { input: {}, diagnostic: 'notebook JSON did not parse; treated as omission' };
  }
}

export function emptyWdl(): Wdl {
  return { wins: 0, draws: 0, losses: 0 };
}
