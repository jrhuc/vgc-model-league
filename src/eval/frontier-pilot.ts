import { summarizeBattleEvents } from '../battle-transcript.js';
import {
  FROZEN_MATCHDAY_NOTEBOOK_LIMIT,
  type FrozenMatchdayPhase,
  FrozenMatchdayReferee,
  type FrozenMatchdayRefereeOptions,
  type FrozenMatchdaySubmissionResult,
} from '../frozen-matchday-referee.js';
import { classifyProviderFailure, makeProvider, parseSpec, type ReasoningLevel } from '../providers.js';
import { seededRng } from '../random.js';
import { loadShowdown } from '../showdown.js';
import {
  replayTeamBuildArtifact,
  type TeamBuildSubmissionValidation,
  validateTeamBuildSubmission,
} from '../teambuild.js';
import type { Completion, Pid, Provider } from '../types.js';
import {
  analyzeBo3Adaptation,
  type Bo3AdaptationReport,
  buildNotebookTreatment,
  type NotebookTreatment,
  type NotebookTreatmentKind,
} from './bo3-adaptation.js';
import {
  controllerSetDigest,
  STRATEGIC_CONTROLLER_STAGES,
  type StrategicControllerIdentity,
  type StrategicControllerSet,
} from './controllers.js';
import type { DecisionNode } from './experiment-kernel.js';
import { buildMatchedForkPlan, type CommonForkDraw, type MatchedForkPlan } from './fork-plan.js';
import {
  buildFrozenMatchdayBetweenGameCheckpoint,
  type FrozenMatchdayActionContext,
  type FrozenMatchdayBetweenGameCheckpoint,
  type FrozenMatchdayCompletedSource,
  type FrozenMatchdayContinuationController,
  type FrozenMatchdayContinuationControllers,
  type FrozenMatchdayForkOutcome,
  type FrozenMatchdayNotebookContext,
  notebookTreatmentActionDigest,
  restoreFrozenMatchdayBetweenGameCheckpoint,
  runFrozenMatchdayNotebookFork,
} from './frozen-matchday-adapter.js';
import { canonicalJson, canonicalJsonDigest } from './serialization.js';
import {
  buildStrategicChoiceTask,
  extractFinalJsonObject,
  parseStrategicChoice,
  type StrategicChoiceTaskPackage,
} from './strategic-task.js';

export const FRONTIER_STRATEGIC_PILOT_PROTOCOL = {
  version: 3,
  source: 'deterministic-first-legal-completed-matchday-v1',
  treatment: 'model-written-game-one-private-notebook-v1',
  policy: 'bounded-frontier-decisions-then-first-legal-continuation-v2',
  response: 'final-json-object-tolerates-preceding-prose-v1',
  sampling: 'temperature-zero-no-provider-seed-balanced-arm-order-v1',
  history: 'bounded-full-authorized-continuation-pov-v1',
  taskIdentity: 'opportunity-and-authorized-state-digest-v1',
  outcomeActionIdentity: 'canonical-command-digest-v1',
  report: 'content-addressed-private-run-report-v1',
} as const;

const ACTION_SYSTEM = [
  'You are the focal decision policy in a controlled Pokémon VGC strategic intervention.',
  'Use only the authorized state, private notebook, open team sheets, and legal actions in the prompt.',
  'No interactive mechanics tools are available in this pilot.',
  'Optimize the probability of winning the complete series, not merely the current turn.',
  'Reason as deeply as needed, then end your reply with the exact JSON object requested by the task.',
].join('\n');

const NOTEBOOK_SYSTEM = [
  'You are writing private between-game memory for a controlled Pokémon VGC strategic intervention.',
  'Use only the authorized game-one evidence and open team sheets in the prompt.',
  'Record concrete opponent tendencies, revealed information, failed assumptions, and an actionable next-game plan.',
  'End your reply with one JSON object with exactly the key notebook as its final content.',
].join('\n');

export interface FrontierPilotOpenSet {
  species: string;
  item: string;
  ability: string;
  moves: string[];
}

export interface FrontierPilotSeatContext {
  pid: Pid;
  name: string;
  teamId: string;
  openSheet: FrontierPilotOpenSet[];
}

export interface FrontierPilotPublicContext {
  format: string;
  seats: Record<Pid, FrontierPilotSeatContext>;
  contextDigest: string;
}

export interface FrontierPilotSourceArtifact {
  protocolVersion: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.version;
  sourcePolicy: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.source;
  publicContext: FrontierPilotPublicContext;
  source: FrozenMatchdayCompletedSource;
  sourceArtifactDigest: string;
}

export type FrontierPilotCallKind = 'notebook-treatment' | 'battle-action';
export type FrontierPilotCallStatus = 'valid' | 'invalid' | 'provider-error';

export interface FrontierPilotCallTrace {
  protocolVersion: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.version;
  id: string;
  kind: FrontierPilotCallKind;
  modelSpec: string;
  reasoning: ReasoningLevel | null;
  systemDigest: string;
  prompt: string;
  promptDigest: string;
  task: StrategicChoiceTaskPackage | null;
  rawResponse: string | null;
  responseDigest: string | null;
  reasoningText: string | null;
  finishReason: string | null;
  usage: Record<string, number>;
  upstreamProvider: string | null;
  latencyMs: number;
  status: FrontierPilotCallStatus;
  diagnostic: string | null;
  parseMode: 'whole-response' | 'final-object' | null;
  selectedActionId: string | null;
  canonicalAction: string | null;
  callDigest: string;
}

export interface FrontierNotebookGenerationResult {
  status: 'valid' | 'invalid';
  treatment: NotebookTreatment | null;
  trace: FrontierPilotCallTrace;
}

export type FrontierPilotModelDecisionLimit = number | 'all';

export interface FrontierPilotModelConfig {
  modelSpec: string;
  reasoning: ReasoningLevel | null;
  reasoningMaxTokens: number | null;
  modelDecisionLimit: FrontierPilotModelDecisionLimit;
  downstreamPolicy: 'first-showdown-accepted-action-v1';
  maxTokens: number;
  timeoutSeconds: number;
  temperature: 0;
  providerSampling: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.sampling;
  configDigest: string;
}

export interface FrontierPilotExecutionOrder {
  index: number;
  drawId: string;
  armId: string;
  treatmentKind: NotebookTreatmentKind;
  outcomeExecutionDigest: string;
}

export interface FrontierPilotSummary {
  matchedPairs: number;
  validPairs: number;
  authenticMeanSeriesReturnDifference: number | null;
  authenticInvalidRate: number | null;
  withheldInvalidRate: number | null;
  protocolValidOutcomes: number;
  legalOutcomes: number;
  totalOutcomes: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reportedCost: number;
}

export interface FrontierStrategicPilotReport {
  protocolVersion: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.version;
  generatedAt: string;
  model: FrontierPilotModelConfig;
  focalPid: Pid;
  sourceArtifactDigest: string;
  checkpointDigest: string;
  plan: MatchedForkPlan;
  treatments: NotebookTreatment[];
  executionOrder: FrontierPilotExecutionOrder[];
  outcomes: FrozenMatchdayForkOutcome[];
  analysis: Bo3AdaptationReport;
  calls: FrontierPilotCallTrace[];
  summary: FrontierPilotSummary;
  interpretation: {
    unit: 'matched-source-cluster-pilot';
    uncertainty: 'one-source-cluster-no-ranking';
    providerRandomness: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.sampling;
  };
  reportDigest: string;
}

export interface FrontierPilotControllerOptions {
  modelSpec: string;
  provider: Provider;
  reasoning?: ReasoningLevel;
  reasoningMaxTokens?: number;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  maxTokens?: number;
  timeoutSeconds?: number;
  publicContext: FrontierPilotPublicContext;
  actionIdentitySalt?: string;
}

type TraceBase = Omit<FrontierPilotCallTrace, 'callDigest'>;

function traced(base: TraceBase): FrontierPilotCallTrace {
  return { ...base, callDigest: canonicalJsonDigest(base) };
}

function safeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'seat';
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function modelDecisionLimit(value: FrontierPilotModelDecisionLimit | undefined): FrontierPilotModelDecisionLimit {
  if (value === undefined) return 1;
  if (value === 'all') return value;
  return positiveInteger(value, 'modelDecisionLimit');
}

function completionFields(completion: Completion | null) {
  return {
    rawResponse: completion?.text ?? null,
    responseDigest: completion ? canonicalJsonDigest(completion.text) : null,
    reasoningText: completion?.reasoning?.trim() || null,
    finishReason: completion?.finishReason ?? null,
    usage: completion?.usage ? { ...completion.usage } : {},
    upstreamProvider: completion?.provider ?? null,
  };
}

function openSheet(packed: string): FrontierPilotOpenSet[] {
  const { Teams } = loadShowdown();
  const sets = Teams.unpack(packed);
  if (!sets) throw new Error('frontier pilot team must unpack');
  return sets.map((set) => ({
    species: String(set.species || set.name || ''),
    item: set.item ?? '',
    ability: set.ability ?? '',
    moves: [...set.moves],
  }));
}

function publicContext(input: {
  format: string;
  focal: { id: string; name: string; packed: string };
  opponent: { id: string; name: string; packed: string };
}): FrontierPilotPublicContext {
  const seats: Record<Pid, FrontierPilotSeatContext> = {
    p1: {
      pid: 'p1',
      name: input.focal.name,
      teamId: input.focal.id,
      openSheet: openSheet(input.focal.packed),
    },
    p2: {
      pid: 'p2',
      name: input.opponent.name,
      teamId: input.opponent.id,
      openSheet: openSheet(input.opponent.packed),
    },
  };
  const base = { format: input.format, seats };
  return { ...base, contextDigest: canonicalJsonDigest(base) };
}

export function acceptedFrontierPilotConstruction(input: {
  packed: string;
  seatId: string;
  format: string;
}): TeamBuildSubmissionValidation {
  const Showdown = loadShowdown();
  const unpacked = Showdown.Teams.unpack(input.packed);
  if (!unpacked) throw new Error('frontier pilot team must unpack');
  const prefix = safeId(input.seatId);
  const candidates = unpacked.map((set, index) => {
    const species = Showdown.Dex.species.get(set.species);
    const item = Showdown.Dex.items.get(set.item);
    const formeName = item.megaStone?.[species.name];
    const forme = formeName ? Showdown.Dex.species.get(formeName) : undefined;
    return {
      id: `${prefix}-${index}`,
      name: forme?.name ?? species.name,
      species: species.name,
      ...(forme ? { forme: forme.name, item: item.name } : {}),
      base: species.name,
      types: [...(forme ?? species).types],
    };
  });
  const task = {
    id: `${prefix}-frontier-pilot-construction`,
    model: `${prefix}-recorded-team`,
    format: input.format,
    sheetPolicy: 'open' as const,
    executionPolicy: 'strict' as const,
    constraint: {
      kind: 'frozen-candidate-pool' as const,
      id: `${prefix}-frontier-pilot-pool`,
      teamSize: 6,
      candidates,
    },
    objective: { kind: 'general' as const },
    notebook: '',
    provenance: { source: 'frontier-strategic-pilot-v1' },
  };
  const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
  const response = JSON.stringify({
    sets: unpacked.map((set, index) => ({
      id: candidates[index]?.id,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: Object.fromEntries(stats.map((stat) => [stat, set.evs?.[stat] ?? 0])),
      note: '',
    })),
  });
  const result = validateTeamBuildSubmission(task, response, {
    attempts: 1,
    createdAt: '2026-08-16T00:00:00.000Z',
  });
  if (result.status !== 'accepted') {
    throw new Error(`frontier pilot construction was rejected: ${canonicalJson(result)}`);
  }
  return result;
}

function seedWords(namespace: string, count: number): Array<[number, number, number, number]> {
  const random = seededRng(namespace);
  const word = () => 1 + Math.floor(random() * 0xffff);
  return Array.from({ length: count }, () => [word(), word(), word(), word()]);
}

export function buildFrontierPilotMatchday(input: {
  format: string;
  focal: { id: string; name?: string; packed: string };
  opponent: { id: string; name?: string; packed: string };
  seed: string | number;
  requireWinner?: boolean;
}): { options: FrozenMatchdayRefereeOptions; publicContext: FrontierPilotPublicContext } {
  const focal = { ...input.focal, name: input.focal.name ?? 'frontier-model' };
  const opponent = { ...input.opponent, name: input.opponent.name ?? 'fixed-opponent' };
  const seeds = seedWords(`${FRONTIER_STRATEGIC_PILOT_PROTOCOL.source}:${String(input.seed)}`, 3) as [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
  return {
    options: {
      format: input.format,
      gameSeeds: seeds,
      ...(input.requireWinner === false ? {} : { requireWinner: true }),
      seats: [
        {
          pid: 'p1',
          name: focal.name,
          construction: acceptedFrontierPilotConstruction({ packed: focal.packed, seatId: 'p1', format: input.format }),
        },
        {
          pid: 'p2',
          name: opponent.name,
          construction: acceptedFrontierPilotConstruction({
            packed: opponent.packed,
            seatId: 'p2',
            format: input.format,
          }),
        },
      ],
    },
    publicContext: publicContext({ format: input.format, focal, opponent }),
  };
}

export function completeFrontierPilotSource(input: {
  caseId: string;
  decisionNodeId?: string;
  options: FrozenMatchdayRefereeOptions;
  maxSubmissions?: number;
}): FrozenMatchdayCompletedSource {
  if (!input.caseId) throw new Error('frontier pilot source caseId must be non-empty');
  const referee = new FrozenMatchdayReferee(input.options);
  const maxSubmissions = positiveInteger(input.maxSubmissions ?? 5_000, 'maxSubmissions');
  let phase: FrozenMatchdayPhase = 'playing';
  let submissions = 0;
  while (phase !== 'terminal' && submissions < maxSubmissions) {
    if (phase === 'playing') {
      const observations = { p1: referee.observe('p1'), p2: referee.observe('p2') };
      let latest: FrozenMatchdaySubmissionResult | null = null;
      for (const pid of ['p1', 'p2'] as const) {
        const observation = observations[pid];
        if (!observation.battle?.request || observation.battle.request.wait) continue;
        const action = referee.legalActions(pid).actions[0];
        if (!action) throw new Error(`${pid} source policy found no accepted action`);
        latest = referee.submit(pid, action.command, observation.revision, observation.stateHash);
        submissions += 1;
      }
      if (!latest) throw new Error('frontier pilot source produced no pending battle action');
      phase = latest.phase;
      continue;
    }
    const state = referee.currentState();
    const first = referee.readyNextGame('p1', {}, state.revision, state.stateHash);
    submissions += 1;
    if (first.advanced) throw new Error('first source notebook acknowledgement advanced alone');
    const second = referee.readyNextGame('p2', {}, state.revision, state.stateHash);
    submissions += 1;
    phase = second.phase;
  }
  if (phase !== 'terminal') throw new Error(`frontier pilot source exceeded ${maxSubmissions} submissions`);
  const terminalEvidence = referee.terminalEvidence();
  if (!terminalEvidence) throw new Error('terminal frontier pilot source has no evidence');
  return {
    caseId: input.caseId,
    decisionNodeId: input.decisionNodeId ?? `${input.caseId}:after-game-1:notebook`,
    options: referee.acceptedOptions(),
    terminalEvidence,
    privateEvidence: {
      p1: referee.seatPrivateEvidence('p1'),
      p2: referee.seatPrivateEvidence('p2'),
    },
  };
}

export function buildFrontierPilotSourceArtifact(input: {
  publicContext: FrontierPilotPublicContext;
  source: FrozenMatchdayCompletedSource;
}): FrontierPilotSourceArtifact {
  const base = {
    protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
    sourcePolicy: FRONTIER_STRATEGIC_PILOT_PROTOCOL.source,
    publicContext: structuredClone(input.publicContext),
    source: structuredClone(input.source),
  };
  return { ...base, sourceArtifactDigest: canonicalJsonDigest(base) };
}

export function validateFrontierPilotSourceArtifact(artifact: FrontierPilotSourceArtifact): void {
  const { sourceArtifactDigest, ...base } = artifact;
  if (
    artifact.protocolVersion !== FRONTIER_STRATEGIC_PILOT_PROTOCOL.version ||
    artifact.sourcePolicy !== FRONTIER_STRATEGIC_PILOT_PROTOCOL.source ||
    canonicalJsonDigest(base) !== sourceArtifactDigest
  ) {
    throw new Error('frontier pilot source artifact digest does not match its contents');
  }
  const contextBase = { format: artifact.publicContext.format, seats: artifact.publicContext.seats };
  if (canonicalJsonDigest(contextBase) !== artifact.publicContext.contextDigest) {
    throw new Error('frontier pilot public context digest does not match its contents');
  }
  if (artifact.publicContext.format !== artifact.source.options.format) {
    throw new Error('frontier pilot public context format does not join its source');
  }
  for (const pid of ['p1', 'p2'] as const) {
    const sourceSeat = artifact.source.options.seats.find((seat) => seat.pid === pid);
    const contextSeat = artifact.publicContext.seats[pid];
    if (!sourceSeat || sourceSeat.name !== contextSeat.name || sourceSeat.construction.status !== 'accepted') {
      throw new Error(`frontier pilot public context does not join source seat ${pid}`);
    }
    const replayed = replayTeamBuildArtifact(sourceSeat.construction.artifact);
    if (canonicalJsonDigest(openSheet(replayed.packed)) !== canonicalJsonDigest(contextSeat.openSheet)) {
      throw new Error(`frontier pilot open sheet does not join source seat ${pid}`);
    }
  }
  buildFrozenMatchdayBetweenGameCheckpoint(artifact.source, 1);
}

export function frontierPilotProvider(modelSpec: string, reasoning?: ReasoningLevel): Provider {
  if (modelSpec === 'random') throw new Error('strategic frontier pilots require an actual provider model');
  return makeProvider(parseSpec(modelSpec), { reasoning });
}

export function frontierPilotModelConfig(input: {
  modelSpec: string;
  reasoning?: ReasoningLevel;
  reasoningMaxTokens?: number;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  maxTokens?: number;
  timeoutSeconds?: number;
}): FrontierPilotModelConfig {
  const maxTokens = positiveInteger(input.maxTokens ?? 8_192, 'maxTokens');
  const reasoningMaxTokens =
    input.reasoningMaxTokens === undefined ? null : positiveInteger(input.reasoningMaxTokens, 'reasoningMaxTokens');
  if (reasoningMaxTokens !== null && reasoningMaxTokens >= maxTokens) {
    throw new Error('reasoningMaxTokens must leave visible-text headroom below maxTokens');
  }
  const timeoutSeconds = positiveInteger(input.timeoutSeconds ?? 600, 'timeoutSeconds');
  const base = {
    modelSpec: input.modelSpec,
    reasoning: input.reasoning ?? null,
    reasoningMaxTokens,
    modelDecisionLimit: modelDecisionLimit(input.modelDecisionLimit),
    downstreamPolicy: 'first-showdown-accepted-action-v1' as const,
    maxTokens,
    timeoutSeconds,
    temperature: 0 as const,
    providerSampling: FRONTIER_STRATEGIC_PILOT_PROTOCOL.sampling,
  };
  return { ...base, configDigest: canonicalJsonDigest(base) };
}

function actionState(
  context: FrozenMatchdayActionContext,
  publicContextValue: FrontierPilotPublicContext,
  povHistory: readonly string[],
): string {
  const battle = context.observation.battle;
  const state = {
    objective: 'maximize complete-series win probability',
    format: publicContextValue.format,
    seat: context.pid,
    gameNumber: context.observation.gameNumber,
    score: context.observation.score,
    privateNotebook: context.currentNotebook,
    openTeamSheets: publicContextValue.seats,
    continuationBattleSummary: summarizeBattleEvents([...povHistory], context.pid),
    continuationRawPovLines: povHistory.slice(-800),
    currentRequest: battle?.request ?? null,
    stateHash: context.observation.stateHash,
  };
  return JSON.stringify(state, null, 2);
}

export class FrontierPilotActionController implements FrozenMatchdayContinuationController {
  private readonly model: FrontierPilotModelConfig;
  private readonly actionIdentitySalt: string;
  private readonly callTraces: FrontierPilotCallTrace[] = [];
  private readonly povHistory: string[] = [];
  private modelDecisions = 0;

  constructor(private readonly options: FrontierPilotControllerOptions) {
    this.model = frontierPilotModelConfig(options);
    this.actionIdentitySalt =
      options.actionIdentitySalt ?? canonicalJsonDigest(['frontier-pilot-action-identity-v1', this.model.configDigest]);
  }

  traces(): FrontierPilotCallTrace[] {
    return structuredClone(this.callTraces);
  }

  private remember(lines: readonly string[]): void {
    this.povHistory.push(...lines);
    if (this.povHistory.length > 2_000) this.povHistory.splice(0, this.povHistory.length - 2_000);
  }

  async decideAction(context: FrozenMatchdayActionContext) {
    this.remember(context.observation.povLines);
    if (context.legalActions.length === 1) {
      const selected = context.legalActions[0]!;
      return {
        command: selected.command,
        actionId: canonicalJsonDigest(['frontier-pilot-forced-action-v1', selected.command]),
      };
    }
    if (this.model.modelDecisionLimit !== 'all' && this.modelDecisions >= this.model.modelDecisionLimit) {
      const selected = context.legalActions[0]!;
      return {
        command: selected.command,
        actionId: canonicalJsonDigest([
          'frontier-pilot-declared-downstream-action-v1',
          this.model.downstreamPolicy,
          selected.command,
        ]),
      };
    }
    const opportunityId = canonicalJsonDigest([
      'frontier-pilot-opportunity-v1',
      context.draw.id,
      context.pid,
      context.decisionIndex,
      context.observation.gameNumber,
    ]);
    const state = actionState(context, this.options.publicContext, this.povHistory);
    const taskId = canonicalJsonDigest([
      FRONTIER_STRATEGIC_PILOT_PROTOCOL.taskIdentity,
      opportunityId,
      canonicalJsonDigest(state),
    ]);
    const task = buildStrategicChoiceTask({
      id: taskId,
      format: this.options.publicContext.format,
      phase: context.observation.battle?.request?.teamPreview ? 'team-preview' : 'battle-action',
      state,
      actions: context.legalActions.map((action) => ({ canonicalAction: action.command, label: action.label })),
      presentationSeed: opportunityId,
      actionIdentitySalt: this.actionIdentitySalt,
      forecastMode: 'action-only',
    });
    const started = Date.now();
    let completion: Completion;
    try {
      completion = await this.options.provider.complete(
        ACTION_SYSTEM,
        [{ role: 'user', content: task.public.prompt }],
        {
          maxTokens: this.model.maxTokens,
          ...(this.model.reasoningMaxTokens === null ? {} : { reasoningMaxTokens: this.model.reasoningMaxTokens }),
          timeout: this.model.timeoutSeconds,
          temperature: this.model.temperature,
          toolChoice: 'none',
        },
      );
    } catch (cause) {
      const failure = classifyProviderFailure(cause, this.model.modelSpec);
      const base: TraceBase = {
        protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
        id: taskId,
        kind: 'battle-action',
        modelSpec: this.model.modelSpec,
        reasoning: this.model.reasoning,
        systemDigest: canonicalJsonDigest(ACTION_SYSTEM),
        prompt: task.public.prompt,
        promptDigest: canonicalJsonDigest(task.public.prompt),
        task,
        ...completionFields(null),
        latencyMs: Date.now() - started,
        status: 'provider-error',
        diagnostic: failure.summary,
        parseMode: null,
        selectedActionId: null,
        canonicalAction: null,
      };
      this.callTraces.push(traced(base));
      throw new Error(failure.summary);
    }
    const parsed = parseStrategicChoice(completion.text, task.public);
    if (parsed.status === 'invalid') {
      const base: TraceBase = {
        protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
        id: taskId,
        kind: 'battle-action',
        modelSpec: this.model.modelSpec,
        reasoning: this.model.reasoning,
        systemDigest: canonicalJsonDigest(ACTION_SYSTEM),
        prompt: task.public.prompt,
        promptDigest: canonicalJsonDigest(task.public.prompt),
        task,
        ...completionFields(completion),
        latencyMs: Date.now() - started,
        status: 'invalid',
        diagnostic: parsed.reason,
        parseMode: null,
        selectedActionId: null,
        canonicalAction: null,
      };
      this.callTraces.push(traced(base));
      throw new Error(`frontier model returned invalid strategic JSON: ${parsed.reason}`);
    }
    const selected = task.private.actions.find((action) => action.actionId === parsed.actionId);
    if (!selected) throw new Error('frontier strategic task lost its private action join');
    const base: TraceBase = {
      protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
      id: taskId,
      kind: 'battle-action',
      modelSpec: this.model.modelSpec,
      reasoning: this.model.reasoning,
      systemDigest: canonicalJsonDigest(ACTION_SYSTEM),
      prompt: task.public.prompt,
      promptDigest: canonicalJsonDigest(task.public.prompt),
      task,
      ...completionFields(completion),
      latencyMs: Date.now() - started,
      status: 'valid',
      diagnostic: null,
      parseMode: parsed.parseMode,
      selectedActionId: parsed.actionId,
      canonicalAction: selected.canonicalAction,
    };
    this.callTraces.push(traced(base));
    this.modelDecisions += 1;
    return {
      command: selected.canonicalAction,
      actionId: canonicalJsonDigest([
        FRONTIER_STRATEGIC_PILOT_PROTOCOL.outcomeActionIdentity,
        selected.canonicalAction,
      ]),
    };
  }

  decideNotebook(context: FrozenMatchdayNotebookContext) {
    this.remember(context.observation.povLines);
    return {};
  }
}

function notebookPrompt(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  focalPid: Pid;
  publicContext: FrontierPilotPublicContext;
}): string {
  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint);
  const observation = referee.observe(input.focalPid);
  const privateEvidence = referee.seatPrivateEvidence(input.focalPid);
  const sourcePovLines = input.checkpoint.sourcePovLines[input.focalPid];
  return [
    'Write the private notebook that this seat will receive before the next game.',
    'The notebook may be detailed, but it must fit the 20,000-character frozen matchday limit.',
    'Return {"notebook":"..."} with no other keys.',
    'You may reason in text first, but end your reply with that JSON object as its final content.',
    '',
    JSON.stringify(
      {
        objective: 'maximize complete-series win probability',
        format: input.publicContext.format,
        focalSeat: input.focalPid,
        gameNumberCompleted: input.checkpoint.afterGame,
        score: observation.score,
        currentPrivateNotebook: privateEvidence.currentNotebook,
        openTeamSheets: input.publicContext.seats,
        gameSummary: summarizeBattleEvents(sourcePovLines, input.focalPid),
        rawPovLines: sourcePovLines.slice(-600),
      },
      null,
      2,
    ),
  ].join('\n');
}

function parsedNotebook(response: string): { notebook: string; parseMode: FrontierPilotCallTrace['parseMode'] } | null {
  const extracted = extractFinalJsonObject(response);
  if (typeof extracted === 'string') return null;
  const record = extracted.object;
  if (Object.keys(record).length !== 1 || typeof record.notebook !== 'string') return null;
  if (!record.notebook.trim() || record.notebook.length > FROZEN_MATCHDAY_NOTEBOOK_LIMIT) return null;
  return { notebook: record.notebook, parseMode: extracted.parseMode };
}

export async function generateFrontierAuthenticNotebook(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  focalPid: Pid;
  publicContext: FrontierPilotPublicContext;
  modelSpec: string;
  provider: Provider;
  reasoning?: ReasoningLevel;
  reasoningMaxTokens?: number;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  maxTokens?: number;
  timeoutSeconds?: number;
}): Promise<FrontierNotebookGenerationResult> {
  const model = frontierPilotModelConfig(input);
  const prompt = notebookPrompt(input);
  const id = canonicalJsonDigest([
    'frontier-pilot-notebook-v1',
    input.checkpoint.checkpointDigest,
    input.focalPid,
    model,
  ]);
  const started = Date.now();
  let completion: Completion;
  try {
    completion = await input.provider.complete(NOTEBOOK_SYSTEM, [{ role: 'user', content: prompt }], {
      maxTokens: model.maxTokens,
      ...(model.reasoningMaxTokens === null ? {} : { reasoningMaxTokens: model.reasoningMaxTokens }),
      timeout: model.timeoutSeconds,
      temperature: model.temperature,
      toolChoice: 'none',
    });
  } catch (cause) {
    const failure = classifyProviderFailure(cause, model.modelSpec);
    const trace = traced({
      protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
      id,
      kind: 'notebook-treatment',
      modelSpec: model.modelSpec,
      reasoning: model.reasoning,
      systemDigest: canonicalJsonDigest(NOTEBOOK_SYSTEM),
      prompt,
      promptDigest: canonicalJsonDigest(prompt),
      task: null,
      ...completionFields(null),
      latencyMs: Date.now() - started,
      status: 'provider-error',
      diagnostic: failure.summary,
      parseMode: null,
      selectedActionId: null,
      canonicalAction: null,
    });
    return { status: 'invalid', treatment: null, trace };
  }
  const parsedNotebookResult = parsedNotebook(completion.text);
  if (parsedNotebookResult === null) {
    const trace = traced({
      protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
      id,
      kind: 'notebook-treatment',
      modelSpec: model.modelSpec,
      reasoning: model.reasoning,
      systemDigest: canonicalJsonDigest(NOTEBOOK_SYSTEM),
      prompt,
      promptDigest: canonicalJsonDigest(prompt),
      task: null,
      ...completionFields(completion),
      latencyMs: Date.now() - started,
      status: 'invalid',
      diagnostic:
        'notebook response must end with one JSON object holding one non-empty notebook string within the limit',
      parseMode: null,
      selectedActionId: null,
      canonicalAction: null,
    });
    return { status: 'invalid', treatment: null, trace };
  }
  const trace = traced({
    protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
    id,
    kind: 'notebook-treatment',
    modelSpec: model.modelSpec,
    reasoning: model.reasoning,
    systemDigest: canonicalJsonDigest(NOTEBOOK_SYSTEM),
    prompt,
    promptDigest: canonicalJsonDigest(prompt),
    task: null,
    ...completionFields(completion),
    latencyMs: Date.now() - started,
    status: 'valid',
    diagnostic: null,
    parseMode: parsedNotebookResult.parseMode,
    selectedActionId: null,
    canonicalAction: null,
  });
  return {
    status: 'valid',
    treatment: buildNotebookTreatment({
      id: `authentic-${trace.callDigest.slice(0, 16)}`,
      kind: 'authentic',
      notebook: parsedNotebookResult.notebook,
      sourceDigest: trace.callDigest,
    }),
    trace,
  };
}

export function suppliedFrontierTreatment(input: {
  kind: Exclude<NotebookTreatmentKind, 'withheld'>;
  notebook: string;
  sourceLabel: string;
}): NotebookTreatment {
  if (!input.notebook.trim()) throw new Error(`${input.kind} treatment notebook must be non-empty`);
  return buildNotebookTreatment({
    id: `${input.kind}-${canonicalJsonDigest(input.notebook).slice(0, 16)}`,
    kind: input.kind,
    notebook: input.notebook,
    sourceDigest: canonicalJsonDigest(['frontier-pilot-supplied-treatment-v1', input.sourceLabel, input.notebook]),
  });
}

function controllerIdentity(
  stage: StrategicControllerIdentity['stage'],
  id: string,
  kind: StrategicControllerIdentity['kind'],
  config: unknown,
): StrategicControllerIdentity {
  return {
    id,
    stage,
    kind,
    revision: `frontier-strategic-pilot-v${FRONTIER_STRATEGIC_PILOT_PROTOCOL.version}`,
    configDigest: canonicalJsonDigest(config),
  };
}

export function frontierPilotControllerIdentities(input: {
  model: FrontierPilotModelConfig;
  focalPid: Pid;
}): StrategicControllerSet {
  const otherPid: Pid = input.focalPid === 'p1' ? 'p2' : 'p1';
  const battleConfig = {
    protocol: FRONTIER_STRATEGIC_PILOT_PROTOCOL,
    policy: FRONTIER_STRATEGIC_PILOT_PROTOCOL.policy,
    seats: {
      [input.focalPid]: { kind: 'model', configDigest: input.model.configDigest },
      [otherPid]: { kind: 'heuristic', revision: 'first-showdown-accepted-action-v1' },
    },
  };
  const identities = Object.fromEntries(
    STRATEGIC_CONTROLLER_STAGES.map((stage) => {
      if (stage === 'battle' || stage === 'preview') {
        return [stage, controllerIdentity(stage, 'frontier-model-vs-first-legal', 'population', battleConfig)];
      }
      if (stage === 'notebook') {
        return [
          stage,
          controllerIdentity(stage, 'retain-current-notebook', 'heuristic', {
            focal: 'treatment-bytes-then-retain',
            other: 'checkpoint-bytes-then-retain',
          }),
        ];
      }
      return [stage, controllerIdentity(stage, `source-${stage}`, 'recorded', { source: 'completed-source-prefix' })];
    }),
  ) as unknown as StrategicControllerSet;
  controllerSetDigest(identities);
  return identities;
}

function decisionNode(checkpoint: FrozenMatchdayBetweenGameCheckpoint, focalPid: Pid): DecisionNode {
  return {
    id: checkpoint.decisionNodeId,
    opportunityKey: `${checkpoint.caseId}:after-game-${checkpoint.afterGame}:${focalPid}`,
    stage: 'notebook',
    actor: focalPid,
    parentNodeId: null,
    sourceEpisodeDigest: checkpoint.sourceTerminalDigest,
    publicStateDigest: canonicalJsonDigest(checkpoint.sourcePovLines[focalPid]),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence[focalPid]),
    promptDigest: canonicalJsonDigest(['frontier-pilot-between-game-notebook-v3', checkpoint.afterGame]),
    legalActionDigest: canonicalJsonDigest(['full-notebook-replacement-or-withheld-v1']),
  };
}

export function frontierPilotDraws(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  count: number;
  seed: string | number;
}): CommonForkDraw[] {
  const count = positiveInteger(input.count, 'draw count');
  const namespace = canonicalJsonDigest([
    'frontier-pilot-common-draws-v1',
    input.checkpoint.checkpointDigest,
    String(input.seed),
  ]);
  return seedWords(namespace, count).map((battleSeed, index) => ({
    id: canonicalJsonDigest([namespace, index, battleSeed]),
    hiddenStateSeed: `${namespace}:realized-source-state`,
    opponentPolicySeed: `${namespace}:first-legal-opponent:${index}`,
    battleSeed,
    continuationSeed: `${namespace}:continuation:${index}`,
    scheduleSeed: `${namespace}:fixed-matchday-schedule:${index}`,
  }));
}

function firstLegalController(): FrozenMatchdayContinuationController {
  return {
    decideAction({ legalActions }) {
      const selected = legalActions[0];
      if (!selected) throw new Error('first-legal controller found no accepted action');
      return { command: selected.command, actionId: selected.command };
    },
    decideNotebook() {
      return {};
    },
  };
}

function treatmentArmId(treatment: NotebookTreatment): string {
  return `${treatment.kind}-${treatment.treatmentDigest.slice(0, 16)}`;
}

function rotated<T>(entries: readonly T[], offset: number): T[] {
  return entries.map((_, index) => entries[(index + offset) % entries.length] as T);
}

function reportSummary(
  analysis: Bo3AdaptationReport,
  outcomes: readonly FrozenMatchdayForkOutcome[],
  calls: readonly FrontierPilotCallTrace[],
): FrontierPilotSummary {
  const contrast = analysis.authenticVsWithheld;
  return {
    matchedPairs: contrast?.matchedPairs ?? 0,
    validPairs: contrast?.validPairs ?? 0,
    authenticMeanSeriesReturnDifference: contrast?.meanDifference ?? null,
    authenticInvalidRate: contrast?.treatmentInvalidRate ?? null,
    withheldInvalidRate: contrast?.controlInvalidRate ?? null,
    protocolValidOutcomes: outcomes.filter((outcome) => outcome.protocolValid).length,
    legalOutcomes: outcomes.filter((outcome) => outcome.actionLegal).length,
    totalOutcomes: outcomes.length,
    modelCalls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + (call.usage.input_tokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.usage.output_tokens ?? 0), 0),
    reasoningTokens: calls.reduce((sum, call) => sum + (call.usage.reasoning_tokens ?? 0), 0),
    reportedCost: calls.reduce((sum, call) => sum + (call.usage.cost ?? 0), 0),
  };
}

export async function runFrontierStrategicPilot(input: {
  sourceArtifact: FrontierPilotSourceArtifact;
  modelSpec: string;
  provider: Provider;
  authenticTreatment: NotebookTreatment;
  additionalTreatments?: readonly NotebookTreatment[];
  focalPid?: Pid;
  reasoning?: ReasoningLevel;
  reasoningMaxTokens?: number;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  drawCount?: number;
  drawSeed?: string | number;
  maxTokens?: number;
  timeoutSeconds?: number;
  maxDecisions?: number;
  notebookTrace?: FrontierPilotCallTrace;
  generatedAt?: string;
}): Promise<FrontierStrategicPilotReport> {
  validateFrontierPilotSourceArtifact(input.sourceArtifact);
  const focalPid = input.focalPid ?? 'p1';
  const model = frontierPilotModelConfig(input);
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(input.sourceArtifact.source, 1);
  if (input.authenticTreatment.kind !== 'authentic') {
    throw new Error('frontier pilot authenticTreatment must have kind authentic');
  }
  const treatments = [
    buildNotebookTreatment({ id: 'withheld', kind: 'withheld', notebook: '' }),
    input.authenticTreatment,
    ...(input.additionalTreatments ?? []),
  ];
  const kinds = new Set<NotebookTreatmentKind>();
  for (const treatment of treatments) {
    if (kinds.has(treatment.kind)) throw new Error(`frontier pilot repeats treatment kind ${treatment.kind}`);
    kinds.add(treatment.kind);
  }
  if (!kinds.has('authentic')) throw new Error('frontier pilot requires an authentic treatment');
  const identities = frontierPilotControllerIdentities({ model, focalPid });
  const controllerDigest = controllerSetDigest(identities);
  const draws = frontierPilotDraws({
    checkpoint,
    count: input.drawCount ?? 4,
    seed: input.drawSeed ?? 'frontier-pilot',
  });
  const plan = buildMatchedForkPlan({
    id: canonicalJsonDigest([
      'frontier-pilot-plan-v1',
      checkpoint.checkpointDigest,
      model.configDigest,
      treatments.map((treatment) => treatment.treatmentDigest),
      draws,
    ]),
    decisionNode: decisionNode(checkpoint, focalPid),
    utilityUnit: 'series-return',
    arms: treatments.map((treatment) => ({
      id: treatmentArmId(treatment),
      label: treatment.kind,
      replacementActionDigest: notebookTreatmentActionDigest(treatment),
      treatmentDigest: treatment.treatmentDigest,
      controllers: identities,
    })),
    draws,
  });
  const calls: FrontierPilotCallTrace[] = input.notebookTrace ? [structuredClone(input.notebookTrace)] : [];
  const outcomes: FrozenMatchdayForkOutcome[] = [];
  const executionOrder: FrontierPilotExecutionOrder[] = [];
  let executionIndex = 0;
  for (const [drawIndex, draw] of draws.entries()) {
    for (const treatment of rotated(treatments, drawIndex % treatments.length)) {
      const modelController = new FrontierPilotActionController({
        modelSpec: input.modelSpec,
        provider: input.provider,
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        ...(input.reasoningMaxTokens === undefined ? {} : { reasoningMaxTokens: input.reasoningMaxTokens }),
        modelDecisionLimit: model.modelDecisionLimit,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        publicContext: input.sourceArtifact.publicContext,
      });
      const otherController = firstLegalController();
      const controllers: FrozenMatchdayContinuationControllers = {
        controllerSetDigest: controllerDigest,
        seats:
          focalPid === 'p1'
            ? { p1: modelController, p2: otherController }
            : { p1: otherController, p2: modelController },
      };
      const armId = treatmentArmId(treatment);
      const outcome = await runFrozenMatchdayNotebookFork({
        checkpoint,
        plan,
        armId,
        drawId: draw.id,
        clusterId: input.sourceArtifact.source.caseId,
        focalPid,
        treatment,
        controllers,
        ...(input.maxDecisions === undefined ? {} : { maxDecisions: input.maxDecisions }),
      });
      outcomes.push(outcome);
      calls.push(...modelController.traces());
      executionOrder.push({
        index: executionIndex,
        drawId: draw.id,
        armId,
        treatmentKind: treatment.kind,
        outcomeExecutionDigest: outcome.executionDigest,
      });
      executionIndex += 1;
    }
  }
  const analysis = analyzeBo3Adaptation(outcomes);
  const base = {
    protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    model,
    focalPid,
    sourceArtifactDigest: input.sourceArtifact.sourceArtifactDigest,
    checkpointDigest: checkpoint.checkpointDigest,
    plan,
    treatments: structuredClone(treatments),
    executionOrder,
    outcomes,
    analysis,
    calls,
    summary: reportSummary(analysis, outcomes, calls),
    interpretation: {
      unit: 'matched-source-cluster-pilot' as const,
      uncertainty: 'one-source-cluster-no-ranking' as const,
      providerRandomness: FRONTIER_STRATEGIC_PILOT_PROTOCOL.sampling,
    },
  };
  return { ...base, reportDigest: canonicalJsonDigest(base) };
}

export const FRONTIER_PILOT_SENSITIVITY_POLICY = 'scripted-first-nonforced-action-then-first-legal-v1' as const;

export interface FrontierPilotSensitivitySample {
  armId: string;
  canonicalAction: string;
  drawId: string;
  utility: number;
}

export interface FrontierPilotSensitivityDraw {
  drawId: string;
  distinctUtilities: number;
  minUtility: number;
  maxUtility: number;
  bestActionShare: number;
}

export interface FrontierPilotSensitivityScreen {
  protocolVersion: typeof FRONTIER_STRATEGIC_PILOT_PROTOCOL.version;
  screenPolicy: typeof FRONTIER_PILOT_SENSITIVITY_POLICY;
  sourceArtifactDigest: string;
  checkpointDigest: string;
  planDigest: string | null;
  focalPid: Pid;
  drawSeed: string;
  actionSelection: 'all-legal' | 'operator-subset';
  candidateActionCount: number;
  evaluatedActionCount: number;
  drawCount: number;
  samples: FrontierPilotSensitivitySample[];
  draws: FrontierPilotSensitivityDraw[];
  sensitiveDrawCount: number;
  flat: boolean;
  screenDigest: string;
}

function scriptedControllerIdentities(input: { command: string; focalPid: Pid }): StrategicControllerSet {
  const otherPid: Pid = input.focalPid === 'p1' ? 'p2' : 'p1';
  const battleConfig = {
    protocol: FRONTIER_STRATEGIC_PILOT_PROTOCOL,
    policy: FRONTIER_PILOT_SENSITIVITY_POLICY,
    seats: {
      [input.focalPid]: { kind: 'scripted', command: input.command },
      [otherPid]: { kind: 'heuristic', revision: 'first-showdown-accepted-action-v1' },
    },
  };
  const identities = Object.fromEntries(
    STRATEGIC_CONTROLLER_STAGES.map((stage) => {
      if (stage === 'battle' || stage === 'preview') {
        return [stage, controllerIdentity(stage, 'scripted-action-vs-first-legal', 'heuristic', battleConfig)];
      }
      if (stage === 'notebook') {
        return [
          stage,
          controllerIdentity(stage, 'retain-current-notebook', 'heuristic', {
            focal: 'treatment-bytes-then-retain',
            other: 'checkpoint-bytes-then-retain',
          }),
        ];
      }
      return [stage, controllerIdentity(stage, `source-${stage}`, 'recorded', { source: 'completed-source-prefix' })];
    }),
  ) as unknown as StrategicControllerSet;
  controllerSetDigest(identities);
  return identities;
}

function scriptedFirstChoiceController(command: string): FrozenMatchdayContinuationController {
  let consumed = false;
  return {
    decideAction({ legalActions }) {
      if (!consumed && legalActions.length > 1) {
        consumed = true;
        const selected = legalActions.find((entry) => entry.command === command);
        if (!selected) throw new Error('sensitivity screen action left the accepted action set');
        return { command: selected.command, actionId: selected.command };
      }
      const first = legalActions[0];
      if (!first) throw new Error('sensitivity continuation found no accepted action');
      return { command: first.command, actionId: first.command };
    },
    decideNotebook() {
      return {};
    },
  };
}

function firstNonForcedFocalActions(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  draw: CommonForkDraw;
  focalPid: Pid;
  maxDecisions: number;
}): string[] {
  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint, input.draw);
  for (const pid of ['p1', 'p2'] as const) {
    const state = referee.currentState();
    referee.readyNextGame(pid, {}, state.revision, state.stateHash);
  }
  for (let steps = 0; steps < input.maxDecisions; steps += 1) {
    const observations = { p1: referee.observe('p1'), p2: referee.observe('p2') };
    for (const pid of ['p1', 'p2'] as const) {
      const observation = observations[pid];
      if (!observation.battle?.request || observation.battle.request.wait) continue;
      const legal = referee.legalActions(pid).actions;
      if (pid === input.focalPid && legal.length > 1) return legal.map((entry) => entry.command);
      const first = legal[0];
      if (!first) return [];
      const result = referee.submit(pid, first.command, observation.revision, observation.stateHash);
      if (result.terminal) return [];
    }
  }
  return [];
}

export function listFrontierPilotCandidateActions(input: {
  sourceArtifact: FrontierPilotSourceArtifact;
  focalPid?: Pid;
  drawSeed?: string | number;
  maxDecisions?: number;
}): string[] {
  validateFrontierPilotSourceArtifact(input.sourceArtifact);
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(input.sourceArtifact.source, 1);
  const draws = frontierPilotDraws({ checkpoint, count: 1, seed: input.drawSeed ?? 'frontier-pilot' });
  return firstNonForcedFocalActions({
    checkpoint,
    draw: draws[0] as CommonForkDraw,
    focalPid: input.focalPid ?? 'p1',
    maxDecisions: input.maxDecisions ?? 500,
  });
}

/** Outcome-blind and provider-free: usable at source-freeze time without touching treatment results. */
export async function screenFrontierPilotSourceSensitivity(input: {
  sourceArtifact: FrontierPilotSourceArtifact;
  focalPid?: Pid;
  drawCount?: number;
  drawSeed?: string | number;
  maxDecisions?: number;
  candidateActions?: readonly string[];
}): Promise<FrontierPilotSensitivityScreen> {
  validateFrontierPilotSourceArtifact(input.sourceArtifact);
  const focalPid = input.focalPid ?? 'p1';
  const maxDecisions = input.maxDecisions ?? 500;
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(input.sourceArtifact.source, 1);
  const draws = frontierPilotDraws({
    checkpoint,
    count: input.drawCount ?? 4,
    seed: input.drawSeed ?? 'frontier-pilot',
  });
  const firstDraw = draws[0];
  if (!firstDraw) throw new Error('sensitivity screen requires at least one draw');
  const legal = firstNonForcedFocalActions({ checkpoint, draw: firstDraw, focalPid, maxDecisions });
  let candidates = legal;
  if (input.candidateActions !== undefined) {
    const accepted = new Set(legal);
    for (const command of input.candidateActions) {
      if (!accepted.has(command)) {
        throw new Error(`sensitivity screen subset action ${JSON.stringify(command)} is not in the accepted set`);
      }
    }
    if (new Set(input.candidateActions).size !== input.candidateActions.length) {
      throw new Error('sensitivity screen subset repeats an action');
    }
    candidates = [...input.candidateActions];
  }
  const base = {
    protocolVersion: FRONTIER_STRATEGIC_PILOT_PROTOCOL.version,
    screenPolicy: FRONTIER_PILOT_SENSITIVITY_POLICY,
    sourceArtifactDigest: input.sourceArtifact.sourceArtifactDigest,
    checkpointDigest: checkpoint.checkpointDigest,
    focalPid,
    drawSeed: String(input.drawSeed ?? 'frontier-pilot'),
    actionSelection: (input.candidateActions === undefined ? 'all-legal' : 'operator-subset') as
      | 'all-legal'
      | 'operator-subset',
    candidateActionCount: legal.length,
    evaluatedActionCount: candidates.length,
    drawCount: draws.length,
  };
  if (candidates.length < 2) {
    const degenerate = {
      ...base,
      planDigest: null,
      samples: [] as FrontierPilotSensitivitySample[],
      draws: [] as FrontierPilotSensitivityDraw[],
      sensitiveDrawCount: 0,
      flat: true,
    };
    return { ...degenerate, screenDigest: canonicalJsonDigest(degenerate) };
  }
  const treatment = buildNotebookTreatment({ id: 'withheld', kind: 'withheld', notebook: '' });
  const arms = candidates.map((command) => ({
    id: `action-${canonicalJsonDigest(['frontier-pilot-sensitivity-action-v1', command]).slice(0, 16)}`,
    label: command,
    replacementActionDigest: notebookTreatmentActionDigest(treatment),
    treatmentDigest: treatment.treatmentDigest,
    controllers: scriptedControllerIdentities({ command, focalPid }),
  }));
  const plan = buildMatchedForkPlan({
    id: canonicalJsonDigest([
      'frontier-pilot-sensitivity-plan-v1',
      checkpoint.checkpointDigest,
      treatment.treatmentDigest,
      candidates,
      draws,
    ]),
    decisionNode: decisionNode(checkpoint, focalPid),
    utilityUnit: 'series-return',
    arms,
    draws,
    allowedControllerDifferences: ['battle', 'preview'],
  });
  const otherPid: Pid = focalPid === 'p1' ? 'p2' : 'p1';
  const samples: FrontierPilotSensitivitySample[] = [];
  for (const draw of draws) {
    for (const [index, arm] of arms.entries()) {
      const command = candidates[index] as string;
      const outcome = await runFrozenMatchdayNotebookFork({
        checkpoint,
        plan,
        armId: arm.id,
        drawId: draw.id,
        clusterId: input.sourceArtifact.source.caseId,
        focalPid,
        treatment,
        controllers: {
          controllerSetDigest: controllerSetDigest(arm.controllers),
          seats: {
            [focalPid]: scriptedFirstChoiceController(command),
            [otherPid]: firstLegalController(),
          } as FrozenMatchdayContinuationControllers['seats'],
        },
        maxDecisions,
      });
      if (!outcome.protocolValid || !outcome.actionLegal || outcome.utility === null) {
        throw new Error(
          `sensitivity screen cell failed for action ${JSON.stringify(command)}, draw ${draw.id}: ${outcome.diagnostic ?? 'no utility'}`,
        );
      }
      samples.push({ armId: arm.id, canonicalAction: command, drawId: draw.id, utility: outcome.utility });
    }
  }
  const drawSummaries: FrontierPilotSensitivityDraw[] = draws.map((draw) => {
    const utilities = samples.filter((sample) => sample.drawId === draw.id).map((sample) => sample.utility);
    const max = Math.max(...utilities);
    return {
      drawId: draw.id,
      distinctUtilities: new Set(utilities).size,
      minUtility: Math.min(...utilities),
      maxUtility: max,
      bestActionShare: utilities.filter((utility) => utility === max).length / utilities.length,
    };
  });
  const sensitiveDrawCount = drawSummaries.filter((entry) => entry.distinctUtilities > 1).length;
  const complete = {
    ...base,
    planDigest: plan.planDigest,
    samples,
    draws: drawSummaries,
    sensitiveDrawCount,
    flat: sensitiveDrawCount === 0,
  };
  return { ...complete, screenDigest: canonicalJsonDigest(complete) };
}
