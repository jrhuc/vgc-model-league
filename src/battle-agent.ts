import type { MenuHints, SlotMenu } from './choices.js';
import { buildMenus } from './choices.js';
import type { Rng } from './random.js';
import { seededRng } from './random.js';
import type { AgentContext, BattleAgent, BattleRequest, JsonObject, Pid } from './types.js';

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
  constructor(readonly pid: Pid) {}

  beginGame(_context: GameStart): void {}
  endGame(_context: GameEnd): Promise<void> | void {}
  observe(_lines: string[]): void {}
  abandonDecision(): void {}
  decisionStats(): Record<string, number> {
    return {};
  }
  coachingNote(): string {
    return '';
  }

  async act(request: BattleRequest, context: AgentContext): Promise<string> {
    const menus = buildMenus(request, this.menuHints(request));
    if (!menus.length) return '';
    let automatic = menus.every((menu) => menu.length === 1);
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
    this.actionCommitted(request, context, menus, choices, parts, automatic, substitution);
    return request.teamPreview ? `team ${parts.join('')}` : parts.join(', ');
  }

  protected abstract decideJoint(
    menus: SlotMenu[],
    request: BattleRequest,
    context: AgentContext,
  ): Promise<number[]> | number[];
  protected actionCommitted(
    _request: BattleRequest,
    _context: AgentContext,
    _menus: SlotMenu[],
    _choices: number[],
    _parts: string[],
    _automatic: boolean,
    _substitution?: ChoiceSubstitution,
  ): void {}
  protected menuHints(_request: BattleRequest): MenuHints | undefined {
    return undefined;
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

  constructor(pid: Pid, seed: string | number = Math.random()) {
    super(pid);
    this.random = seededRng(seed);
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
      const weights = candidates.map((item) => (item.part.endsWith(' mega') ? 0.25 : 1));
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
