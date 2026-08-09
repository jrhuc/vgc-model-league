import fs from 'node:fs';
import path from 'node:path';

import type { MenuHints, SlotMenu } from './choices.js';
import { buildMenus } from './choices.js';
import type { Rng } from './random.js';
import { seededRng } from './random.js';
import type {
  ActionSubmission,
  AgentContext,
  BattleAgent,
  BattleRequest,
  JsonObject,
  Pid,
  SubmissionContext,
  SubmissionOutcome,
  SubmissionSource,
} from './types.js';

export interface GameStart {
  gameId: string;
  gameNumber: number;
  seriesId: string;
  seriesScore?: Record<Pid, number>;
}

export interface GameEnd {
  outcome: JsonObject;
  gameNumber: number;
  seriesScore?: Record<Pid, number>;
}

export type DecisionLog = string | JsonObject[] | ((row: JsonObject) => void);

export interface ChoiceSubstitution {
  requested: number[];
  reason: string;
}

export abstract class BaseEngine implements BattleAgent {
  private submissionGameId = 'battle';
  private submissionGameNumber = 0;
  private submissionSeriesId: string | null = null;
  private activeSubmissionId: string | undefined;
  private submitted: ActionSubmission | undefined;
  private readonly pendingEvidence = new Map<string, JsonObject | null>();

  constructor(
    readonly pid: Pid,
    private readonly decisionLog?: DecisionLog,
  ) {}

  beginGame(context: GameStart): void {
    this.submissionGameId = context.gameId;
    this.submissionGameNumber = context.gameNumber;
    this.submissionSeriesId = context.seriesId;
    this.activeSubmissionId = undefined;
    this.submitted = undefined;
    this.pendingEvidence.clear();
  }
  endGame(_context: GameEnd): Promise<void> | void {}
  observe(_lines: string[]): void {}
  abandonDecision(): void {}
  decisionStats(): Record<string, number> {
    return {};
  }
  coachingNote(): string {
    return '';
  }

  async submit(request: BattleRequest, context: SubmissionContext): Promise<ActionSubmission | null> {
    this.submitted = undefined;
    this.activeSubmissionId = context.submissionId;
    try {
      const choice = await this.act(request, context);
      const submitted = this.submitted as ActionSubmission | undefined;
      return submitted?.choice === choice ? submitted : null;
    } finally {
      this.activeSubmissionId = undefined;
    }
  }

  async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const menus = buildMenus(request, this.menuHints(request));
    if (!menus.length) return '';
    /** Forfeit is always present on real turns, so it must not turn a single-option forced turn into a
     * model consultation; the concession option is only meaningful when there is also a real choice. */
    let automatic = menus.every((menu) => menu.filter((item) => item.kind !== 'forfeit').length === 1);
    let choices = automatic ? menus.map(() => 0) : await this.decideJoint(menus, request, context);
    let parts: string[];
    let substitution: ChoiceSubstitution | undefined;
    try {
      parts = BaseEngine.parts(menus, choices);
    } catch (caught) {
      substitution = { requested: choices, reason: caught instanceof Error ? caught.message : String(caught) };
      [choices, parts] = BaseEngine.defaults(menus);
      automatic = false;
    }
    const choice = parts.includes('forfeit')
      ? 'forfeit'
      : request.teamPreview
        ? `team ${parts.join('')}`
        : parts.join(', ');
    if (this.activeSubmissionId !== undefined) {
      const submission = this.newSubmission(choice, this.submissionSource(automatic, substitution));
      this.submitted = submission;
      this.actionSubmitted(request, context, menus, choices, parts, automatic, submission, substitution);
    }
    return choice;
  }

  resolveSubmission(submission: ActionSubmission, outcome: SubmissionOutcome, showdownError?: string): void {
    const held = this.pendingEvidence.get(submission.submissionId);
    const replayed = held === null && this.pendingEvidence.has(submission.submissionId);
    this.pendingEvidence.delete(submission.submissionId);
    if (replayed) return;
    this.writeLog(this.decisionLog, {
      ...(held ?? this.basicSubmissionRow(submission)),
      submission_id: submission.submissionId,
      submission_source: submission.source,
      outcome,
      ...(showdownError === undefined ? {} : { showdown_error: showdownError }),
    });
  }

  protected abstract decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> | number[];
  protected actionSubmitted(
    _request: BattleRequest,
    _context: AgentContext,
    _menus: SlotMenu[],
    _choices: number[],
    _parts: string[],
    _automatic: boolean,
    submission: ActionSubmission,
    _substitution?: ChoiceSubstitution,
  ): void {
    this.holdSubmissionEvidence(submission, this.basicSubmissionRow(submission));
  }
  protected submissionSource(automatic: boolean, substitution?: ChoiceSubstitution): SubmissionSource {
    return substitution ? 'model-default' : automatic ? 'automatic' : 'model';
  }
  protected restoreSubmission(submission: ActionSubmission): void {
    this.submitted = submission;
    this.pendingEvidence.set(submission.submissionId, null);
  }
  protected holdSubmissionEvidence(submission: ActionSubmission, row: JsonObject): void {
    this.pendingEvidence.set(submission.submissionId, row);
  }
  protected menuHints(_request: BattleRequest): MenuHints | undefined {
    return undefined;
  }

  private newSubmission(choice: string, source: SubmissionSource): ActionSubmission {
    if (this.activeSubmissionId === undefined) throw new Error('submissions require a simulator submission id');
    return { submissionId: this.activeSubmissionId, choice, source };
  }

  private basicSubmissionRow(submission: ActionSubmission): JsonObject {
    return {
      kind: 'decision',
      game_id: this.submissionGameId,
      series_id: this.submissionSeriesId,
      game_number: this.submissionGameNumber,
      pid: this.pid,
      action: submission.choice,
      automatic: submission.source === 'automatic',
      fallback: submission.source === 'model-default',
    };
  }

  protected writeLog(output: DecisionLog | undefined, row: JsonObject): void {
    if (!output) return;
    if (typeof output === 'function') output(row);
    else if (Array.isArray(output)) output.push(row);
    else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.appendFileSync(output, `${JSON.stringify(row)}\n`, 'utf8');
    }
  }

  static parts(menus: SlotMenu[], choices: number[]): string[] {
    if (choices.length !== menus.length) throw new Error(`choices must contain exactly ${menus.length} indices`);
    const parts: string[] = [];
    choices.forEach((choice, slot) => {
      const menu = menus[slot]!;
      if (!Number.isInteger(choice) || choice < 0 || choice >= menu.length)
        throw new Error(`choice for slot ${slot + 1} is outside its menu`);
      const item = menu[choice]!;
      if (!BaseEngine.remaining(menu, parts).includes(item)) {
        if (item.part.endsWith(' mega') && parts.some((part) => part.endsWith(' mega')))
          throw new Error(`slot ${slot + 1} also chose Mega Evolve; only one Pokémon can Mega Evolve per battle`);
        if (item.kind === 'switch')
          throw new Error(`slot ${slot + 1} switches to a Pokémon an earlier slot already switches to`);
        throw new Error(`choice for slot ${slot + 1} conflicts with an earlier slot`);
      }
      parts.push(item.part);
    });
    const forced = menus.flatMap((menu, index) => (menu.some((item) => item.kind === 'switch') ? [index] : []));
    if (forced.some((index) => parts[index] === 'pass')) {
      const replacements = new Set(
        forced.flatMap((index) => menus[index]!.filter((item) => item.kind === 'switch').map((item) => item.part)),
      );
      const allowed = Math.max(0, forced.length - replacements.size);
      if (forced.filter((index) => parts[index] === 'pass').length > allowed)
        throw new Error('cannot pass a forced switch while a replacement remains');
    }
    return parts;
  }

  static defaults(menus: SlotMenu[]): [number[], string[]] {
    const choices: number[] = [];
    const parts: string[] = [];
    for (const menu of menus) {
      const item = BaseEngine.remaining(menu, parts)[0];
      if (!item) {
        choices.push(-1);
        parts.push('pass');
      } else {
        choices.push(menu.indexOf(item));
        parts.push(item.part);
      }
    }
    return [choices, parts];
  }

  static remaining(menu: SlotMenu, chosen: string[]): SlotMenu {
    const switches = new Set(chosen.filter((part) => part.startsWith('switch ')));
    const selected = new Set(chosen);
    const mega = chosen.some((part) => part.endsWith(' mega'));
    return menu.filter(
      (item) =>
        !(item.kind === 'switch' && switches.has(item.part)) &&
        !(item.kind === 'team' && selected.has(item.part)) &&
        !(mega && item.part.endsWith(' mega')),
    );
  }
}

export class RandomEngine extends BaseEngine {
  private readonly random: Rng;

  constructor(pid: Pid, seed: string | number = Math.random(), decisionLog?: DecisionLog) {
    super(pid, decisionLog);
    this.random = seededRng(seed);
  }

  protected override submissionSource(automatic: boolean, substitution?: ChoiceSubstitution): SubmissionSource {
    return substitution ? 'model-default' : automatic ? 'automatic' : 'random';
  }

  protected decideJoint(menus: SlotMenu[]): number[] {
    const choices: number[] = [];
    const parts: string[] = [];
    for (const menu of menus) {
      const candidates = BaseEngine.remaining(menu, parts);
      if (!candidates.length) {
        choices.push(-1);
        parts.push('pass');
        continue;
      }
      const weights: number[] = candidates.map((item) =>
        item.kind === 'forfeit' ? 0 : item.part.endsWith(' mega') ? 0.25 : 1,
      );
      const target = this.random() * weights.reduce((sum, value) => sum + value, 0);
      let total = 0;
      let index = 0;
      while (index < weights.length - 1 && total + weights[index]! <= target) {
        total += weights[index]!;
        index += 1;
      }
      const item = candidates[index]!;
      choices.push(menu.indexOf(item));
      parts.push(item.part);
    }
    return choices;
  }
}
