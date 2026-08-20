import type { Pid } from '../types.js';
import { afterColon } from '../value.js';

export type BattleLogKind =
  | 'turn'
  | 'move'
  | 'switch'
  | 'faint'
  | 'status'
  | 'field'
  | 'win'
  | 'timer'
  | 'detail'
  | 'preview';

export interface BattleSlotRef {
  side: 0 | 1;
  slot: number;
}

/** Structured fields let a viewer rebuild field state (who is out, at what HP) without parsing the text. */
export interface BattleLogEntry {
  turn: number;
  kind: BattleLogKind;
  text: string;
  actor?: BattleSlotRef;
  target?: BattleSlotRef;
  species?: string;
  hp?: number;
  status?: string | null;
}

const MAX_ENTRIES = 400;

const STATUS_TEXT: Record<string, string> = {
  brn: 'was burned',
  par: 'was paralyzed',
  slp: 'fell asleep',
  frz: 'was frozen',
  psn: 'was poisoned',
  tox: 'was badly poisoned',
};

const TIMEOUT_TEXT: Record<string, string> = {
  autodefault: 'ran out of time. Default action used',
  forfeit: 'forfeited on time',
  tie: 'game ended on the timer',
};

function name(ident: string): string {
  return afterColon(ident) || ident;
}

function sideTag(ident: string): string {
  return ident.startsWith('p2') ? 'P2' : 'P1';
}

function species(details: string): string {
  return details.split(',', 1)[0]!.trim();
}

function hpNumber(hp: string): number | null {
  const [value] = hp.trim().split(/\s+/);
  if (!value || value === '0' || value.endsWith('fnt')) return 0;
  const match = /^(\d+)\/(\d+)/.exec(value);
  if (!match || !Number(match[2])) return null;
  return Math.max(0, Math.min(100, Math.round((Number(match[1]) * 100) / Number(match[2]))));
}

function hpPercent(hp: string): string {
  const value = hpNumber(hp);
  return value === null ? hp.trim().split(/\s+/)[0]! : `${value}%`;
}

function slotRef(ident: string): BattleSlotRef | undefined {
  const match = /^p([12])([a-d])?/.exec(ident.trim());
  if (!match) return undefined;
  return { side: match[1] === '2' ? 1 : 0, slot: match[2] ? match[2].charCodeAt(0) - 97 : 0 };
}

function statusOf(hp: string): string | null {
  const [, status] = hp.trim().split(/\s+/);
  return status && status !== 'fnt' ? status : null;
}

function prettyEffect(value: string): string {
  const effect = afterColon(value) || value;
  const match = /^perish(\d)$/i.exec(effect.replace(/[^a-z0-9]/gi, ''));
  return match ? `Perish ${match[1]}` : effect;
}

function fromSource(args: string[]): string {
  const from = args.find((arg) => arg.startsWith('[from]'));
  return from ? ` (${afterColon(from.slice(6).trim()) || from.slice(6).trim()})` : '';
}

export class BattleLog {
  readonly entries: BattleLogEntry[] = [];
  private turn = 0;
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  feed(lines: unknown): void {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (typeof line === 'string' && line.startsWith('|')) this.feedLine(line);
    }
  }

  private push(kind: BattleLogKind, text: string, extra: Partial<Record<keyof BattleLogEntry, unknown>> = {}): void {
    const entry: BattleLogEntry = { turn: this.turn, kind, text };
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) (entry as unknown as Record<string, unknown>)[key] = value;
    }
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  private feedLine(line: string): void {
    const [, kind = '', ...args] = line.split('|');
    if (kind === 'turn' && args[0]) {
      this.turn = Number(args[0]);
      this.push('turn', `Turn ${this.turn}`);
    } else if (kind === 'poke' && args.length >= 2) {
      this.push('preview', `${sideTag(args[0]!)} registers ${species(args[1]!)}`, {
        actor: slotRef(args[0]!),
        species: species(args[1]!),
      });
    } else if (kind === 'move' && args.length >= 2) {
      const target = args[2] && args[2] !== 'null' ? ` → ${name(args[2])}` : '';
      this.push('move', `${name(args[0]!)} used ${args[1]}${target}`, {
        actor: slotRef(args[0]!),
        target: args[2] && args[2] !== 'null' ? slotRef(args[2]) : undefined,
      });
    } else if (kind === 'switch' && args.length >= 2) {
      this.push('switch', `${sideTag(args[0]!)} sent out ${species(args[1]!)}`, {
        actor: slotRef(args[0]!),
        species: species(args[1]!),
        hp: args[2] ? (hpNumber(args[2]) ?? undefined) : undefined,
        status: args[2] ? statusOf(args[2]) : undefined,
      });
    } else if (kind === 'drag' && args.length >= 2) {
      this.push('switch', `${species(args[1]!)} was dragged in (${sideTag(args[0]!)})`, {
        actor: slotRef(args[0]!),
        species: species(args[1]!),
        hp: args[2] ? (hpNumber(args[2]) ?? undefined) : undefined,
        status: args[2] ? statusOf(args[2]) : undefined,
      });
    } else if (kind === 'replace' && args.length >= 2) {
      this.push('switch', `${name(args[0]!)} revealed as ${species(args[1]!)}`, {
        actor: slotRef(args[0]!),
        species: species(args[1]!),
      });
    } else if ((kind === 'detailschange' || kind === '-formechange') && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} became ${species(args[1]!)}`, {
        actor: slotRef(args[0]!),
        species: species(args[1]!),
      });
    } else if (kind === 'faint' && args[0]) {
      this.push('faint', `${name(args[0])} fainted`, { actor: slotRef(args[0]), hp: 0 });
    } else if (kind === 'cant' && args[0]) {
      const reason = args[1] ? ` (${afterColon(args[1]) || args[1]})` : '';
      this.push('detail', `${name(args[0])} can't move${reason}`);
    } else if (kind === '-damage' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} → ${hpPercent(args[1]!)}${fromSource(args)}`, {
        actor: slotRef(args[0]!),
        hp: hpNumber(args[1]!) ?? undefined,
        status: statusOf(args[1]!),
      });
    } else if (kind === '-heal' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} healed → ${hpPercent(args[1]!)}${fromSource(args)}`, {
        actor: slotRef(args[0]!),
        hp: hpNumber(args[1]!) ?? undefined,
        status: statusOf(args[1]!),
      });
    } else if (kind === '-status' && args.length >= 2) {
      this.push('status', `${name(args[0]!)} ${STATUS_TEXT[args[1]!] ?? args[1]}`, {
        actor: slotRef(args[0]!),
        status: args[1],
      });
    } else if (kind === '-curestatus' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} recovered from ${args[1]}`, { actor: slotRef(args[0]!), status: null });
    } else if ((kind === '-boost' || kind === '-unboost') && args.length >= 3) {
      const amount = Number(args[2]) * (kind === '-boost' ? 1 : -1);
      this.push('detail', `${name(args[0]!)} ${args[1]} ${amount > 0 ? '+' : ''}${amount}`);
    } else if ((kind === '-start' || kind === '-end') && args.length >= 2) {
      const effect = prettyEffect(args[1]!);
      this.push('detail', `${name(args[0]!)}: ${effect}${kind === '-end' ? ' ended' : ''}`);
    } else if (kind === '-fieldactivate' && args[0]) {
      this.push('field', `${afterColon(args[0])} activated`);
    } else if (kind === '-weather' && args[0] !== undefined && !args.includes('[upkeep]')) {
      this.push('field', !args[0] || args[0] === 'none' ? 'Weather cleared' : `Weather: ${afterColon(args[0])}`);
    } else if (kind === '-fieldstart' && args[0]) {
      this.push('field', `${afterColon(args[0])} began`);
    } else if (kind === '-fieldend' && args[0]) {
      this.push('field', `${afterColon(args[0])} ended`);
    } else if ((kind === '-sidestart' || kind === '-sideend') && args.length >= 2) {
      const side = args[0]!.startsWith('p2') ? 'P2' : 'P1';
      this.push('field', `${afterColon(args[1]!)} ${kind === '-sidestart' ? 'up' : 'ended'} on ${side}'s side`);
    } else if (kind === '-ability' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} ability: ${args[1]}`);
    } else if (kind === '-item' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} item: ${args[1]}`);
    } else if (kind === '-enditem' && args.length >= 2) {
      this.push('detail', `${name(args[0]!)} lost its ${args[1]}`);
    } else if (kind === '-crit' && args[0]) {
      this.push('detail', `Critical hit on ${name(args[0])}`);
    } else if (kind === '-supereffective' && args[0]) {
      this.push('detail', `Super effective on ${name(args[0])}`);
    } else if (kind === '-resisted' && args[0]) {
      this.push('detail', `Not very effective on ${name(args[0])}`);
    } else if (kind === '-immune' && args[0]) {
      this.push('detail', `${name(args[0])} is immune`);
    } else if (kind === '-miss' && args[0]) {
      this.push('detail', `${name(args[0])} missed`);
    } else if (kind === '-fail' && args[0]) {
      this.push('detail', `${name(args[0])}'s move failed`);
    } else if (kind === '-vgctimeout' && (args[0] === 'p1' || args[0] === 'p2')) {
      const pid = args[0] as Pid;
      this.push('timer', `${pid.toUpperCase()} ${TIMEOUT_TEXT[args[1] ?? ''] ?? 'timer event'}`);
    } else if (kind === 'win' && args[0]) {
      const match = /^p([12])-(.+)$/.exec(args[0]);
      this.push('win', `${match ? `${match[2]} (P${match[1]})` : args[0]} won the game`);
    } else if (kind === 'tie') {
      this.push('win', 'Game tied');
    }
  }
}
