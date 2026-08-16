import {
  type FrozenBetweenGameInput,
  type FrozenMatchdayObservation,
  type FrozenMatchdayPrivateEvidence,
  FrozenMatchdayReferee,
  type FrozenMatchdayRefereeOptions,
  type FrozenMatchdaySubmissionResult,
  type FrozenMatchdayTerminalEvidence,
} from '../frozen-matchday-referee.js';
import { seededRng } from '../random.js';
import type { Pid } from '../types.js';
import type { AdaptationForkOutcome, NotebookTreatment } from './bo3-adaptation.js';
import type { CommonForkDraw, MatchedForkPlan } from './fork-plan.js';
import { canonicalJsonDigest } from './serialization.js';
import type { OpponentModeProbability } from './strategic-task.js';

export const FROZEN_MATCHDAY_ADAPTER_PROTOCOL = {
  version: 1,
  checkpoint: 'verified-completed-source-between-games-v1',
  replay: 'accepted-actions-and-private-notebook-intervals-v1',
  futureSeeds: 'first-common-battle-seed-then-continuation-derived-v1',
  continuation: 'strict-no-fallback-controller-loop-v1',
  nonFocalNotebook: 'retain-checkpoint-bytes-v1',
  executionIdentity: 'checkpoint-plan-arm-draw-treatment-controller-focal-v1',
} as const;

type MatchdayGameEvidence = FrozenMatchdayTerminalEvidence['games'][number];
type PrivateInterval = FrozenMatchdayPrivateEvidence['intervals'][number];

export interface FrozenMatchdayCompletedSource {
  caseId: string;
  decisionNodeId: string;
  options: FrozenMatchdayRefereeOptions;
  terminalEvidence: FrozenMatchdayTerminalEvidence;
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>;
}

export interface FrozenMatchdayBetweenGameCheckpoint {
  protocolVersion: typeof FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version;
  kind: 'between-games';
  caseId: string;
  decisionNodeId: string;
  afterGame: number;
  sourceConfigDigest: string;
  sourceTerminalDigest: string;
  options: FrozenMatchdayRefereeOptions;
  completedGames: MatchdayGameEvidence[];
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>;
  revision: number;
  stateHash: string;
  checkpointDigest: string;
}

export interface FrozenMatchdayActionDecision {
  command: string;
  actionId?: string;
  modeForecast?: OpponentModeProbability[];
}

export interface FrozenMatchdayActionContext {
  pid: Pid;
  observation: FrozenMatchdayObservation;
  legalActions: ReturnType<FrozenMatchdayReferee['legalActions']>['actions'];
  currentNotebook: string;
  decisionIndex: number;
  draw: CommonForkDraw;
}

export interface FrozenMatchdayNotebookContext {
  pid: Pid;
  observation: FrozenMatchdayObservation;
  currentNotebook: string;
  intervalIndex: number;
  draw: CommonForkDraw;
}

export interface FrozenMatchdayContinuationController {
  decideAction(
    context: FrozenMatchdayActionContext,
  ): FrozenMatchdayActionDecision | Promise<FrozenMatchdayActionDecision>;
  decideNotebook?(context: FrozenMatchdayNotebookContext): FrozenBetweenGameInput | Promise<FrozenBetweenGameInput>;
}

export interface FrozenMatchdayContinuationControllers {
  controllerSetDigest: string;
  seats: Record<Pid, FrozenMatchdayContinuationController>;
}

export interface FrozenMatchdayForkOutcome extends AdaptationForkOutcome {
  executionDigest: string;
  diagnostic: string | null;
  sourceCheckpointDigest: string;
  sourceConfigDigest: string;
  forkConfigDigest: string;
  terminalDigest: string | null;
}

function exactPidRecord<T>(value: Record<Pid, T>): Record<Pid, T> {
  return { p1: structuredClone(value.p1), p2: structuredClone(value.p2) };
}

function receipts(evidence: FrozenMatchdayPrivateEvidence): Array<Omit<PrivateInterval, 'notebook'>> {
  return evidence.intervals.map(({ notebook: _notebook, ...receipt }) => receipt);
}

function receiptEvidence(terminal: FrozenMatchdayTerminalEvidence, pid: Pid) {
  const evidence = terminal.notebookReceipts.find((entry) => entry.pid === pid);
  if (!evidence) throw new Error(`source terminal is missing ${pid} notebook receipts`);
  return evidence.intervals;
}

function intervalFor(
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>,
  pid: Pid,
  gameNumber: number,
): PrivateInterval {
  const matches = privateEvidence[pid].intervals.filter((entry) => entry.gameNumber === gameNumber);
  if (matches.length !== 1) {
    throw new Error(`${pid} needs exactly one private notebook interval after game ${gameNumber}`);
  }
  return matches[0] as PrivateInterval;
}

function intervalInput(interval: PrivateInterval): FrozenBetweenGameInput {
  return interval.supplied ? { notebookReplacement: interval.notebook } : {};
}

function replayGameActions(referee: FrozenMatchdayReferee, game: MatchdayGameEvidence): FrozenMatchdaySubmissionResult {
  let latest: FrozenMatchdaySubmissionResult | null = null;
  for (const action of game.submittedActions) {
    const state = referee.currentState();
    latest = referee.submit(action.pid, action.command, state.revision, state.stateHash);
  }
  if (!latest || latest.phase === 'playing') {
    throw new Error(`source game ${game.seed.join(',')} actions did not finish the game`);
  }
  return latest;
}

function applySourceInterval(
  referee: FrozenMatchdayReferee,
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>,
  gameNumber: number,
): FrozenMatchdaySubmissionResult {
  let latest: FrozenMatchdaySubmissionResult | null = null;
  for (const pid of ['p1', 'p2'] as const) {
    const state = referee.currentState();
    latest = referee.readyNextGame(
      pid,
      intervalInput(intervalFor(privateEvidence, pid, gameNumber)),
      state.revision,
      state.stateHash,
    );
  }
  if (!latest?.advanced || latest.phase !== 'playing') {
    throw new Error(`source notebook interval after game ${gameNumber} did not start the next game`);
  }
  return latest;
}

function replayPrefix(input: {
  options: FrozenMatchdayRefereeOptions;
  games: readonly MatchdayGameEvidence[];
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>;
  expectTerminal: boolean;
}): FrozenMatchdayReferee {
  if (!input.games.length) throw new Error('matchday replay needs at least one completed game');
  const referee = new FrozenMatchdayReferee(input.options);
  let latest: FrozenMatchdaySubmissionResult | null = null;
  for (const [index, game] of input.games.entries()) {
    latest = replayGameActions(referee, game);
    const last = index === input.games.length - 1;
    if (!last) {
      if (latest.phase !== 'between-games') {
        throw new Error(`source series became ${latest.phase} before game ${index + 2}`);
      }
      latest = applySourceInterval(referee, input.privateEvidence, index + 1);
    }
  }
  if (!latest) throw new Error('matchday replay produced no submission result');
  const expectedPhase = input.expectTerminal ? 'terminal' : 'between-games';
  if (latest.phase !== expectedPhase) {
    throw new Error(`matchday replay ended in ${latest.phase}, expected ${expectedPhase}`);
  }
  return referee;
}

function checkpointBase(checkpoint: FrozenMatchdayBetweenGameCheckpoint) {
  const { checkpointDigest: _checkpointDigest, ...base } = checkpoint;
  return base;
}

function validateCheckpoint(checkpoint: FrozenMatchdayBetweenGameCheckpoint): void {
  if (checkpoint.protocolVersion !== FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version || checkpoint.kind !== 'between-games') {
    throw new Error('frozen matchday checkpoint has an unsupported protocol');
  }
  if (!checkpoint.caseId || !checkpoint.decisionNodeId) {
    throw new Error('frozen matchday checkpoint needs case and decision-node identities');
  }
  if (checkpoint.afterGame !== checkpoint.completedGames.length || checkpoint.afterGame < 1) {
    throw new Error('frozen matchday checkpoint game count is inconsistent');
  }
  if (canonicalJsonDigest(checkpointBase(checkpoint)) !== checkpoint.checkpointDigest) {
    throw new Error('frozen matchday checkpoint digest does not match its contents');
  }
}

function verifyCompletedSource(source: FrozenMatchdayCompletedSource): void {
  if (!source.caseId || !source.decisionNodeId) throw new Error('completed matchday source needs non-empty identities');
  const fresh = new FrozenMatchdayReferee(source.options);
  if (fresh.configDigest !== source.terminalEvidence.configDigest) {
    throw new Error('completed matchday options do not match the source terminal config digest');
  }
  for (const pid of ['p1', 'p2'] as const) {
    const privateEvidence = source.privateEvidence[pid];
    if (privateEvidence.pid !== pid) throw new Error(`source private evidence is bound to the wrong ${pid} seat`);
    if (
      canonicalJsonDigest(receipts(privateEvidence)) !==
      canonicalJsonDigest(receiptEvidence(source.terminalEvidence, pid))
    ) {
      throw new Error(`${pid} private notebook bytes do not match the terminal receipt ledger`);
    }
  }
  const replayed = replayPrefix({
    options: source.options,
    games: source.terminalEvidence.games,
    privateEvidence: source.privateEvidence,
    expectTerminal: true,
  });
  const terminal = replayed.terminalEvidence();
  if (!terminal || canonicalJsonDigest(terminal) !== canonicalJsonDigest(source.terminalEvidence)) {
    throw new Error('completed matchday source does not replay to its terminal evidence');
  }
}

export function buildFrozenMatchdayBetweenGameCheckpoint(
  source: FrozenMatchdayCompletedSource,
  afterGame: number,
): FrozenMatchdayBetweenGameCheckpoint {
  verifyCompletedSource(source);
  if (!Number.isSafeInteger(afterGame) || afterGame < 1 || afterGame >= source.terminalEvidence.games.length) {
    throw new Error('between-game checkpoint must follow a nonterminal completed source game');
  }
  const completedGames = structuredClone(source.terminalEvidence.games.slice(0, afterGame));
  const priorPrivateEvidence = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      {
        pid,
        currentNotebook: '',
        intervals: source.privateEvidence[pid].intervals.filter((entry) => entry.gameNumber < afterGame),
      },
    ]),
  ) as Record<Pid, FrozenMatchdayPrivateEvidence>;
  const replayed = replayPrefix({
    options: source.options,
    games: completedGames,
    privateEvidence: priorPrivateEvidence,
    expectTerminal: false,
  });
  for (const pid of ['p1', 'p2'] as const) priorPrivateEvidence[pid] = replayed.seatPrivateEvidence(pid);
  const state = replayed.currentState();
  const base = {
    protocolVersion: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version,
    kind: 'between-games' as const,
    caseId: source.caseId,
    decisionNodeId: source.decisionNodeId,
    afterGame,
    sourceConfigDigest: source.terminalEvidence.configDigest,
    sourceTerminalDigest: canonicalJsonDigest(source.terminalEvidence),
    options: structuredClone(source.options),
    completedGames,
    privateEvidence: exactPidRecord(priorPrivateEvidence),
    revision: state.revision,
    stateHash: state.stateHash,
  };
  return { ...base, checkpointDigest: canonicalJsonDigest(base) };
}

function derivedSeed(namespace: string): [number, number, number, number] {
  const random = seededRng(namespace);
  const word = () => 1 + Math.floor(random() * 0xffff);
  return [word(), word(), word(), word()];
}

function optionsForDraw(
  checkpoint: FrozenMatchdayBetweenGameCheckpoint,
  draw: CommonForkDraw,
): FrozenMatchdayRefereeOptions {
  if (checkpoint.afterGame >= 3) {
    throw new Error('v1 matchday draw overrides support regulation between-game checkpoints only');
  }
  const options = structuredClone(checkpoint.options);
  const gameSeeds = options.gameSeeds.map((seed) => [...seed]) as [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
  for (let index = 0; index < checkpoint.afterGame; index += 1) {
    if (canonicalJsonDigest(gameSeeds[index]) !== canonicalJsonDigest(checkpoint.completedGames[index]?.seed)) {
      throw new Error(`checkpoint source seed for game ${index + 1} does not match its accepted options`);
    }
  }
  gameSeeds[checkpoint.afterGame] = [...draw.battleSeed];
  for (let index = checkpoint.afterGame + 1; index < gameSeeds.length; index += 1) {
    gameSeeds[index] = derivedSeed(`${draw.continuationSeed}:matchday-game:${index + 1}`);
  }
  return { ...options, gameSeeds };
}

export function restoreFrozenMatchdayBetweenGameCheckpoint(
  checkpoint: FrozenMatchdayBetweenGameCheckpoint,
  draw?: CommonForkDraw,
): FrozenMatchdayReferee {
  validateCheckpoint(checkpoint);
  const referee = replayPrefix({
    options: draw ? optionsForDraw(checkpoint, draw) : checkpoint.options,
    games: checkpoint.completedGames,
    privateEvidence: checkpoint.privateEvidence,
    expectTerminal: false,
  });
  const privateEvidence = exactPidRecord({
    p1: referee.seatPrivateEvidence('p1'),
    p2: referee.seatPrivateEvidence('p2'),
  });
  if (canonicalJsonDigest(privateEvidence) !== canonicalJsonDigest(checkpoint.privateEvidence)) {
    throw new Error('restored matchday private evidence does not match the checkpoint prefix');
  }
  const state = referee.currentState();
  if (!draw) {
    if (
      referee.configDigest !== checkpoint.sourceConfigDigest ||
      state.revision !== checkpoint.revision ||
      state.stateHash !== checkpoint.stateHash
    ) {
      throw new Error('restored matchday does not reproduce the exact checkpoint state');
    }
  } else if (state.revision !== checkpoint.revision) {
    throw new Error('matched future draw changed the source-prefix revision');
  }
  return referee;
}

export function notebookTreatmentActionDigest(treatment: NotebookTreatment): string {
  return canonicalJsonDigest(['notebook-replacement-v1', treatment.notebook]);
}

function forkExecutionDigest(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  plan: MatchedForkPlan;
  armId: string;
  draw: CommonForkDraw;
  focalPid: Pid;
  treatment: NotebookTreatment;
  controllers: FrozenMatchdayContinuationControllers;
}): string {
  return canonicalJsonDigest({
    protocolVersion: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version,
    checkpointDigest: input.checkpoint.checkpointDigest,
    planDigest: input.plan.planDigest,
    armId: input.armId,
    draw: input.draw,
    focalPid: input.focalPid,
    treatmentDigest: input.treatment.treatmentDigest,
    controllerSetDigest: input.controllers.controllerSetDigest,
    nonFocalNotebook: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.nonFocalNotebook,
  });
}

function terminalUtility(
  terminal: FrozenMatchdayTerminalEvidence,
  focalPid: Pid,
  utilityUnit: MatchedForkPlan['utilityUnit'],
): number {
  if (utilityUnit === 'game-win-probability') {
    throw new Error('whole-matchday forks cannot report game-win probability as their terminal utility');
  }
  if (terminal.result.type === 'tie') return utilityUnit === 'series-win-probability' ? 0.5 : 0;
  const won = terminal.result.winner.pid === focalPid;
  return utilityUnit === 'series-win-probability' ? Number(won) : won ? 1 : -1;
}

function failureOutcome(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  referee: FrozenMatchdayReferee;
  armId: string;
  drawId: string;
  clusterId: string;
  treatment: NotebookTreatment;
  protocolValid: boolean;
  actionLegal: boolean;
  diagnostic: string;
  actionId: string | null;
  modeForecast?: OpponentModeProbability[];
  executionDigest: string;
}): FrozenMatchdayForkOutcome {
  return {
    caseId: input.checkpoint.caseId,
    decisionNodeId: input.checkpoint.decisionNodeId,
    armId: input.armId,
    drawId: input.drawId,
    clusterId: input.clusterId,
    protocolValid: input.protocolValid,
    actionLegal: input.actionLegal,
    utility: null,
    treatmentKind: input.treatment.kind,
    actionId: input.actionId,
    executionDigest: input.executionDigest,
    ...(input.modeForecast === undefined ? {} : { modeForecast: input.modeForecast }),
    diagnostic: input.diagnostic,
    sourceCheckpointDigest: input.checkpoint.checkpointDigest,
    sourceConfigDigest: input.checkpoint.sourceConfigDigest,
    forkConfigDigest: input.referee.configDigest,
    terminalDigest: null,
  };
}

function planBindings(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  plan: MatchedForkPlan;
  armId: string;
  drawId: string;
  treatment: NotebookTreatment;
  controllers: FrozenMatchdayContinuationControllers;
}) {
  validateCheckpoint(input.checkpoint);
  if (input.plan.decisionNode.id !== input.checkpoint.decisionNodeId || input.plan.decisionNode.stage !== 'notebook') {
    throw new Error('matched fork plan is not bound to this notebook checkpoint');
  }
  const arm = input.plan.arms.find((entry) => entry.id === input.armId);
  if (!arm) throw new Error(`matched fork plan has no arm ${JSON.stringify(input.armId)}`);
  if (arm.treatmentDigest !== input.treatment.treatmentDigest) {
    throw new Error('notebook treatment digest does not match the selected fork arm');
  }
  if (arm.replacementActionDigest !== notebookTreatmentActionDigest(input.treatment)) {
    throw new Error('notebook replacement bytes do not match the selected fork arm');
  }
  if (arm.controllerSetDigest !== input.controllers.controllerSetDigest) {
    throw new Error('runtime continuation controllers do not match the selected fork arm');
  }
  const draw = input.plan.draws.find((entry) => entry.id === input.drawId);
  if (!draw) throw new Error(`matched fork plan has no draw ${JSON.stringify(input.drawId)}`);
  return { arm, draw };
}

function exactCommand(
  decision: FrozenMatchdayActionDecision,
  legalActions: FrozenMatchdayActionContext['legalActions'],
): boolean {
  return Boolean(decision?.command) && legalActions.some((entry) => entry.command === decision.command);
}

export async function runFrozenMatchdayNotebookFork(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  plan: MatchedForkPlan;
  armId: string;
  drawId: string;
  clusterId: string;
  focalPid: Pid;
  treatment: NotebookTreatment;
  controllers: FrozenMatchdayContinuationControllers;
  maxDecisions?: number;
  realizedMode?(terminal: FrozenMatchdayTerminalEvidence, focalPid: Pid, draw: CommonForkDraw): string;
}): Promise<FrozenMatchdayForkOutcome> {
  if (!input.clusterId) throw new Error('matchday fork clusterId must be non-empty');
  const { draw } = planBindings(input);
  const executionDigest = forkExecutionDigest({
    checkpoint: input.checkpoint,
    plan: input.plan,
    armId: input.armId,
    draw,
    focalPid: input.focalPid,
    treatment: input.treatment,
    controllers: input.controllers,
  });
  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint, draw);
  let latest: FrozenMatchdaySubmissionResult | null = null;
  for (const pid of ['p1', 'p2'] as const) {
    const state = referee.currentState();
    const notebookInput = pid === input.focalPid ? { notebookReplacement: input.treatment.notebook } : {};
    try {
      latest = referee.readyNextGame(pid, notebookInput, state.revision, state.stateHash);
    } catch (cause) {
      return failureOutcome({
        checkpoint: input.checkpoint,
        referee,
        executionDigest,
        armId: input.armId,
        drawId: input.drawId,
        clusterId: input.clusterId,
        treatment: input.treatment,
        protocolValid: false,
        actionLegal: false,
        diagnostic: cause instanceof Error ? cause.message : String(cause),
        actionId: null,
      });
    }
  }
  if (!latest?.advanced || latest.phase !== 'playing') {
    return failureOutcome({
      checkpoint: input.checkpoint,
      referee,
      executionDigest,
      armId: input.armId,
      drawId: input.drawId,
      clusterId: input.clusterId,
      treatment: input.treatment,
      protocolValid: false,
      actionLegal: false,
      diagnostic: 'notebook treatment did not start the next game',
      actionId: null,
    });
  }

  const decisionCounts: Record<Pid, number> = { p1: 0, p2: 0 };
  let intervalIndex = input.checkpoint.afterGame;
  let firstFocalActionId: string | null = null;
  let firstModeForecast: OpponentModeProbability[] | undefined;
  const maxDecisions = input.maxDecisions ?? 500;

  for (let steps = 0; steps < maxDecisions; steps += 1) {
    if (latest.terminal) break;
    if (latest.phase === 'playing') {
      const observations = {
        p1: referee.observe('p1'),
        p2: referee.observe('p2'),
      };
      const decisions: Array<{ pid: Pid; decision: FrozenMatchdayActionDecision }> = [];
      for (const pid of ['p1', 'p2'] as const) {
        const observation = observations[pid];
        if (!observation.battle?.request || observation.battle.request.wait) continue;
        const legalActions = referee.legalActions(pid).actions;
        if (!legalActions.length) {
          return failureOutcome({
            checkpoint: input.checkpoint,
            referee,
            executionDigest,
            armId: input.armId,
            drawId: input.drawId,
            clusterId: input.clusterId,
            treatment: input.treatment,
            protocolValid: true,
            actionLegal: false,
            diagnostic: `${pid} has an active request with no accepted action`,
            actionId: firstFocalActionId,
            ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
          });
        }
        let decision: FrozenMatchdayActionDecision;
        try {
          decision = await input.controllers.seats[pid].decideAction({
            pid,
            observation,
            legalActions,
            currentNotebook: referee.seatPrivateEvidence(pid).currentNotebook,
            decisionIndex: decisionCounts[pid],
            draw,
          });
        } catch (cause) {
          return failureOutcome({
            checkpoint: input.checkpoint,
            referee,
            executionDigest,
            armId: input.armId,
            drawId: input.drawId,
            clusterId: input.clusterId,
            treatment: input.treatment,
            protocolValid: false,
            actionLegal: false,
            diagnostic: cause instanceof Error ? cause.message : String(cause),
            actionId: firstFocalActionId,
            ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
          });
        }
        if (!decision || typeof decision.command !== 'string' || !decision.command) {
          return failureOutcome({
            checkpoint: input.checkpoint,
            referee,
            executionDigest,
            armId: input.armId,
            drawId: input.drawId,
            clusterId: input.clusterId,
            treatment: input.treatment,
            protocolValid: false,
            actionLegal: false,
            diagnostic: `${pid} controller did not return a command`,
            actionId: firstFocalActionId,
            ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
          });
        }
        if (!exactCommand(decision, legalActions)) {
          return failureOutcome({
            checkpoint: input.checkpoint,
            referee,
            executionDigest,
            armId: input.armId,
            drawId: input.drawId,
            clusterId: input.clusterId,
            treatment: input.treatment,
            protocolValid: true,
            actionLegal: false,
            diagnostic: `${pid} controller returned a command outside the accepted action set`,
            actionId: firstFocalActionId,
            ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
          });
        }
        if (pid === input.focalPid && firstFocalActionId === null) {
          firstFocalActionId = decision.actionId ?? canonicalJsonDigest(['matchday-command-v1', decision.command]);
          firstModeForecast = decision.modeForecast;
        }
        decisionCounts[pid] += 1;
        decisions.push({ pid, decision });
      }
      if (!decisions.length) {
        return failureOutcome({
          checkpoint: input.checkpoint,
          referee,
          executionDigest,
          armId: input.armId,
          drawId: input.drawId,
          clusterId: input.clusterId,
          treatment: input.treatment,
          protocolValid: false,
          actionLegal: false,
          diagnostic: 'playing matchday produced no pending controller decision',
          actionId: firstFocalActionId,
          ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
        });
      }
      for (const { pid, decision } of decisions) {
        const observation = observations[pid];
        try {
          latest = referee.submit(pid, decision.command, observation.revision, observation.stateHash);
        } catch (cause) {
          return failureOutcome({
            checkpoint: input.checkpoint,
            referee,
            executionDigest,
            armId: input.armId,
            drawId: input.drawId,
            clusterId: input.clusterId,
            treatment: input.treatment,
            protocolValid: true,
            actionLegal: false,
            diagnostic: cause instanceof Error ? cause.message : String(cause),
            actionId: firstFocalActionId,
            ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
          });
        }
      }
      continue;
    }

    const observations = {
      p1: referee.observe('p1'),
      p2: referee.observe('p2'),
    };
    for (const pid of ['p1', 'p2'] as const) {
      const controller = input.controllers.seats[pid];
      let notebookInput: FrozenBetweenGameInput = {};
      try {
        notebookInput =
          (await controller.decideNotebook?.({
            pid,
            observation: observations[pid],
            currentNotebook: referee.seatPrivateEvidence(pid).currentNotebook,
            intervalIndex,
            draw,
          })) ?? {};
        const observation = observations[pid];
        latest = referee.readyNextGame(pid, notebookInput, observation.revision, observation.stateHash);
      } catch (cause) {
        return failureOutcome({
          checkpoint: input.checkpoint,
          referee,
          executionDigest,
          armId: input.armId,
          drawId: input.drawId,
          clusterId: input.clusterId,
          treatment: input.treatment,
          protocolValid: false,
          actionLegal: true,
          diagnostic: cause instanceof Error ? cause.message : String(cause),
          actionId: firstFocalActionId,
          ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
        });
      }
    }
    intervalIndex += 1;
  }

  if (!latest?.terminal) {
    return failureOutcome({
      checkpoint: input.checkpoint,
      referee,
      executionDigest,
      armId: input.armId,
      drawId: input.drawId,
      clusterId: input.clusterId,
      treatment: input.treatment,
      protocolValid: false,
      actionLegal: true,
      diagnostic: `matchday continuation exceeded ${maxDecisions} decision intervals`,
      actionId: firstFocalActionId,
      ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
    });
  }
  const terminal = referee.terminalEvidence();
  if (!terminal) throw new Error('terminal matchday continuation has no terminal evidence');
  const realizedMode = input.realizedMode?.(terminal, input.focalPid, draw);
  if (realizedMode !== undefined && !realizedMode) throw new Error('realized opponent mode must be non-empty');
  return {
    caseId: input.checkpoint.caseId,
    decisionNodeId: input.checkpoint.decisionNodeId,
    armId: input.armId,
    drawId: input.drawId,
    clusterId: input.clusterId,
    protocolValid: true,
    actionLegal: true,
    utility: terminalUtility(terminal, input.focalPid, input.plan.utilityUnit),
    treatmentKind: input.treatment.kind,
    actionId: firstFocalActionId,
    executionDigest,
    ...(firstModeForecast === undefined ? {} : { modeForecast: firstModeForecast }),
    ...(realizedMode === undefined ? {} : { realizedMode }),
    diagnostic: null,
    sourceCheckpointDigest: input.checkpoint.checkpointDigest,
    sourceConfigDigest: input.checkpoint.sourceConfigDigest,
    forkConfigDigest: referee.configDigest,
    terminalDigest: canonicalJsonDigest(terminal),
  };
}
