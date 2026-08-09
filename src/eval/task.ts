import type { Battle } from 'pokemon-showdown';

import { defaultPsDir } from '../paths.js';
import { ShowdownReference } from '../reference.js';
import { BattleState } from '../state.js';
import type { BattleRequest, Pid } from '../types.js';
import {
  ACTION_PROTOCOL,
  acceptedBattleActionEntries,
  type LegalActionEntry,
  requestActionCandidateEntries,
  requestPhase,
} from './fork.js';

export const POSITION_TASK_PROTOCOL = {
  version: 2,
  action: ACTION_PROTOCOL,
  prompt: 'position-prompt-showdown-accepted-candidates-v2',
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
  battle: Battle;
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
  const authoritativeRequest = input.battle.getSide(input.pid).activeRequest as unknown as BattleRequest | null;
  if (!authoritativeRequest || authoritativeRequest.wait)
    throw new Error('position has no active authoritative request');
  const declaredCommands = requestActionCandidateEntries(input.request).map((entry) => entry.command);
  const authoritativeCommands = requestActionCandidateEntries(authoritativeRequest).map((entry) => entry.command);
  if (JSON.stringify(declaredCommands) !== JSON.stringify(authoritativeCommands)) {
    throw new Error('public request candidate map does not match the authoritative snapshot request');
  }
  const actions = acceptedBattleActionEntries(input.battle, input.pid);
  if (!actions.length) throw new Error('position has no Showdown-accepted request-derived non-concession action');
  const lines = [
    'Choose one listed joint action for this controlled Pokemon VGC position.',
    'Select the number for the complete joint action, not one part of it.',
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
  if (
    taskActions.some((entry, index) => entry.number !== index) ||
    scoreActions.some((entry, index) => entry.number !== index)
  ) {
    throw new Error('task and score action maps must use the same dense zero-based order');
  }
  if (
    taskActions.some((entry, index) => entry.canonicalAction !== scoreActions[index]?.canonicalAction) ||
    new Set(taskActions.map((entry) => entry.canonicalAction)).size !== taskActions.length
  ) {
    throw new Error('task and score action maps are not an exact ordered numbered canonical join');
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
