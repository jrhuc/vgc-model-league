import type { Pid } from '../types.js';

export type ErrorClass = 'mechanics-error' | 'failed-read' | 'unclassified';

export interface MoveEvent {
  pid: Pid;
  slot: string;
  move: string;
  turn: number;
  /** True when the move changed nothing for anybody: every target was immune, or it plainly failed. */
  wasted: boolean;
  immune: boolean;
  failed: boolean;
  cause: string | null;
  classification: ErrorClass | null;
}

const EFFECTIVE = [
  '|-damage|',
  '|-heal|',
  '|-status|',
  '|-boost|',
  '|-unboost|',
  '|-sidestart|',
  '|-fieldstart|',
  '|-fieldend|',
  '|-start|',
  '|-singleturn|',
  '|-weather|',
  '|-sethp|',
  '|-swapboost|',
  '|-clearboost|',
  '|-copyboost|',
  '|-invertboost|',
  '|-curestatus|',
  '|-cureteam|',
  '|-item|',
  '|-enditem|',
  '|-terastallize|',
  '|-transform|',
  '|-formechange|',
  '|detailschange|',
  '|-mega|',
  '|-end|',
  '|-sideend|',
  '|-activate|',
  '|-crit|',
  '|-hitcount|',
  '|faint|',
  '|-prepare|',
  '|-anim|',
  '|-message|',
  '|-combine|',
  '|-waiting|',
  '|-notarget|',
  '|-miss|',
  '|-ohko|',
  '|-zpower|',
  '|-mustrecharge|',
];

/** A move that whiffed on a coin flip is not a reasoning error, so accuracy outcomes never
 * reach the classifier — they land in EFFECTIVE purely to stop the move reading as wasted. */
const LUCK = ['|-miss|', '|-notarget|'];

const PROTECT_FAMILY = new Set([
  'Protect',
  'Detect',
  "King's Shield",
  'Baneful Bunker',
  'Spiky Shield',
  'Silk Trap',
  'Burning Bulwark',
  'Obstruct',
  'Max Guard',
  'Wide Guard',
  'Quick Guard',
  'Crafty Shield',
  'Mat Block',
]);

/** Fails that only a wrong guess about the opponent's action produces. The move was legal,
 * informed, and lost a bet — the class that only exists because there is an opponent. */
const READ_DEPENDENT = new Set([
  'Sucker Punch',
  'Thunderclap',
  'Upper Hand',
  'Encore',
  'Me First',
  'Snatch',
  'Magic Coat',
  'Last Resort',
  'Imprison',
]);

/** Fails the visible field, side and status state fully determine before the move is chosen. */
const STATE_DETERMINED = new Set([
  'Tailwind',
  'Light Screen',
  'Reflect',
  'Aurora Veil',
  'Safeguard',
  'Mist',
  'Lucky Chant',
  'Stealth Rock',
  'Spikes',
  'Toxic Spikes',
  'Sticky Web',
  'Recover',
  'Slack Off',
  'Roost',
  'Soft-Boiled',
  'Milk Drink',
  'Synthesis',
  'Moonlight',
  'Morning Sun',
  'Shore Up',
  'Heal Order',
  'Life Dew',
  'Jungle Healing',
  'Sunny Day',
  'Rain Dance',
  'Sandstorm',
  'Snowscape',
  'Chilly Reception',
  'Fake Out',
  'Taunt',
  'Sleep Powder',
  'Spore',
  'Hypnosis',
  'Lovely Kiss',
  'Sing',
  'Grass Whistle',
  'Dark Void',
  'Yawn',
  'Will-O-Wisp',
  'Thunder Wave',
  'Toxic',
  'Poison Powder',
  'Poison Gas',
  'Stun Spore',
  'Glare',
  'Substitute',
  'Belly Drum',
  'Trick Room',
  'Gravity',
  'Wonder Room',
  'Magic Room',
]);

function pidOf(slot: string): Pid | null {
  if (slot.startsWith('p1')) return 'p1';
  if (slot.startsWith('p2')) return 'p2';
  return null;
}

function classify(
  move: string,
  immune: boolean,
  failed: boolean,
): { cause: string; classification: ErrorClass } | null {
  if (immune) return { cause: 'immunity', classification: 'mechanics-error' };
  if (!failed) return null;
  if (PROTECT_FAMILY.has(move)) return { cause: 'protect-chain', classification: 'failed-read' };
  if (READ_DEPENDENT.has(move)) return { cause: 'read-dependent', classification: 'failed-read' };
  if (STATE_DETERMINED.has(move)) return { cause: 'state-determined', classification: 'mechanics-error' };
  return { cause: 'unknown-fail', classification: 'unclassified' };
}

/** Reads the simulator's own verdict rather than re-deriving it. Every `|-immune|` is provable
 * from information the format publishes: species types are public and open team sheets carry
 * abilities, so a move that hit nothing but an immunity was refuted by the prompt the model held. */
export function parseGameLog(lines: string[]): MoveEvent[] {
  const events: MoveEvent[] = [];
  let turn = 0;
  let current: MoveEvent | null = null;
  let sawEffect = false;

  const close = () => {
    if (!current) return;
    current.wasted = !sawEffect;
    const verdict = current.wasted ? classify(current.move, current.immune, current.failed) : null;
    current.cause = verdict?.cause ?? null;
    current.classification = verdict?.classification ?? null;
    events.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('|turn|')) {
      close();
      turn = Number(line.slice(6)) || turn;
      continue;
    }
    if (line.startsWith('|move|')) {
      close();
      const parts = line.split('|');
      const slot = parts[2] ?? '';
      const pid = pidOf(slot);
      if (!pid) continue;
      current = {
        pid,
        slot,
        move: parts[3] ?? '',
        turn,
        wasted: false,
        immune: false,
        failed: false,
        cause: null,
        classification: null,
      };
      sawEffect = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('|switch|') || line.startsWith('|drag|') || line.startsWith('|upkeep')) {
      close();
      continue;
    }
    if (line.startsWith('|-immune|')) {
      current.immune = true;
      continue;
    }
    if (line.startsWith('|-fail|')) {
      current.failed = true;
      continue;
    }
    if (LUCK.some((prefix) => line.startsWith(prefix))) {
      sawEffect = true;
      continue;
    }
    if (EFFECTIVE.some((prefix) => line.startsWith(prefix))) sawEffect = true;
  }
  close();
  return events;
}

export interface MechanicsTally {
  moves: number;
  mechanicsErrors: number;
  failedReads: number;
  unclassified: number;
  byCause: Record<string, number>;
  byMove: Record<string, number>;
}

export function tally(events: MoveEvent[]): MechanicsTally {
  const result: MechanicsTally = {
    moves: events.length,
    mechanicsErrors: 0,
    failedReads: 0,
    unclassified: 0,
    byCause: {},
    byMove: {},
  };
  for (const event of events) {
    if (!event.classification) continue;
    if (event.classification === 'mechanics-error') result.mechanicsErrors += 1;
    else if (event.classification === 'failed-read') result.failedReads += 1;
    else result.unclassified += 1;
    const cause = event.cause ?? 'unknown';
    result.byCause[cause] = (result.byCause[cause] ?? 0) + 1;
    if (event.classification === 'mechanics-error') {
      result.byMove[event.move] = (result.byMove[event.move] ?? 0) + 1;
    }
  }
  return result;
}
