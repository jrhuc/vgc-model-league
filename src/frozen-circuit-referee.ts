import { applyDraftPick, type DraftState, legalPicks, parsePick, renderDraftPickPrompt } from './draft.js';
import { buildDraftPlayoffBracket, type DraftLeagueSeriesPlan, rankedTable } from './draftleague.js';
import { canonicalJsonDigest } from './eval/serialization.js';
import { buildFrozenCircuitTerminalEvidence } from './frozen-circuit-evidence.js';
import { FrozenCircuitLedger } from './frozen-circuit-ledger.js';
import {
  type AcceptedConstruction,
  type CircuitSeat,
  type CircuitSeriesPlan,
  FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS,
  FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_SEAT_IDS,
  type FrozenCircuitObservation,
  type FrozenCircuitPendingTurn,
  type FrozenCircuitPhase,
  FrozenCircuitRefereeError,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
  type FrozenCircuitSubmissionResult,
  type FrozenCircuitTerminalEvidence,
  type PendingInternal,
  type PrivateSeriesEvidence,
  type SeriesSummary,
} from './frozen-circuit-model.js';
import {
  boundedProblems,
  buildPlayoffContext,
  candidateForDraftMon,
  deterministicDraftFallback,
  exactSeatId,
  FROZEN_CIRCUIT_PROMPT_POLICY,
  frozenCircuitPromptRevision,
  initializeFrozenCircuit,
  PLAYOFF_SERIES,
  PRE_WINDOW_WEEKS,
  parseActionResponse,
  parseNotebookResponse,
  ROUND_ROBIN_SERIES,
  sha256,
} from './frozen-circuit-setup.js';
import { FrozenCircuitTransactions } from './frozen-circuit-transactions.js';
import {
  FROZEN_MATCHDAY_FORMAT,
  FROZEN_MATCHDAY_NOTEBOOK_LIMIT,
  type FrozenMatchdayObservation,
  FrozenMatchdayReferee,
  type FrozenMatchdayRefereeOptions,
  type FrozenMatchdaySubmissionResult,
  type FrozenMatchdayTerminalEvidence,
} from './frozen-matchday-referee.js';
import type { DraftTableRow } from './gui/api.js';
import { showdownCommit } from './showdown.js';
import {
  deterministicTeamBuildFallback,
  renderStrictTeamBuildPrompt,
  type TeamBuildTask,
  validateTeamBuildSubmission,
} from './teambuild.js';
import { applyBracketOutcome, type BracketMatch, buildBracket } from './tournament.js';
import { type TradeWindowResult, type TradeWindowState, validateLeagueRosterState } from './trade-window.js';
import type { Pid } from './types.js';

export * from './frozen-circuit-model.js';
export { frozenCircuitPromptRevision } from './frozen-circuit-setup.js';

export class FrozenCircuitReferee {
  readonly scenarioId: FrozenCircuitScenarioId;
  readonly episodeId: string;
  readonly seed: number;
  readonly showdownRevision = showdownCommit();
  readonly promptRevision = frozenCircuitPromptRevision();
  readonly configDigest: string;
  readonly fixtureDigests: { board: string | null; victoryRoadPool: string | null };
  readonly format = FROZEN_MATCHDAY_FORMAT;

  private phase: FrozenCircuitPhase;
  private readonly ledger: FrozenCircuitLedger;
  private readonly seats: CircuitSeat[];
  private readonly plans: CircuitSeriesPlan[];
  private readonly seatPermutation: number[];
  private readonly notebooks = new Map<FrozenCircuitSeatId, string>();
  private readonly series: SeriesSummary[] = [];
  private readonly privateSeries: PrivateSeriesEvidence[] = [];
  private readonly constructionTasks = new Map<string, TeamBuildTask>();
  private readonly constructions = new Map<string, AcceptedConstruction>();
  private readonly coachingContext = new Map<number, Map<number, string>>();
  private readonly table: DraftTableRow[] = FROZEN_CIRCUIT_SEAT_IDS.map((_, entrant) => ({
    entrant,
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
  private readonly leagueResults: TradeWindowResult[][] = FROZEN_CIRCUIT_SEAT_IDS.map(() => []);
  private readonly leagueReflections = new Map<number, Map<number, string>>();
  private draftState: DraftState | null = null;
  private draftOrder: number[] = [];
  private bracket: BracketMatch[][] | null = null;
  private activePlan: CircuitSeriesPlan | null = null;
  private activeFixedMatch: BracketMatch | null = null;
  private activeMatchday: FrozenMatchdayReferee | null = null;
  private matchdayObservations = new Map<FrozenCircuitSeatId, FrozenMatchdayObservation>();
  private batchSeries: number[] = [];
  private batchKind: 'pre-window' | 'post-window' | 'semifinals' | 'final' | null = null;
  private transactions: FrozenCircuitTransactions | null = null;

  constructor(options: { scenarioId: FrozenCircuitScenarioId; episodeId: string; seed: number }) {
    const initial = initializeFrozenCircuit({
      ...options,
      showdownRevision: this.showdownRevision,
      promptRevision: this.promptRevision,
    });
    this.scenarioId = initial.scenarioId;
    this.episodeId = initial.episodeId;
    this.seed = initial.seed;
    this.seatPermutation = initial.seatPermutation;
    this.plans = initial.plans;
    this.fixtureDigests = initial.fixtureDigests;
    this.seats = initial.seats;
    this.phase = initial.phase;
    this.draftState = initial.draftState;
    this.draftOrder = initial.draftOrder;
    this.configDigest = initial.configDigest;
    for (const [entrant, seat] of this.seats.entries()) {
      this.coachingContext.set(entrant, new Map());
      this.leagueReflections.set(entrant, new Map());
      this.notebooks.set(seat.seatId, '');
    }
    this.ledger = new FrozenCircuitLedger(this.configDigest, () => ({
      phase: this.phase,
      stateHash: this.stateHash(),
    }));
    if (this.phase === 'tournament') this.startFixedTournament();
  }

  pendingTurns(): FrozenCircuitPendingTurn[] {
    this.ensurePending();
    return [...this.ledger.pending.values()]
      .sort((left, right) => left.turnId.localeCompare(right.turnId))
      .map(({ turnId, seatId, kind, prompt, attempt }) => ({ turnId, seatId, kind, prompt, attempt }));
  }

  observe(seatId: FrozenCircuitSeatId): FrozenCircuitObservation {
    const seat = this.requireSeat(seatId);
    const pendingTurns = this.pendingTurns().filter((turn) => turn.seatId === seatId);
    const entrant = this.seats.indexOf(seat);
    const roster = this.draftState?.rosters[entrant] ?? [];
    const participants = this.activeParticipants();
    const pid = participants
      ? ((Object.entries(participants).find(([, value]) => value === entrant)?.[0] as Pid | undefined) ?? null)
      : null;
    return {
      protocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
      promptProtocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
      scenarioId: this.scenarioId,
      seatId,
      phase: this.phase,
      revision: this.ledger.revision,
      stateHash: this.stateHash(),
      pendingTurns,
      bracket: this.bracket ? structuredClone(this.bracket) : null,
      private: {
        roster: roster.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
        budget: this.draftState?.budgets[entrant] ?? null,
        notebook: this.notebooks.get(seatId)!,
        activeSeries:
          pid && this.activePlan
            ? {
                seriesIndex: this.activePlan.index,
                stage: this.activePlan.stage,
                week: this.activePlan.week,
                opponentSeatId: this.seats[participants![pid === 'p1' ? 'p2' : 'p1']]!.seatId,
                pid,
              }
            : null,
        matchday: this.matchdayObservations.get(seatId) ?? null,
      },
      terminal: this.phase === 'terminal',
    };
  }

  submit(turnId: string, seatId: FrozenCircuitSeatId, response: string): FrozenCircuitSubmissionResult {
    this.requireSeat(seatId);
    this.ensurePending();
    const turn = this.ledger.pending.get(turnId);
    if (!turn) throw new FrozenCircuitRefereeError('unknown-turn', `turn ${JSON.stringify(turnId)} is not pending`);
    if (turn.seatId !== seatId) {
      throw new FrozenCircuitRefereeError('wrong-seat', `turn ${JSON.stringify(turnId)} belongs to ${turn.seatId}`);
    }
    this.ledger.pending.delete(turnId);
    if (turn.kind === 'draft') return this.submitDraft(turn, response);
    if (turn.kind === 'construction') return this.submitConstruction(turn, response);
    if (turn.kind === 'action') return this.submitAction(turn, response);
    if (turn.kind === 'notebook') return this.submitNotebook(turn, response);
    return this.submitTransaction(turn, response);
  }

  terminalEvidence(): FrozenCircuitTerminalEvidence | null {
    if (this.phase !== 'terminal' || !this.bracket) return null;
    return buildFrozenCircuitTerminalEvidence({
      scenarioId: this.scenarioId,
      seed: this.seed,
      showdownRevision: this.showdownRevision,
      configDigest: this.configDigest,
      promptRevision: this.promptRevision,
      fixtureDigests: this.fixtureDigests,
      seats: this.seats,
      plans: this.plans,
      seatPermutation: this.seatPermutation,
      bracket: this.bracket,
      table: this.table,
      series: this.series,
      defaults: this.ledger.defaults,
      publicReceipts: this.ledger.publicReceipts,
      privateReceipts: this.ledger.privateReceipts,
      privateSeries: this.privateSeries,
      notebooks: this.notebooks,
      constructions: this.constructions,
      transactions: this.transactions,
    });
  }

  currentState(): { revision: number; stateHash: string } {
    return { revision: this.ledger.revision, stateHash: this.stateHash() };
  }

  private ensurePending(): void {
    if (this.ledger.pending.size || this.phase === 'terminal') return;
    if (this.phase === 'draft') this.ensureDraftTurn();
    else if (this.phase === 'construction') this.ensureConstructionTurns();
    else if (this.phase === 'trade') this.ensureTradeTurn();
    else this.ensureTournamentTurns();
  }

  private ensureDraftTurn(): void {
    const state = this.requireDraftState();
    const pickNumber = state.taken.size;
    const entrant = this.draftOrder[pickNumber];
    if (entrant === undefined) {
      this.beginLeague();
      this.ensureConstructionTurns();
      return;
    }
    const seat = this.seats[entrant]!;
    const key = `draft:${pickNumber}`;
    const attempt = this.ledger.attempts.get(key) ?? 1;
    const problems = this.ledger.retryProblems.get(key) ?? [];
    const basePrompt = renderDraftPickPrompt(
      state,
      entrant,
      this.seats.map((entry) => entry.name),
      pickNumber,
      this.notebooks.get(seat.seatId)!,
      {
        rosterPolicy: FROZEN_CIRCUIT_PROMPT_POLICY.draftRosterPolicy,
        mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
      },
    );
    this.ledger.addPending({
      seatId: seat.seatId,
      kind: 'draft',
      prompt: this.ledger.withRetry(basePrompt, attempt, FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS, problems),
      attempt,
      problems,
    });
  }

  private ensureConstructionTurns(): void {
    const occupiedSeats = new Set(
      [...this.ledger.pending.values()].filter((turn) => turn.kind === 'construction').map((turn) => turn.seatId),
    );
    for (const seriesIndex of this.batchSeries) {
      const plan = this.plans[seriesIndex]!;
      if (!plan.entrants) throw new Error(`construction plan ${seriesIndex} has no entrants`);
      for (const entrant of plan.entrants) {
        const seatId = this.seats[entrant]!.seatId;
        const taskKey = this.constructionKey(seriesIndex, seatId);
        if (this.constructions.has(taskKey) || occupiedSeats.has(seatId)) continue;
        const task = this.constructionTasks.get(taskKey);
        if (!task) throw new Error(`${taskKey} has no strict construction task`);
        const attempt = this.ledger.attempts.get(taskKey) ?? 1;
        const problems = this.ledger.retryProblems.get(taskKey) ?? [];
        this.ledger.addPending({
          seatId,
          kind: 'construction',
          seriesIndex,
          taskKey,
          prompt: this.ledger.withRetry(
            renderStrictTeamBuildPrompt(task, {
              mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
            }),
            attempt,
            FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS,
            problems,
          ),
          attempt,
          problems,
        });
        occupiedSeats.add(seatId);
      }
    }
  }

  private ensureTournamentTurns(): void {
    const referee = this.activeMatchday;
    if (!referee || !this.activePlan) throw new Error('tournament phase has no active matchday');
    const participants = this.activeParticipants()!;
    this.captureMatchdayObservations();
    const sample = this.matchdayObservations.get(this.seats[participants.p1]!.seatId)!;
    if (sample.phase === 'terminal') {
      this.archiveActiveSeries();
      this.ensurePending();
      return;
    }
    for (const pid of ['p1', 'p2'] as const) {
      const seatId = this.seats[participants[pid]]!.seatId;
      const observation = this.matchdayObservations.get(seatId)!;
      const currentNotebook = referee.seatPrivateEvidence(pid).currentNotebook;
      if (observation.phase === 'between-games') {
        this.ledger.addPending({
          seatId,
          kind: 'notebook',
          pid,
          observation,
          attempt: 1,
          prompt: [
            `FROZEN CIRCUIT BETWEEN-GAME NOTEBOOK · series ${this.activePlan.index + 1} · game ${observation.gameNumber}`,
            ...FROZEN_CIRCUIT_PROMPT_POLICY.notebook.instructions,
            `Maximum ${FROZEN_MATCHDAY_NOTEBOOK_LIMIT} characters. Malformed evidence is treated as omission.`,
            '',
            'YOUR CURRENT PRIVATE NOTEBOOK:',
            currentNotebook,
            '',
            'YOUR SEAT-PRIVATE MATCHDAY UPDATE:',
            JSON.stringify(observation),
          ].join('\n'),
        });
        continue;
      }
      if (!observation.battle?.request || observation.battle.request.wait) continue;
      const commands = referee.legalActions(pid).actions.map((entry) => entry.command);
      this.ledger.addPending({
        seatId,
        kind: 'action',
        pid,
        observation,
        legalCommands: commands,
        attempt: 1,
        prompt: [
          `FROZEN CIRCUIT BATTLE ACTION · series ${this.activePlan.index + 1} · game ${observation.gameNumber}`,
          ...FROZEN_CIRCUIT_PROMPT_POLICY.action.instructions,
          '',
          'YOUR CURRENT PRIVATE NOTEBOOK:',
          currentNotebook,
          '',
          'YOUR SEAT-PRIVATE OBSERVATION:',
          JSON.stringify(observation),
          '',
          'AUTHORITY-ACCEPTED COMMANDS:',
          JSON.stringify(commands),
        ].join('\n'),
      });
    }
  }

  private ensureTradeTurn(): void {
    const transactions = this.requireTransactions();
    const pending = transactions.pending(
      this.ledger.attempts,
      this.ledger.retryProblems,
      FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS,
    );
    if (!pending) {
      this.closeTradeWindow();
      this.ensurePending();
      return;
    }
    this.ledger.addPending({
      seatId: pending.seatId,
      kind: pending.kind,
      tradeEntrant: pending.entrant,
      attempt: pending.attempt,
      problems: pending.problems,
      prompt: pending.prompt,
    });
  }

  private submitDraft(turn: PendingInternal, response: string): FrozenCircuitSubmissionResult {
    const state = this.requireDraftState();
    const pickNumber = state.taken.size;
    const entrant = this.draftOrder[pickNumber];
    const seat = this.seats[entrant!]!;
    if (seat.seatId !== turn.seatId) throw new FrozenCircuitRefereeError('wrong-phase', 'draft turn is stale');
    const legal = legalPicks(state, entrant!);
    const parsed = parsePick(
      response,
      legal,
      state,
      entrant!,
      this.seats.map((entry) => entry.name),
      this.notebooks.get(seat.seatId)!,
    );
    const key = `draft:${pickNumber}`;
    if (typeof parsed === 'string') {
      const problems = boundedProblems([parsed]);
      if (turn.attempt < FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS) {
        this.ledger.setRetry(key, turn.attempt + 1, problems);
        this.ledger.revision += 1;
        return this.ledger.finishSubmission(turn, response, false, false, false, parsed, problems);
      }
      const selected = deterministicDraftFallback(legal, this.scenarioId, this.seed, pickNumber);
      this.draftState = applyDraftPick(state, { pick: pickNumber + 1, entrant: entrant!, mon: selected.id });
      const diagnostic = `draft reply rejected after ${turn.attempt} attempts: ${parsed}`;
      this.ledger.recordDefault(turn, null, selected.id, diagnostic);
      this.ledger.clearRetry(key);
      this.ledger.revision += 1;
      this.afterDraftPick();
      return this.ledger.finishSubmission(turn, response, false, true, true, diagnostic, problems);
    }
    this.draftState = applyDraftPick(state, { pick: pickNumber + 1, entrant: entrant!, mon: parsed.mon.id });
    this.notebooks.set(seat.seatId, parsed.evidence.notebook);
    this.ledger.clearRetry(key);
    this.ledger.revision += 1;
    this.afterDraftPick();
    return this.ledger.finishSubmission(turn, response, true, true, false, null);
  }

  private submitConstruction(turn: PendingInternal, response: string): FrozenCircuitSubmissionResult {
    if (turn.seriesIndex === undefined || !turn.taskKey) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'construction turn lacks its series binding');
    }
    const task = this.constructionTasks.get(turn.taskKey);
    if (!task || this.constructions.has(turn.taskKey)) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'construction turn is stale');
    }
    const validation = validateTeamBuildSubmission(task, response, {
      attempts: turn.attempt,
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    if (validation.status === 'rejected') {
      const problems = boundedProblems(validation.problems);
      const diagnostic = problems.join('; ');
      if (turn.attempt < FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS) {
        this.ledger.setRetry(turn.taskKey, turn.attempt + 1, problems);
        this.ledger.revision += 1;
        return this.ledger.finishSubmission(turn, response, false, false, false, diagnostic, problems);
      }
      const fallback = deterministicTeamBuildFallback(
        task,
        `${this.scenarioId}:${this.seed}:${turn.taskKey}:construction`,
        { attempts: turn.attempt, createdAt: '2026-08-13T00:00:00.000Z' },
      );
      this.constructions.set(turn.taskKey, fallback.validation);
      const fallbackDiagnostic = `construction reply rejected after ${turn.attempt} attempts: ${diagnostic}`;
      this.ledger.recordDefault(
        turn,
        turn.seriesIndex,
        canonicalJsonDigest(fallback.validation.artifact),
        fallbackDiagnostic,
      );
      this.ledger.clearRetry(turn.taskKey);
      this.ledger.revision += 1;
      this.afterConstructionSubmission();
      return this.ledger.finishSubmission(turn, response, false, true, true, fallbackDiagnostic, problems);
    }
    this.constructions.set(turn.taskKey, validation);
    this.ledger.clearRetry(turn.taskKey);
    this.ledger.revision += 1;
    this.afterConstructionSubmission();
    return this.ledger.finishSubmission(turn, response, true, true, false, null);
  }

  private submitAction(turn: PendingInternal, response: string): FrozenCircuitSubmissionResult {
    const referee = this.activeMatchday;
    if (!referee || !turn.pid || !turn.observation || !turn.legalCommands || !this.activePlan) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'action turn is stale');
    }
    const command = parseActionResponse(response);
    let accepted = true;
    let defaulted = false;
    let diagnostic: string | null = null;
    let result: FrozenMatchdaySubmissionResult;
    try {
      result = referee.submit(turn.pid, command, turn.observation.revision, turn.observation.stateHash);
    } catch (cause) {
      accepted = false;
      defaulted = true;
      diagnostic = cause instanceof Error ? cause.message : String(cause);
      const fallback = turn.legalCommands[0];
      if (!fallback) throw new Error(`battle request has no deterministic legal fallback: ${diagnostic}`);
      result = referee.submit(turn.pid, fallback, turn.observation.revision, turn.observation.stateHash);
      this.ledger.recordDefault(turn, this.activePlan.index, sha256(fallback), diagnostic);
    }
    this.ledger.revision += 1;
    if (result.advanced) {
      this.ledger.pending.clear();
      this.matchdayObservations.clear();
      if (result.terminal) this.archiveActiveSeries();
    }
    return this.ledger.finishSubmission(turn, response, accepted, result.advanced, defaulted, diagnostic);
  }

  private submitNotebook(turn: PendingInternal, response: string): FrozenCircuitSubmissionResult {
    const referee = this.activeMatchday;
    if (!referee || !turn.pid || !turn.observation) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'notebook turn is stale');
    }
    const parsed = parseNotebookResponse(response);
    const result = referee.readyNextGame(turn.pid, parsed.input, turn.observation.revision, turn.observation.stateHash);
    this.ledger.revision += 1;
    if (result.advanced) {
      this.ledger.pending.clear();
      this.matchdayObservations.clear();
    }
    return this.ledger.finishSubmission(
      turn,
      response,
      parsed.diagnostic === null,
      result.advanced,
      false,
      parsed.diagnostic,
    );
  }

  private submitTransaction(turn: PendingInternal, response: string): FrozenCircuitSubmissionResult {
    const entrant = turn.tradeEntrant;
    if (
      entrant === undefined ||
      (turn.kind !== 'trade_offer' && turn.kind !== 'trade_response' && turn.kind !== 'free_agency')
    ) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'transaction turn is stale');
    }
    const outcome = this.requireTransactions().submit(
      turn.kind,
      entrant,
      response,
      turn.attempt,
      FROZEN_CIRCUIT_MAX_TRANSACTION_ATTEMPTS,
      boundedProblems,
    );
    if (outcome.retryAttempt !== undefined) {
      this.ledger.setRetry(outcome.key, outcome.retryAttempt, outcome.problems ?? []);
      this.ledger.revision += 1;
      return this.ledger.finishSubmission(turn, response, false, false, false, outcome.diagnostic, outcome.problems);
    }
    if (outcome.defaultSelection !== undefined && outcome.diagnostic !== null) {
      this.ledger.recordDefault(turn, null, outcome.defaultSelection, outcome.diagnostic);
    }
    this.ledger.clearRetry(outcome.key);
    for (const [index, seat] of this.seats.entries()) {
      this.notebooks.set(seat.seatId, this.requireTransactions().state.notebooks[index]!);
    }
    this.ledger.revision += 1;
    return this.ledger.finishSubmission(
      turn,
      response,
      outcome.accepted,
      outcome.advanced,
      outcome.defaulted,
      outcome.diagnostic,
      outcome.problems,
    );
  }

  private afterDraftPick(): void {
    const state = this.requireDraftState();
    if (state.taken.size === this.draftOrder.length) this.beginLeague();
  }

  private beginLeague(): void {
    if (this.scenarioId !== 'draft-league-v1') throw new Error('only draft league enters league construction');
    validateLeagueRosterState(this.tradeStateProjection());
    this.prepareConstructionBatch(
      this.plans.filter((plan) => plan.stage === 'roundrobin' && plan.week !== null && plan.week <= PRE_WINDOW_WEEKS),
      'pre-window',
    );
  }

  private prepareConstructionBatch(
    plans: readonly CircuitSeriesPlan[],
    kind: 'pre-window' | 'post-window' | 'semifinals' | 'final',
  ): void {
    const state = this.requireDraftState();
    this.phase = 'construction';
    this.ledger.pending.clear();
    this.batchKind = kind;
    this.batchSeries = plans.map((plan) => plan.index);
    for (const plan of plans) {
      if (!plan.entrants) throw new Error(`series ${plan.index} cannot construct before its entrants resolve`);
      for (const [entrant, opponent] of [
        [plan.entrants[0], plan.entrants[1]],
        [plan.entrants[1], plan.entrants[0]],
      ] as const) {
        const seat = this.seats[entrant]!;
        const key = this.constructionKey(plan.index, seat.seatId);
        const priorContext =
          plan.stage === 'playoff'
            ? [...this.coachingContext.get(entrant)!.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, context]) => context)
            : [];
        this.constructionTasks.set(key, {
          id: `${this.scenarioId}-series-${plan.index}-${seat.seatId}-construction`,
          model: seat.name,
          format: this.format,
          sheetPolicy: 'open',
          executionPolicy: 'strict',
          constraint: {
            kind: 'draft-picks',
            id: `${this.scenarioId}-series-${plan.index}-${seat.seatId}-roster`,
            teamSize: 6,
            candidates: state.rosters[entrant]!.map(candidateForDraftMon),
          },
          objective: {
            kind: 'matchup',
            stage: plan.stage === 'playoff' ? 'playoff' : 'roundrobin',
            opponent: {
              model: this.seats[opponent]!.name,
              candidates: state.rosters[opponent]!.map(candidateForDraftMon),
            },
            priorContext,
          },
          notebook: this.notebooks.get(seat.seatId)!,
          provenance: {
            source: 'frozen-circuit-draft-league-v1',
            seriesIndex: plan.index,
            entrant,
            opponent,
          },
        });
      }
    }
  }

  private afterConstructionSubmission(): void {
    const complete = this.batchSeries.every((seriesIndex) => {
      const plan = this.plans[seriesIndex]!;
      return plan.entrants?.every((entrant) =>
        this.constructions.has(this.constructionKey(seriesIndex, this.seats[entrant]!.seatId)),
      );
    });
    if (!complete) return;
    this.ledger.pending.clear();
    this.phase = 'tournament';
    this.startNextBatchSeries();
  }

  private startFixedTournament(): void {
    this.bracket = buildBracket(this.seats.length);
    this.startNextFixedSeries();
  }

  private startNextFixedSeries(): void {
    if (!this.bracket) throw new Error('fixed top cut has no bracket');
    const ready = this.bracket
      .flat()
      .filter(
        (match) =>
          match.seriesIndex !== null &&
          match.slots[0] !== null &&
          match.slots[1] !== null &&
          match.winner === null &&
          !this.series.some((entry) => entry.seriesIndex === match.seriesIndex),
      )
      .sort((left, right) => left.seriesIndex! - right.seriesIndex!)[0];
    if (!ready) {
      if (this.series.length !== 7) throw new Error(`fixed top cut archived ${this.series.length} series, expected 7`);
      this.finishCircuit();
      return;
    }
    const plan = this.plans[ready.seriesIndex!]!;
    plan.entrants = [ready.slots[0]!, ready.slots[1]!];
    this.activeFixedMatch = structuredClone(ready);
    this.startMatchday(plan);
  }

  private startNextBatchSeries(): void {
    const next = this.batchSeries
      .map((index) => this.plans[index]!)
      .find((plan) => !this.series.some((entry) => entry.seriesIndex === plan.index));
    if (next) {
      this.startMatchday(next);
      return;
    }
    if (this.batchKind === 'pre-window') this.openTradeWindow();
    else if (this.batchKind === 'post-window') this.startPlayoffs();
    else if (this.batchKind === 'semifinals') this.preparePlayoffFinal();
    else if (this.batchKind === 'final') this.finishCircuit();
    else throw new Error('completed construction batch has no continuation');
  }

  private startMatchday(plan: CircuitSeriesPlan): void {
    if (!plan.entrants) throw new Error(`series ${plan.index} has unresolved entrants`);
    const sides = { p1: this.seats[plan.entrants[0]]!, p2: this.seats[plan.entrants[1]]! };
    const constructionFor = (pid: Pid): AcceptedConstruction => {
      if (this.scenarioId === 'victory-road-top8-v1') {
        const fixed = sides[pid].fixedConstruction;
        if (!fixed) throw new Error(`${sides[pid].seatId} has no fixed construction`);
        return fixed;
      }
      const value = this.constructions.get(this.constructionKey(plan.index, sides[pid].seatId));
      if (!value) throw new Error(`${sides[pid].seatId} has no construction for series ${plan.index}`);
      return value;
    };
    const options: FrozenMatchdayRefereeOptions = {
      format: this.format,
      gameSeeds: plan.gameSeeds,
      ...(plan.stage === 'roundrobin' ? {} : { requireWinner: true }),
      seats: (['p1', 'p2'] as const).map((pid) => ({
        pid,
        name: sides[pid].name,
        construction: constructionFor(pid),
      })),
    };
    this.activePlan = plan;
    this.activeMatchday = new FrozenMatchdayReferee(options);
    this.matchdayObservations.clear();
    this.ledger.pending.clear();
    this.phase = 'tournament';
  }

  private archiveActiveSeries(): void {
    const referee = this.activeMatchday;
    const plan = this.activePlan;
    if (!referee || !plan?.entrants) throw new Error('no active series to archive');
    const evidence = referee.terminalEvidence();
    if (!evidence) throw new Error('active series is not terminal');
    const participants = { p1: plan.entrants[0], p2: plan.entrants[1] };
    const seatIds = { p1: this.seats[participants.p1]!.seatId, p2: this.seats[participants.p2]!.seatId };
    const elimination = plan.stage !== 'roundrobin';
    const winnerSide: Pid | null = evidence.result.type === 'win' ? evidence.result.winner.pid : null;
    if (elimination && !winnerSide) throw new Error(`elimination series ${plan.index} ended without a winner`);
    const winnerSeatId = winnerSide ? seatIds[winnerSide] : null;
    const registrations = new Map(evidence.registrations.map((entry) => [entry.pid, entry]));
    const bracketRound = this.activeFixedMatch?.round ?? (plan.stage === 'playoff' ? (plan.index < 30 ? 0 : 1) : null);
    this.series.push({
      seriesIndex: plan.index,
      stage: plan.stage,
      week: plan.week,
      bracketRound,
      seats: seatIds,
      winnerSeatId,
      tiebreak: elimination && evidence.games.length > 3 ? 'deterministic-extra-games' : 'none',
      score: { ...evidence.score },
      gameCount: evidence.games.length,
      games: evidence.games.map((game, index) => ({
        gameNumber: index + 1,
        result:
          game.result.type === 'tie'
            ? { type: 'tie' as const, winnerSeatId: null }
            : { type: 'win' as const, winnerSeatId: seatIds[game.result.winner.pid] },
        turns: game.turns,
      })),
      matchdayConfigDigest: evidence.configDigest,
      acceptedJoins: (['p1', 'p2'] as const).map((pid) => ({
        seatId: seatIds[pid],
        pid,
        teamSha256: registrations.get(pid)!.teamSha256,
        constructionSha256: registrations.get(pid)!.constructionSha256,
      })),
    });
    this.privateSeries.push({ seriesIndex: plan.index, evidence: structuredClone(evidence) });
    for (const pid of ['p1', 'p2'] as const) {
      const entrant = participants[pid];
      const notebook = referee.seatPrivateEvidence(pid).currentNotebook;
      this.leagueReflections.get(entrant)!.set(plan.index, notebook);
      if (this.scenarioId === 'draft-league-v1') {
        this.coachingContext
          .get(entrant)!
          .set(
            plan.index,
            buildPlayoffContext(
              plan,
              entrant,
              notebook,
              evidence,
              this.seats,
              this.constructions.get(this.constructionKey(plan.index, this.seats[entrant]!.seatId)),
            ),
          );
      }
    }
    if (plan.stage === 'roundrobin') this.applyRoundRobinOutcome(plan, evidence, winnerSide);
    this.activeMatchday = null;
    this.activePlan = null;
    this.matchdayObservations.clear();
    this.ledger.pending.clear();
    if (plan.stage === 'top-cut') {
      if (!winnerSide || !this.bracket || !this.activeFixedMatch) throw new Error('top cut has no advancement result');
      this.bracket = applyBracketOutcome(this.bracket, this.activeFixedMatch, winnerSide);
      this.activeFixedMatch = null;
      this.startNextFixedSeries();
    } else if (plan.stage === 'playoff') {
      if (!winnerSide || !this.bracket) throw new Error('playoff has no advancement result');
      const scheduled = this.bracket.flat().find((match) => match.seriesIndex === plan.index);
      if (!scheduled) throw new Error(`playoff series ${plan.index} is absent from bracket`);
      this.bracket = applyBracketOutcome(this.bracket, scheduled, winnerSide);
      this.startNextBatchSeries();
    } else this.startNextBatchSeries();
  }

  private applyRoundRobinOutcome(
    plan: CircuitSeriesPlan,
    evidence: FrozenMatchdayTerminalEvidence,
    winnerSide: Pid | null,
  ): void {
    const [a, b] = plan.entrants!;
    this.table[a]!.gw += evidence.score.p1;
    this.table[a]!.gl += evidence.score.p2;
    this.table[b]!.gw += evidence.score.p2;
    this.table[b]!.gl += evidence.score.p1;
    if (winnerSide) {
      this.table[winnerSide === 'p1' ? a : b]!.w += 1;
      this.table[winnerSide === 'p1' ? b : a]!.l += 1;
    }
    const state = this.requireDraftState();
    for (const [entrant, opponent, side] of [
      [a, b, 'p1'],
      [b, a, 'p2'],
    ] as const) {
      const other = side === 'p1' ? 'p2' : 'p1';
      this.leagueResults[entrant]!.push({
        entrant,
        opponent,
        week: plan.week!,
        score: [evidence.score[side], evidence.score[other]],
        result: winnerSide === null ? 'drew' : winnerSide === side ? 'won' : 'lost',
        opponentRoster: state.rosters[opponent]!.map((mon) => `${mon.id} (${mon.cost})`).join(', '),
      });
    }
  }

  private openTradeWindow(): void {
    this.phase = 'trade';
    this.ledger.pending.clear();
    this.transactions = new FrozenCircuitTransactions(this.tradeStateProjection(), this.seats);
  }

  private tradeStateProjection(): TradeWindowState {
    const state = this.requireDraftState();
    const projected: TradeWindowState = {
      board: state.board,
      models: this.seats.map((seat) => seat.name),
      teamNames: this.seats.map((seat) => seat.name),
      rosters: state.rosters.map((roster) => [...roster]),
      budgets: [...state.budgets],
      notebooks: this.seats.map((seat) => this.notebooks.get(seat.seatId)!),
      standings: rankedTable(this.table),
      results: this.leagueResults.map((results) => structuredClone(results)),
      reflections: this.seats.map((_, entrant) =>
        [...this.leagueReflections.get(entrant)!.entries()]
          .filter(([seriesIndex]) => seriesIndex < PRE_WINDOW_WEEKS * 4)
          .sort(([left], [right]) => left - right)
          .map(([, notebook]) => notebook),
      ),
    };
    validateLeagueRosterState(projected);
    return projected;
  }

  private closeTradeWindow(): void {
    const transaction = this.requireTransactions().close();
    const state = this.requireDraftState();
    this.draftState = {
      ...state,
      rosters: transaction.rosters.map((roster) => [...roster]),
      budgets: [...transaction.budgets],
      teamNames: [...state.teamNames],
      taken: new Map(transaction.rosters.flatMap((roster, entrant) => roster.map((mon) => [mon.id, entrant] as const))),
    };
    for (const [entrant, seat] of this.seats.entries())
      this.notebooks.set(seat.seatId, transaction.notebooks[entrant]!);
    this.ledger.pending.clear();
    this.prepareConstructionBatch(
      this.plans.filter((plan) => plan.stage === 'roundrobin' && plan.week !== null && plan.week > PRE_WINDOW_WEEKS),
      'post-window',
    );
  }

  private startPlayoffs(): void {
    const playoffPlans = this.plans.filter((plan) => plan.stage === 'playoff');
    const authorityPlans: DraftLeagueSeriesPlan[] = playoffPlans.map((plan, index) => ({
      index: plan.index,
      stage: 'playoff',
      round: index < 2 ? 1 : 2,
      entrants: null,
      gameSeeds: plan.gameSeeds,
      engineSeeds: { p1: 0, p2: 0 },
    }));
    const seeding = rankedTable(this.table).map((row) => row.entrant);
    this.bracket = buildDraftPlayoffBracket(authorityPlans, seeding);
    for (const match of this.bracket[0]!) {
      const plan = this.plans[match.seriesIndex!]!;
      plan.entrants = [match.slots[0]!, match.slots[1]!];
    }
    this.prepareConstructionBatch(
      this.bracket[0]!.map((match) => this.plans[match.seriesIndex!]!),
      'semifinals',
    );
  }

  private preparePlayoffFinal(): void {
    if (!this.bracket) throw new Error('playoff final has no bracket');
    const match = this.bracket[1]![0]!;
    if (match.slots[0] === null || match.slots[1] === null)
      throw new Error('playoff final prerequisites are unresolved');
    const plan = this.plans[match.seriesIndex!]!;
    plan.entrants = [match.slots[0], match.slots[1]];
    this.prepareConstructionBatch([plan], 'final');
  }

  private finishCircuit(): void {
    const expected = this.scenarioId === 'draft-league-v1' ? ROUND_ROBIN_SERIES + PLAYOFF_SERIES : 7;
    if (this.series.length !== expected) {
      throw new Error(`terminal circuit archived ${this.series.length} series, expected ${expected}`);
    }
    this.activePlan = null;
    this.activeFixedMatch = null;
    this.activeMatchday = null;
    this.ledger.pending.clear();
    this.matchdayObservations.clear();
    this.phase = 'terminal';
  }

  private captureMatchdayObservations(): void {
    if (this.matchdayObservations.size) return;
    const referee = this.activeMatchday;
    const participants = this.activeParticipants();
    if (!referee || !participants) return;
    for (const pid of ['p1', 'p2'] as const) {
      this.matchdayObservations.set(this.seats[participants[pid]]!.seatId, referee.observe(pid));
    }
  }

  private activeParticipants(): Record<Pid, number> | null {
    if (!this.activePlan?.entrants) return null;
    return { p1: this.activePlan.entrants[0], p2: this.activePlan.entrants[1] };
  }

  private constructionKey(seriesIndex: number, seatId: FrozenCircuitSeatId): string {
    return `${seriesIndex}:${seatId}`;
  }

  private requireSeat(seatId: FrozenCircuitSeatId): CircuitSeat {
    const exact = exactSeatId(seatId);
    const seat = exact ? this.seats.find((entry) => entry.seatId === exact) : undefined;
    if (!seat) throw new FrozenCircuitRefereeError('unknown-seat', `unknown circuit seat ${String(seatId)}`);
    return seat;
  }

  private requireDraftState(): DraftState {
    if (!this.draftState) throw new FrozenCircuitRefereeError('wrong-phase', 'this scenario has no draft state');
    return this.draftState;
  }

  private requireTransactions(): FrozenCircuitTransactions {
    if (!this.transactions) throw new FrozenCircuitRefereeError('wrong-phase', 'the transaction window is closed');
    return this.transactions;
  }

  private stateHash(): string {
    return canonicalJsonDigest({
      protocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
      configDigest: this.configDigest,
      phase: this.phase,
      revision: this.ledger.revision,
      draft: this.draftState
        ? {
            taken: [...this.draftState.taken.entries()].sort(([left], [right]) => left.localeCompare(right)),
            rosters: this.draftState.rosters.map((roster) => roster.map((mon) => mon.id)),
            budgets: [...this.draftState.budgets],
          }
        : null,
      notebooks: FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => ({
        seatId,
        notebookSha256: sha256(this.notebooks.get(seatId)!),
      })),
      constructions: [...this.constructions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, construction]) => ({ key, constructionDigest: canonicalJsonDigest(construction) })),
      bracket: this.bracket,
      table: this.table,
      leagueResults: this.leagueResults,
      coachingContext: [...this.coachingContext.entries()]
        .sort(([left], [right]) => left - right)
        .map(([entrant, entries]) => ({
          entrant,
          entries: [...entries.entries()].sort(([left], [right]) => left - right),
        })),
      leagueReflections: [...this.leagueReflections.entries()]
        .sort(([left], [right]) => left - right)
        .map(([entrant, entries]) => ({
          entrant,
          entries: [...entries.entries()].sort(([left], [right]) => left - right),
        })),
      transactionStateDigest: this.transactions?.stateDigest() ?? null,
      archivedSeries: this.series.map((entry) => ({
        seriesIndex: entry.seriesIndex,
        winnerSeatId: entry.winnerSeatId,
        matchdayConfigDigest: entry.matchdayConfigDigest,
      })),
      activeSeries: this.activePlan?.index ?? null,
      activeMatchday: this.activeMatchday?.currentState() ?? null,
      batch: { kind: this.batchKind, series: this.batchSeries },
      pending: [...this.ledger.pending.values()].map((turn) => ({
        turnId: turn.turnId,
        seatId: turn.seatId,
        kind: turn.kind,
        attempt: turn.attempt,
        promptSha256: sha256(turn.prompt),
      })),
    });
  }
}
