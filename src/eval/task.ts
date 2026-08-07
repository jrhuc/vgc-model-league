import { defaultPsDir } from '../paths.js';
import { ShowdownReference } from '../reference.js';
import { BattleState } from '../state.js';
import type { BattleRequest, Pid } from '../types.js';
import { ACTION_PROTOCOL, type LegalActionEntry, legalActionEntries, requestPhase } from './fork.js';

export const POSITION_TASK_PROTOCOL = {
  version: 1,
  action: ACTION_PROTOCOL,
  prompt: 'position-prompt-v1',
  response: 'exact-json-choice-zero-based-v1',
  invalidOutputReward: -1,
  legalRewardRange: [0, 1],
} as const;

export interface PositionTaskAction {
  number: number;
  canonicalAction: string;
  label: string;
}

export interface CanonicalPositionTask {
  id: string;
  format: string;
  phase: 'team_preview' | 'forced_switch' | 'turn';
  turn: number;
  prompt: string;
  actions: PositionTaskAction[];
}

export interface RenderPositionTaskInput {
  id: string;
  format: string;
  pid: Pid;
  request: BattleRequest;
  seen: string[];
  psDir?: string;
  reference?: ShowdownReference;
}

function renderActions(actions: LegalActionEntry[]): string[] {
  return actions.map((entry) => `${entry.number}. ${entry.label}`);
}

export function renderPositionTask(input: RenderPositionTaskInput): CanonicalPositionTask {
  const reference = input.reference ?? new ShowdownReference(input.format, input.psDir ?? defaultPsDir());
  const state = new BattleState(input.pid);
  state.feed(input.seen);
  const renderedState = state.render(input.request, (mon) => reference.describeCompact(mon));
  const speed = input.request.teamPreview ? '' : state.renderEffectiveSpeeds(reference);
  const matchupSides = state.activeMatchupSides(reference);
  const matchups = reference.renderActiveMatchups(
    [...matchupSides.allies, ...matchupSides.foes],
    [...matchupSides.foes, ...matchupSides.allies],
    state.weather?.name ?? '',
  );
  const actions = legalActionEntries(input.request);
  if (!actions.length) throw new Error('position has no legal non-concession action');
  const lines = [
    'Choose one legal joint action for this controlled Pokemon VGC position.',
    'The action list is exhaustive. Select the number for the complete joint action, not one part of it.',
    '',
    renderedState,
  ];
  if (speed) lines.push('', speed);
  if (matchups.length) lines.push('', 'Active matchup reference:', ...matchups);
  lines.push(
    '',
    'LEGAL JOINT ACTIONS:',
    ...renderActions(actions),
    '',
    'Return exactly one JSON object {"choice":N}, where N is a zero-based action number above. Include no other keys or prose.',
  );
  return {
    id: input.id,
    format: input.format,
    phase: requestPhase(input.request),
    turn: state.turn,
    prompt: lines.join('\n'),
    actions: actions.map((entry) => ({
      number: entry.number,
      canonicalAction: entry.command,
      label: entry.label,
    })),
  };
}

export function parsePositionResponse(response: string, actions: readonly PositionTaskAction[]): PositionTaskAction {
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    throw new Error('response must be exactly one JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response must be one JSON object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'choice')) {
    throw new Error('response must contain only the choice field');
  }
  if (!Number.isInteger(record.choice)) throw new Error('choice must be an integer');
  const action = actions.find((entry) => entry.number === record.choice);
  if (!action) throw new Error('choice is outside the legal action map');
  return action;
}

export interface PositionScoreAction {
  number: number;
  canonicalAction: string;
  normalizedReward: number | null;
}

export function validateTaskScoreJoin(
  taskActions: readonly PositionTaskAction[],
  scoreActions: readonly PositionScoreAction[],
): void {
  if (taskActions.length !== scoreActions.length) throw new Error('task and score action counts differ');
  const taskKeys = new Set(taskActions.map((entry) => `${entry.number}\0${entry.canonicalAction}`));
  const scoreKeys = new Set(scoreActions.map((entry) => `${entry.number}\0${entry.canonicalAction}`));
  if (taskKeys.size !== taskActions.length || scoreKeys.size !== scoreActions.length) {
    throw new Error('task or score action map contains a duplicate');
  }
  if (taskKeys.size !== scoreKeys.size || [...taskKeys].some((entry) => !scoreKeys.has(entry))) {
    throw new Error('task and score action maps are not an exact numbered canonical join');
  }
  for (const entry of scoreActions) {
    if (
      entry.normalizedReward !== null &&
      (!Number.isFinite(entry.normalizedReward) || entry.normalizedReward < 0 || entry.normalizedReward > 1)
    ) {
      throw new Error('score action has an invalid normalized reward');
    }
  }
}

export interface PositionResponseScore {
  reward: number;
  validOutput: boolean;
  choice: number | null;
  canonicalAction: string | null;
  error: string | null;
}

export function scorePositionResponse(
  response: string,
  actions: readonly PositionTaskAction[],
  rewards: ReadonlyMap<string, number>,
): PositionResponseScore {
  try {
    const action = parsePositionResponse(response, actions);
    const reward = rewards.get(action.canonicalAction);
    if (reward === undefined || !Number.isFinite(reward) || reward < 0 || reward > 1) {
      throw new Error('score table does not contain a legal normalized reward');
    }
    return {
      reward,
      validOutput: true,
      choice: action.number,
      canonicalAction: action.canonicalAction,
      error: null,
    };
  } catch (error) {
    return {
      reward: POSITION_TASK_PROTOCOL.invalidOutputReward,
      validOutput: false,
      choice: null,
      canonicalAction: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
