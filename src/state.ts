import type { CompactMon, CompactMonReference, MatchupMon, ShowdownReference, SpeedProfile } from './reference.js';
import type { BattleRequest, JsonObject, Pid } from './types.js';

import { afterColon, asRecord, asRecords, asStrings, text } from './value.js';

interface MoveState {
  name: string;
  used: number;
  pp?: number;
  maxpp?: number;
}

export interface LastMove {
  name: string;
  target?: string;
  turn: number;
}

export interface TimedEffect {
  name: string;
  startedTurn: number;
  duration?: number;
}

export class MonState {
  species = 'Pokémon';
  hp: string | undefined;
  hpPercent: number | undefined;
  status: string | undefined;
  stats: Record<string, number> = {};
  boosts: Record<string, number> = {};
  volatiles = new Set<string>();
  moves = new Map<string, MoveState>();
  lastMove: LastMove | undefined;
  choiceLock: string | undefined;
  item: string | undefined;
  itemConsumed = false;
  ability: string | undefined;
  abilitySuppressed = false;
  nature: string | undefined;
  mega = false;
  fainted = false;
  preview = false;
  brought: boolean | undefined;
  formes = new Set<string>();
  /** Successful consecutive Protect-like stalls; 0 means next Protect is full odds. */
  protectSuccessStreak = 0;

  constructor(public ident: string) {}

  recordMove(name: string, used = 0): MoveState {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entry = this.moves.get(key) ?? { name, used: 0 };
    if (name.includes(' ')) entry.name = name;
    entry.used += used;
    this.moves.set(key, entry);
    return entry;
  }
}

export class SideState {
  mons = new Map<string, MonState>();
  active: Record<string, string> = {};
  conditions = new Map<string, TimedEffect>();
  sheet: MonState[] = [];
  showteam = false;
}

const STAT_LABELS: Record<string, string> = {
  atk: 'Attack',
  def: 'Defense',
  spa: 'Special Attack',
  spd: 'Special Defense',
  spe: 'Speed',
  accuracy: 'accuracy',
  evasion: 'evasion',
};

const CHOICE_ITEMS = new Set(['choiceband', 'choicescarf', 'choicespecs']);
const SCREEN_MOVES = new Set(['reflect', 'lightscreen', 'auroraveil']);

/** Side conditions the simulator expires on its own; anything absent (hazards) persists until removed
 * and must render without a timer. */
const TIMED_SIDE_CONDITIONS = new Map<string, number>([
  ['tailwind', 4],
  ['reflect', 5],
  ['lightscreen', 5],
  ['auroraveil', 5],
  ['safeguard', 5],
  ['mist', 5],
  ['luckychant', 5],
]);

const WEATHER_ROCKS: Record<string, string> = {
  raindance: 'damprock',
  sunnyday: 'heatrock',
  sandstorm: 'smoothrock',
  snow: 'icyrock',
  snowscape: 'icyrock',
  hail: 'icyrock',
};

export const PROTECT_MOVES = new Set([
  'protect',
  'detect',
  'banefulbunker',
  'spikyshield',
  'silktrap',
  'burningbulwark',
]);

export interface SideTimer {
  seconds: number | null;
  turnSeconds: number | null;
  at: number;
  running: boolean;
}

export class BattleState {
  turn = 0;
  /** True between a turn's residual phase and the next |turn| line: effects that
   * start there (faint-replacement switch-ins) tick their first upkeep a turn later. */
  private upkeepDone = false;
  weather: TimedEffect | undefined;
  fields = new Map<string, TimedEffect>();
  sides: Record<Pid, SideState> = { p1: new SideState(), p2: new SideState() };
  timers: Record<Pid, SideTimer | undefined> = { p1: undefined, p2: undefined };
  /** Wall-clock of the last |t:| line, so replaying a streamed log anchors
   * running timers to when thinking actually started, not parse time. */
  private logClockMs: number | undefined;

  constructor(readonly pid: Pid) {}

  feed(lines: unknown): void {
    if (!Array.isArray(lines)) return;
    for (const raw of lines) {
      if (
        typeof raw !== 'string' ||
        raw.startsWith('|uhtml|') ||
        raw.startsWith('|uhtmlchange|') ||
        raw.startsWith('|html|') ||
        raw.startsWith('|raw|')
      )
        continue;
      this.feedLine(raw);
    }
  }

  private feedLine(line: string): void {
    if (!line.startsWith('|')) return;
    const [, kind = '', ...args] = line.split('|');
    if (kind === 'turn' && args[0]) {
      this.turn = Number(args[0]);
      this.upkeepDone = false;
    } else if (kind === 'upkeep') this.upkeepDone = true;
    else if ((kind === 'switch' || kind === 'drag' || kind === 'replace') && args.length >= 3) {
      const mon = this.mon(args[0]!);
      this.setDetails(mon, args[1]!);
      this.setHp(mon, args[2]!);
      const [side, slot] = this.identParts(args[0]!);
      if (side) {
        if (kind !== 'replace') {
          mon.ability = undefined;
          mon.abilitySuppressed = false;
        }
        this.mergeSheetMon(mon, this.sides[side]);
        const previous = this.sides[side].active[slot];
        const previousMon = previous ? this.sides[side].mons.get(previous) : undefined;
        if (previousMon) {
          previousMon.boosts = {};
          previousMon.volatiles.clear();
          previousMon.choiceLock = undefined;
        }
        if (kind !== 'replace') {
          mon.boosts = {};
          mon.volatiles.clear();
          mon.protectSuccessStreak = 0;
          mon.choiceLock = undefined;
        }
        this.sides[side].active[slot] = this.monKey(args[0]!);
      }
    } else if (kind === 'detailschange' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      const previous = mon.species;
      this.setDetails(mon, args[1]!);
      if (this.speciesKey(previous) !== this.speciesKey(mon.species)) {
        mon.ability = undefined;
        mon.abilitySuppressed = false;
      }
    } else if (kind === 'poke' && args.length >= 2 && (args[0] === 'p1' || args[0] === 'p2')) {
      const species = args[1]!.split(',', 1)[0]!.trim();
      const mon = this.mon(`${args[0]}: ${species}`);
      this.setDetails(mon, args[1]!);
      mon.preview = true;
    } else if (kind === 'move' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.recordMove(args[1]!, 1);
      mon.lastMove = {
        name: args[1]!,
        ...(args[2] ? { target: args[2] } : {}),
        turn: this.turn,
      };
      if (!mon.itemConsumed && CHOICE_ITEMS.has(this.speciesKey(mon.item ?? ''))) mon.choiceLock = args[1]!;
      const moveId = this.speciesKey(args[1]!);
      if (!PROTECT_MOVES.has(moveId)) mon.protectSuccessStreak = 0;
    } else if (kind === '-singleturn' && args.length >= 2) {
      if (PROTECT_MOVES.has(this.speciesKey(this.effect(args[1]!)))) this.mon(args[0]!).protectSuccessStreak += 1;
    } else if (kind === '-fail' && args[0]) {
      const mon = this.mon(args[0]!);
      if (mon.lastMove && PROTECT_MOVES.has(this.speciesKey(mon.lastMove.name)) && mon.lastMove.turn === this.turn)
        mon.protectSuccessStreak = 0;
    } else if (kind === 'faint' && args[0]) {
      const mon = this.mon(args[0]);
      mon.hp = '0 fnt';
      mon.hpPercent = 0;
      mon.fainted = true;
      mon.boosts = {};
      mon.volatiles.clear();
    } else if ((kind === '-damage' || kind === '-heal') && args.length >= 2) this.setHp(this.mon(args[0]!), args[1]!);
    else if (kind === '-sethp') {
      for (let index = 0; index < args.length - 1; index += 2) {
        if (args[index]!.startsWith('p')) this.setHp(this.mon(args[index]!), args[index + 1]!);
      }
    } else if (kind === '-status' && args.length >= 2) this.mon(args[0]!).status = args[1];
    else if (kind === '-curestatus' && args[0]) this.mon(args[0]).status = undefined;
    else if ((kind === '-boost' || kind === '-unboost' || kind === '-setboost') && args.length >= 3) {
      const mon = this.mon(args[0]!);
      const stat = args[1]!;
      const amount = Number(args[2]);
      mon.boosts[stat] =
        kind === '-setboost' ? amount : (mon.boosts[stat] ?? 0) + (kind === '-boost' ? amount : -amount);
    } else if (kind === '-clearboost' && args[0]) this.mon(args[0]).boosts = {};
    else if (kind === '-clearallboost') {
      for (const side of Object.values(this.sides)) for (const mon of side.mons.values()) mon.boosts = {};
    } else if (kind === '-clearnegativeboost' && args[0]) {
      const mon = this.mon(args[0]);
      mon.boosts = Object.fromEntries(Object.entries(mon.boosts).filter(([, value]) => value > 0));
    } else if ((kind === '-start' || kind === '-end') && args.length >= 2) {
      const mon = this.mon(args[0]!);
      const effect = this.effect(args[1]!);
      if (kind === '-start') {
        if (/^perish\d$/.test(this.speciesKey(effect))) {
          for (const volatile of mon.volatiles) {
            if (/^perish\d$/.test(this.speciesKey(volatile))) mon.volatiles.delete(volatile);
          }
        }
        mon.volatiles.add(effect);
      } else mon.volatiles.delete(effect);
    } else if (kind === '-weather' && args[0] !== undefined) {
      if (args[0] === 'none' || !args[0]) this.weather = undefined;
      else if (
        !args.includes('[upkeep]') ||
        !this.weather ||
        this.speciesKey(this.weather.name) !== this.speciesKey(args[0])
      ) {
        const name = this.effect(args[0]);
        const rock = WEATHER_ROCKS[this.speciesKey(name)];
        const setter = this.effectSource(args) ?? this.lastMoveUserThisTurn(this.speciesKey(name));
        const extended = rock !== undefined && setter?.item !== undefined && this.speciesKey(setter.item) === rock;
        this.weather = { name, startedTurn: this.effectStartTurn(), duration: extended ? 8 : 5 };
      }
    } else if (kind === '-fieldstart' && args[0]) {
      const name = this.effect(args[0]);
      this.fields.set(this.speciesKey(name), { name, startedTurn: this.effectStartTurn(), duration: 5 });
    } else if (kind === '-fieldend' && args[0]) this.fields.delete(this.speciesKey(this.effect(args[0]!)));
    else if ((kind === '-sidestart' || kind === '-sideend') && args.length >= 2) {
      const side = args[0]!.split(':')[0]!;
      if (side === 'p1' || side === 'p2') {
        const effect = this.effect(args[1]!);
        const key = this.speciesKey(effect);
        if (kind === '-sidestart') {
          let duration = TIMED_SIDE_CONDITIONS.get(key);
          if (SCREEN_MOVES.has(key)) {
            const setter =
              this.lastMoveUserThisTurn(key, side) ??
              [...this.sides[side].mons.values()].find((mon) => mon.item && this.speciesKey(mon.item) === 'lightclay');
            if (setter?.item && this.speciesKey(setter.item) === 'lightclay') duration = 8;
          }
          this.sides[side].conditions.set(key, {
            name: effect,
            startedTurn: Math.max(1, this.turn),
            ...(duration === undefined ? {} : { duration }),
          });
        } else this.sides[side].conditions.delete(key);
      }
    } else if (kind === '-item' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.item = args[1];
      mon.itemConsumed = false;
      mon.choiceLock = undefined;
    } else if (kind === '-enditem' && args[0]) {
      const mon = this.mon(args[0]);
      if (args[1]) mon.item = args[1];
      mon.itemConsumed = true;
      mon.choiceLock = undefined;
    } else if (kind === '-ability' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.ability = args[1];
      mon.abilitySuppressed = false;
    } else if (kind === '-endability' && args[0]) {
      const mon = this.mon(args[0]);
      mon.ability = undefined;
      mon.abilitySuppressed = true;
    } else if (kind === '-mega' && args[0]) {
      const mon = this.mon(args[0]);
      mon.mega = true;
      mon.ability = undefined;
      mon.abilitySuppressed = false;
    } else if (kind === '-formechange' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.species = args[1]!;
      mon.formes.add(this.speciesKey(args[1]!));
      mon.ability = undefined;
      mon.abilitySuppressed = false;
    } else if (kind === 'showteam' && args.length >= 2) this.showTeam(args[0]!, args.slice(1).join('|'));
    else if (kind === 't:' && Number.isFinite(Number(args[0]))) this.logClockMs = Number(args[0]) * 1000;
    else if (kind === '-vgctimer' && (args[0] === 'p1' || args[0] === 'p2')) {
      const parse = (value: string | undefined) => (value && Number.isFinite(Number(value)) ? Number(value) : null);
      this.timers[args[0]] = {
        seconds: parse(args[1]),
        turnSeconds: parse(args[2]),
        at: this.logClockMs ?? Date.now(),
        running: true,
      };
    } else if (kind === '-vgcdeciding' && (args[0] === 'p1' || args[0] === 'p2')) {
      this.timers[args[0]] = { seconds: null, turnSeconds: null, at: this.logClockMs ?? Date.now(), running: true };
    } else if ((kind === '-vgctimerstop' || kind === '-vgctimeout') && (args[0] === 'p1' || args[0] === 'p2')) {
      this.stopTimer(args[0]);
    } else if (kind === 'win' || kind === 'tie') {
      this.stopTimer('p1');
      this.stopTimer('p2');
    }
  }

  render(request: BattleRequest, referenceFor?: (mon: CompactMon) => CompactMonReference | undefined): string {
    this.updateOwnRequest(request);
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    return [
      `Turn: ${this.turn}`,
      `Weather: ${this.weatherLabel()}`,
      `Field: ${this.fieldLabels().join(', ') || 'none'}`,
      ...this.renderSide(this.pid, true, request.teamPreview === true, referenceFor),
      ...this.renderSide(foe, false, request.teamPreview === true, referenceFor),
    ].join('\n');
  }

  slotName(slot: number, request: BattleRequest): string {
    if (request.teamPreview) return `team preview pick ${slot + 1}`;
    const key = this.sides[this.pid].active[String.fromCharCode('a'.charCodeAt(0) + slot)];
    const mon = key ? this.sides[this.pid].mons.get(key) : undefined;
    if (mon) return mon.species;
    const active = (request.side?.pokemon ?? []).filter((item) => item.active);
    return active[slot] ? BattleState.requestName(active[slot]) : 'Pokémon';
  }

  compactMons(): CompactMon[] {
    const out: CompactMon[] = [];
    for (const pid of ['p1', 'p2'] as const) {
      const side = this.sides[pid];
      const own = pid === this.pid;
      const activeKeys = new Set(Object.values(side.active));
      const mons = [...side.mons.values()].filter((mon) => {
        if (mon.fainted) return false;
        if (own && mon.brought === false) return false;
        if (activeKeys.has(this.monKey(mon.ident))) return true;
        if (own) return mon.brought !== false;
        return Boolean(mon.hp !== undefined || mon.moves.size || side.showteam);
      });
      if (!own && side.showteam) {
        const known = new Set(mons.map((mon) => this.speciesKey(mon.species)));
        for (const sheetMon of side.sheet) {
          if (!known.has(this.speciesKey(sheetMon.species))) mons.push(sheetMon);
        }
      }
      for (const mon of mons) {
        out.push({
          species: mon.species,
          item: mon.item ?? null,
          nature: mon.nature ?? null,
          moves: [...mon.moves.values()].map((move) => move.name),
          active: activeKeys.has(this.monKey(mon.ident)),
        });
      }
    }
    return out;
  }

  protectReducedSlots(): Record<number, boolean> {
    const reduced: Record<number, boolean> = {};
    const side = this.sides[this.pid];
    for (const [number, slot] of [
      [1, 'a'],
      [2, 'b'],
    ] as const) {
      const key = side.active[slot];
      const mon = key ? side.mons.get(key) : undefined;
      if (mon && !mon.fainted && mon.protectSuccessStreak > 0) reduced[number] = true;
    }
    return reduced;
  }

  activeMatchupSides(reference?: ShowdownReference): { allies: MatchupMon[]; foes: MatchupMon[] } {
    const collect = (pid: Pid, ally: boolean): MatchupMon[] => {
      const side = this.sides[pid];
      return (['a', 'b'] as const).flatMap((slot) => {
        const key = side.active[slot];
        const mon = key ? side.mons.get(key) : undefined;
        if (!mon || mon.fainted) return [];
        const ability = mon.abilitySuppressed ? undefined : (mon.ability ?? reference?.speciesAbility(mon.species));
        return [
          {
            species: mon.species,
            moves: [...mon.moves.values()].map((move) => move.name),
            ally,
            ...(ability === undefined ? {} : { ability }),
            ...(mon.item === undefined ? {} : { item: mon.item }),
            itemConsumed: mon.itemConsumed,
          },
        ];
      });
    };
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    return { allies: collect(this.pid, true), foes: collect(foe, false) };
  }

  renderEffectiveSpeeds(reference: ShowdownReference): string {
    const entries = this.activeEntries().flatMap((entry) => {
      const profile = this.speedProfile(entry.pid, entry.mon, reference);
      if (!profile) return [];
      const role = entry.pid === this.pid ? 'your' : 'foe';
      const effective = this.formatRange(profile.effective);
      const modifiers = profile.modifiers.length ? ` (${profile.modifiers.join(', ')})` : '';
      return [`${role} ${entry.mon.species} ${effective}${modifiers}`];
    });
    if (!entries.length) return '';
    const trickRoom = this.fields.has('trickroom') ? ' Trick Room reverses order within equal priority.' : '';
    return `Effective Speed before move priority (foe values preserve hidden EV ranges): ${entries.join('; ')}.${trickRoom}`;
  }

  moveAnnotation(moveName: string, targetSide: 'foe' | 'ally', targetNumber: number): string | undefined {
    if (this.speciesKey(moveName) !== 'encore') return undefined;
    const pid = targetSide === 'ally' ? this.pid : this.pid === 'p1' ? 'p2' : 'p1';
    const target = this.activeEntry(pid, targetNumber);
    if (!target) return undefined;
    if ([...target.volatiles].some((volatile) => this.speciesKey(volatile) === 'encore'))
      return 'fails: target already Encored';
    if (target.choiceLock) return `redundant: target is Choice-locked into ${target.choiceLock}`;
    return undefined;
  }

  compareActionOrder(args: Record<string, unknown>, reference: ShowdownReference): string {
    const firstName = typeof args.first === 'string' ? args.first.trim() : '';
    const secondName = typeof args.second === 'string' ? args.second.trim() : '';
    if (!firstName || !secondName) return 'first and second are required active Pokémon names or ally/foe slot labels.';
    const first = this.findMon(firstName);
    const second = this.findMon(secondName);
    const active = this.activeEntries().map(
      (entry) => `${entry.pid === this.pid ? 'ally' : 'foe'} ${entry.slot}: ${entry.mon.species}`,
    );
    if (!first || !second)
      return `Could not resolve ${!first ? JSON.stringify(firstName) : JSON.stringify(secondName)}. Active Pokémon: ${active.join('; ') || 'none'}; benched Pokémon may be named directly.`;
    if (first.mon === second.mon) return 'first and second must identify different Pokémon.';

    const firstProfile = this.speedProfile(first.pid, first.mon, reference);
    const secondProfile = this.speedProfile(second.pid, second.mon, reference);
    if (!firstProfile || !secondProfile) return 'Speed data is unavailable for one of the selected Pokémon.';
    const firstMove = typeof args.first_move === 'string' ? args.first_move.trim() : '';
    const secondMove = typeof args.second_move === 'string' ? args.second_move.trim() : '';
    const switchKeys = new Set(['switch', 'switchout', 'switching', 'swap']);
    const firstIsSwitch = switchKeys.has(this.speciesKey(firstMove));
    const secondIsSwitch = switchKeys.has(this.speciesKey(secondMove));
    const grassyTerrain = [...this.fields.values()].some((effect) => /grassy/i.test(effect.name));
    const contextFor = (mon: MonState) => ({
      ...(mon.ability === undefined ? {} : { ability: mon.ability }),
      ...(mon.item === undefined ? {} : { item: mon.item }),
      itemConsumed: mon.itemConsumed,
      ...(mon.hpPercent === undefined ? {} : { fullHp: mon.hpPercent >= 99.5 }),
      grassyTerrain,
    });
    const emptyInfo: { priority: number; notes: string[]; unresolved?: string } = { priority: 0, notes: [] };
    const firstInfo =
      firstMove && !firstIsSwitch ? reference.priorityProfile(firstMove, contextFor(first.mon)) : emptyInfo;
    const secondInfo =
      secondMove && !secondIsSwitch ? reference.priorityProfile(secondMove, contextFor(second.mon)) : emptyInfo;
    if (!firstInfo) return `No move data for ${JSON.stringify(firstMove)}.`;
    if (!secondInfo) return `No move data for ${JSON.stringify(secondMove)}.`;
    const firstPriority = firstInfo.priority;
    const secondPriority = secondInfo.priority;

    const trickRoom = this.fields.has('trickroom');
    const bracketLast = (info: { notes: string[] }) =>
      info.notes.some((note) => note.includes('acts last within its bracket'));
    const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`;
    let order: 'first' | 'second' | 'tie' | 'uncertain';
    let reason: string;
    if (firstIsSwitch !== secondIsSwitch) {
      order = firstIsSwitch ? 'first' : 'second';
      reason = 'switches resolve before moves';
    } else if (firstIsSwitch && secondIsSwitch) {
      order = this.speedOrder(firstProfile, secondProfile, trickRoom);
      reason = trickRoom
        ? 'both switching; switch order follows Speed under Trick Room'
        : 'both switching; switch order follows Speed';
    } else if (firstInfo.unresolved || secondInfo.unresolved) {
      order = 'uncertain';
      reason = [firstInfo.unresolved, secondInfo.unresolved].filter(Boolean).join('; ');
    } else if (firstPriority !== secondPriority) {
      order = firstPriority > secondPriority ? 'first' : 'second';
      reason = `move priority ${signed(firstPriority)} vs ${signed(secondPriority)}`;
    } else if (bracketLast(firstInfo) !== bracketLast(secondInfo)) {
      order = bracketLast(firstInfo) ? 'second' : 'first';
      reason = [...firstInfo.notes, ...secondInfo.notes].find((note) => note.includes('acts last within its bracket'))!;
    } else {
      order = this.speedOrder(firstProfile, secondProfile, trickRoom);
      reason = trickRoom ? 'equal priority under Trick Room' : 'equal priority';
    }
    const quickClaw = (info: { notes: string[] }) => info.notes.some((note) => note.startsWith('Quick Claw'));
    const sameBracket = !firstIsSwitch && !secondIsSwitch && firstPriority === secondPriority;
    const orderText =
      order === 'first'
        ? sameBracket && quickClaw(secondInfo)
          ? `${first.mon.species} acts first unless ${second.mon.species}'s Quick Claw triggers (20%)`
          : `${first.mon.species} is guaranteed to act first`
        : order === 'second'
          ? sameBracket && quickClaw(firstInfo)
            ? `${second.mon.species} acts first unless ${first.mon.species}'s Quick Claw triggers (20%)`
            : `${second.mon.species} is guaranteed to act first`
          : order === 'tie'
            ? 'The Pokémon speed-tie'
            : 'Their order is uncertain across the legal hidden Speed range';
    const describe = (name: string, profile: SpeedProfile) => {
      const raw = this.formatRange(profile.raw);
      const effective = this.formatRange(profile.effective);
      return `${name}: raw Speed ${raw}; effective Speed ${effective}${
        profile.modifiers.length ? ` (${profile.modifiers.join(', ')})` : ''
      }`;
    };
    const lines = [
      describe(`${first.mon.species}${first.benched ? ' (benched)' : ''}`, firstProfile),
      describe(`${second.mon.species}${second.benched ? ' (benched)' : ''}`, secondProfile),
      `${orderText} (${reason}).`,
    ];
    const notes = [
      ...firstInfo.notes.map((note) => `${first.mon.species}: ${note}`),
      ...secondInfo.notes.map((note) => `${second.mon.species}: ${note}`),
    ];
    if (notes.length) lines.push(`Priority modifiers applied: ${notes.join('; ')}.`);
    if (first.benched || second.benched)
      lines.push('Benched Pokémon are compared as if already on the field (entry boosts not included).');
    if (this.speciesKey(firstMove) === 'encore') {
      const alreadyEncored = [...second.mon.volatiles].some((volatile) => this.speciesKey(volatile) === 'encore');
      if (alreadyEncored) lines.push(`Encore fails: ${second.mon.species} is already Encored.`);
      else if (second.mon.choiceLock)
        lines.push(
          `Encore is redundant: ${second.mon.species} is already Choice-locked into ${second.mon.choiceLock}.`,
        );
      else if (order === 'first')
        lines.push(
          second.mon.lastMove
            ? `Encore acts before the target and attempts to lock its prior move, ${second.mon.lastMove.name}.`
            : 'Encore acts before the target and fails because it has no prior move.',
        );
      else if (order === 'second')
        lines.push(
          `Encore acts after the target and attempts to lock the move used this turn${
            secondMove ? `, ${secondMove}` : ''
          }.`,
        );
      else
        lines.push(
          'Encore timing depends on the unresolved order; it may lock the prior move or the move used this turn.',
        );
    }
    return lines.join('\n');
  }

  estimateDamage(args: Record<string, unknown>, request: BattleRequest, reference: ShowdownReference): string {
    this.updateOwnRequest(request);
    const attackerName = typeof args.attacker === 'string' ? args.attacker.trim() : '';
    const defenderName = typeof args.defender === 'string' ? args.defender.trim() : '';
    const move = typeof args.move === 'string' ? args.move.trim() : '';
    if (!attackerName || !defenderName || !move) return 'attacker, defender, and move are required.';
    const attacker = this.findMon(attackerName);
    const defender = this.findMon(defenderName);
    const visible = this.activeEntries().map(
      (entry) => `${entry.pid === this.pid ? 'ally' : 'foe'} ${entry.slot}: ${entry.mon.species}`,
    );
    if (!attacker || !defender) {
      const missing = !attacker ? attackerName : defenderName;
      return `Could not resolve ${JSON.stringify(missing)} on the visible battle rosters. Active Pokémon: ${visible.join('; ') || 'none'}.`;
    }
    if (attacker.mon === defender.mon) return 'attacker and defender must identify different Pokémon.';

    const exactStats = (entry: { pid: Pid; mon: MonState }, includeHp: boolean): Record<string, number> => {
      if (entry.pid !== this.pid) return {};
      const stats = { ...entry.mon.stats };
      if (includeHp) {
        const maximum = /\/(\d+)/.exec(entry.mon.hp ?? '')?.[1];
        if (maximum) stats.hp = Number(maximum);
      }
      return stats;
    };
    const ability = (mon: MonState) =>
      mon.abilitySuppressed ? undefined : (mon.ability ?? reference.speciesAbility(mon.species));
    const authoritative: Record<string, unknown> = {
      attacker: attacker.mon.species,
      defender: defender.mon.species,
      move,
    };
    const setMon = (side: 'attacker' | 'defender', entry: { pid: Pid; mon: MonState }): void => {
      const monAbility = ability(entry.mon);
      if (monAbility) authoritative[`${side}_ability`] = monAbility;
      if (entry.mon.item && !entry.mon.itemConsumed) authoritative[`${side}_item`] = entry.mon.item;
      if (entry.mon.nature) authoritative[`${side}_nature`] = entry.mon.nature;
      if (entry.mon.status) authoritative[`${side}_status`] = entry.mon.status;
      if (Object.keys(entry.mon.boosts).length) authoritative[`${side}_boosts`] = { ...entry.mon.boosts };
      if (entry.mon.hpPercent !== undefined) authoritative[`${side}_hp_percent`] = entry.mon.hpPercent;
      const stats = exactStats(entry, side === 'defender');
      if (Object.keys(stats).length) authoritative[`${side}_stats`] = stats;
    };
    setMon('attacker', attacker);
    setMon('defender', defender);
    authoritative.attacker_fainted_allies = [...this.sides[attacker.pid].mons.values()].filter(
      (mon) => mon.fainted,
    ).length;
    const active = this.activeEntries();
    const moveTarget = reference.moveTarget(move);
    const liveFoes = active.filter((entry) => entry.pid !== attacker.pid).length;
    const hasLiveAlly = active.some((entry) => entry.pid === attacker.pid && entry.mon !== attacker.mon);
    authoritative.is_spread_hit =
      moveTarget === 'allAdjacentFoes'
        ? liveFoes === 2
        : moveTarget === 'allAdjacent'
          ? liveFoes + Number(hasLiveAlly) > 1
          : false;
    for (const [side, entry] of [
      ['attacker', attacker],
      ['defender', defender],
    ] as const) {
      const ally = active.find((other) => other.pid === entry.pid && other.mon !== entry.mon);
      if (!ally) continue;
      authoritative[`${side}_ally`] = ally.mon.species;
      const allyAbility = ability(ally.mon);
      if (allyAbility) authoritative[`${side}_ally_ability`] = allyAbility;
      if (ally.mon.item && !ally.mon.itemConsumed) authoritative[`${side}_ally_item`] = ally.mon.item;
    }
    const screens = [...this.sides[defender.pid].conditions.keys()].filter((condition) => SCREEN_MOVES.has(condition));
    if (screens.length) authoritative.defender_screens = screens;
    if (this.weather) authoritative.weather = this.weather.name;
    const terrain = [...this.fields.values()].find((effect) => /terrain/i.test(effect.name));
    if (terrain) authoritative.terrain = terrain.name;
    if (args.helping_hand === true) authoritative.helping_hand = true;
    if (args.is_critical_hit === true) authoritative.is_critical_hit = true;

    const known = (entry: { pid: Pid; mon: MonState }, side: string) => {
      const monAbility = ability(entry.mon);
      return `${side} ${entry.mon.species}${
        monAbility ? ` (${monAbility})` : entry.mon.abilitySuppressed ? ' (ability suppressed)' : ' (ability unknown)'
      }`;
    };
    const context = `Live battle and open-sheet state applied: ${known(attacker, 'attacker')}; ${known(defender, 'defender')}.`;
    return `${context}\n${reference.lookup('estimate_damage', authoritative)}`;
  }

  private activeEntries(): Array<{ pid: Pid; slot: number; mon: MonState }> {
    const entries: Array<{ pid: Pid; slot: number; mon: MonState }> = [];
    for (const pid of ['p1', 'p2'] as const) {
      const side = this.sides[pid];
      for (const [slot, letter] of [
        [1, 'a'],
        [2, 'b'],
      ] as const) {
        const key = side.active[letter];
        const mon = key ? side.mons.get(key) : undefined;
        if (mon && !mon.fainted) entries.push({ pid, slot, mon });
      }
    }
    return entries;
  }

  private activeEntry(pid: Pid, slot: number): MonState | undefined {
    const key = this.sides[pid].active[slot === 1 ? 'a' : slot === 2 ? 'b' : ''];
    const mon = key ? this.sides[pid].mons.get(key) : undefined;
    return mon && !mon.fainted ? mon : undefined;
  }

  private findMon(query: string): { pid: Pid; slot: number; mon: MonState; benched: boolean } | undefined {
    const activeMatch = this.findActive(query);
    if (activeMatch) return { ...activeMatch, benched: false };
    const normalized = this.speciesKey(query);
    const prefixed = /^(ally|foe)(.+)$/.exec(normalized);
    const wanted = prefixed ? prefixed[2]! : normalized;
    const demega = (key: string) => key.replace(/mega[xy]?$/, '').replace(/^mega/, '');
    for (const pid of ['p1', 'p2'] as const) {
      if (prefixed && (pid === this.pid) !== (prefixed[1] === 'ally')) continue;
      const side = this.sides[pid];
      const activeKeys = new Set(Object.values(side.active));
      for (const [key, mon] of side.mons) {
        if (activeKeys.has(key) || mon.fainted) continue;
        const monKey = this.speciesKey(mon.species);
        if (monKey === wanted || demega(monKey) === wanted || monKey === demega(wanted))
          return { pid, slot: -1, mon, benched: true };
      }
    }
    return undefined;
  }

  private findActive(query: string): { pid: Pid; slot: number; mon: MonState } | undefined {
    const normalized = this.speciesKey(query);
    const slot = /^(ally|foe)([12])$/.exec(normalized);
    if (slot) {
      const own = slot[1] === 'ally';
      const pid = own ? this.pid : this.pid === 'p1' ? 'p2' : 'p1';
      const mon = this.activeEntry(pid, Number(slot[2]));
      return mon ? { pid, slot: Number(slot[2]), mon } : undefined;
    }
    const prefixed = /^(ally|foe)(.+)$/.exec(normalized);
    const candidates = prefixed
      ? this.activeEntries().filter((entry) => (entry.pid === this.pid) === (prefixed[1] === 'ally'))
      : this.activeEntries();
    const wanted = prefixed ? prefixed[2]! : normalized;
    const exact = candidates.find(
      (entry) =>
        this.speciesKey(entry.mon.species) === wanted || this.speciesKey(afterColon(entry.mon.ident)) === wanted,
    );
    if (exact) return exact;
    const demega = (key: string) => key.replace(/mega[xy]?$/, '').replace(/^mega/, '');
    const wantedBase = demega(wanted);
    return candidates.find((entry) => {
      const entryKey = this.speciesKey(entry.mon.species);
      return demega(entryKey) === wanted || entryKey === wantedBase || demega(entryKey) === wantedBase;
    });
  }

  private speedProfile(pid: Pid, mon: MonState, reference: ShowdownReference): SpeedProfile | undefined {
    const conditions = this.sides[pid].conditions;
    const terrain = [...this.fields.values()].find((effect) => /terrain/i.test(effect.name))?.name;
    return reference.speedProfile({
      species: mon.species,
      ...(mon.nature === undefined ? {} : { nature: mon.nature }),
      ...(pid === this.pid && Number.isInteger(mon.stats.spe) ? { exact: mon.stats.spe } : {}),
      ...(mon.item === undefined ? {} : { item: mon.item }),
      itemConsumed: mon.itemConsumed,
      ...(mon.ability === undefined ? {} : { ability: mon.ability }),
      ...(mon.status === undefined ? {} : { status: mon.status }),
      ...(mon.boosts.spe === undefined ? {} : { boost: mon.boosts.spe }),
      tailwind: conditions.has('tailwind'),
      ...(this.weather?.name === undefined ? {} : { weather: this.weather.name }),
      ...(terrain === undefined ? {} : { terrain }),
    });
  }

  private speedOrder(
    first: SpeedProfile,
    second: SpeedProfile,
    trickRoom: boolean,
  ): 'first' | 'second' | 'tie' | 'uncertain' {
    if (
      first.effective[0] === first.effective[1] &&
      first.effective[0] === second.effective[0] &&
      second.effective[0] === second.effective[1]
    )
      return 'tie';
    if (trickRoom) {
      if (first.effective[1] < second.effective[0]) return 'first';
      if (second.effective[1] < first.effective[0]) return 'second';
    } else {
      if (first.effective[0] > second.effective[1]) return 'first';
      if (second.effective[0] > first.effective[1]) return 'second';
    }
    return 'uncertain';
  }

  private formatRange(range: [number, number]): string {
    return range[0] === range[1] ? String(range[0]) : `${range[0]}–${range[1]}`;
  }

  private stopTimer(pid: Pid): void {
    const timer = this.timers[pid];
    if (!timer?.running) return;
    const now = Date.now();
    const drained = (now - timer.at) / 1000;
    this.timers[pid] = {
      seconds: timer.seconds === null ? null : Math.max(0, timer.seconds - drained),
      turnSeconds: timer.turnSeconds === null ? null : Math.max(0, timer.turnSeconds - drained),
      at: now,
      running: false,
    };
  }

  weatherLabel(): string {
    return this.formatTimed(this.weather);
  }

  fieldLabels(): string[] {
    return [...this.fields.values()].map((effect) => this.formatTimed(effect)).sort();
  }

  conditionLabels(pid: Pid): string[] {
    return [...this.sides[pid].conditions.values()].map((effect) => this.formatTimed(effect)).sort();
  }

  /** Mons a spectator should see: team-preview ghosts are dropped once a richer entry covers the species. */
  visibleMons(pid: Pid): MonState[] {
    const side = this.sides[pid];
    return this.withoutPreviewGhosts(side, [...side.mons.values()]);
  }

  activeSlot(pid: Pid, mon: MonState): string | undefined {
    const key = this.monKey(mon.ident);
    return Object.entries(this.sides[pid].active).find(([, active]) => active === key)?.[0];
  }

  private withoutPreviewGhosts(side: SideState, mons: MonState[]): MonState[] {
    const rich = new Set(
      mons
        .filter((mon) => mon.hp !== undefined || mon.moves.size || mon.item || mon.ability)
        .flatMap((mon) => [this.speciesKey(mon.species), ...mon.formes]),
    );
    for (const mon of mons) {
      if (mon.hp === undefined && !mon.moves.size) continue;
      const sheetMon = side.sheet.find((candidate) => this.monKey(candidate.ident) === this.monKey(mon.ident));
      if (sheetMon) rich.add(this.speciesKey(sheetMon.species));
    }
    return mons.filter((mon) => !(mon.preview && mon.hp === undefined && rich.has(this.speciesKey(mon.species))));
  }

  private effectStartTurn(): number {
    return Math.max(1, this.turn + (this.upkeepDone ? 1 : 0));
  }

  private formatTimed(effect: TimedEffect | undefined): string {
    if (!effect) return 'none';
    if (effect.duration === undefined) return effect.name;
    const elapsed = Math.max(0, this.turn - effect.startedTurn);
    const remaining = Math.max(0, effect.duration - elapsed);
    return `${effect.name} (${remaining} turn${remaining === 1 ? '' : 's'} left)`;
  }

  private effectSource(args: string[]): MonState | undefined {
    const of = args.find((arg) => arg.startsWith('[of] '));
    if (!of) return undefined;
    const ident = of.slice(5);
    const side = this.identParts(ident)[0];
    return side ? this.sides[side].mons.get(this.monKey(ident)) : undefined;
  }

  private lastMoveUserThisTurn(moveId: string, pid?: Pid): MonState | undefined {
    for (const side of pid ? [this.sides[pid]] : Object.values(this.sides)) {
      for (const key of Object.values(side.active)) {
        const mon = side.mons.get(key);
        if (mon?.lastMove && mon.lastMove.turn === this.turn && this.speciesKey(mon.lastMove.name) === moveId)
          return mon;
      }
    }
    return undefined;
  }

  private renderSide(
    pid: Pid,
    own: boolean,
    expandedRoster: boolean,
    referenceFor?: (mon: CompactMon) => CompactMonReference | undefined,
  ): string[] {
    const side = this.sides[pid];
    const title = own ? 'Your side' : 'Opponent side';
    const conditions = this.conditionLabels(pid);
    const lines = [`${title} conditions: ${conditions.length ? conditions.join(', ') : 'none'}`];
    const mons = this.withoutPreviewGhosts(
      side,
      [...side.mons.values()].filter((mon) => !own || mon.brought !== false),
    );
    const broughtCount = [...this.sides[this.pid].mons.values()].filter((mon) => mon.brought === true).length;
    const revealedCount = mons.filter((mon) => mon.hpPercent !== undefined).length;
    const foesResolved = !own && broughtCount > 0 && revealedCount >= broughtCount;
    if (!own && broughtCount > 0 && !foesResolved)
      lines.push(
        `Opponent brought ${broughtCount} this game; ${revealedCount} revealed so far, so only ${
          broughtCount - revealedCount
        } of the "HP ?" Pokémon below ${broughtCount - revealedCount === 1 ? 'is' : 'are'} actually in this game.`,
      );
    if (!own && side.showteam) {
      const knownSpecies = new Set(mons.flatMap((mon) => [this.speciesKey(mon.species), ...mon.formes]));
      const knownIdentities = new Set(mons.map((mon) => this.monKey(mon.ident)));
      mons.push(
        ...side.sheet.filter(
          (mon) => !knownSpecies.has(this.speciesKey(mon.species)) && !knownIdentities.has(this.monKey(mon.ident)),
        ),
      );
    }
    for (const mon of mons) {
      if (
        !own &&
        !side.showteam &&
        !mon.preview &&
        mon.hp === undefined &&
        !mon.moves.size &&
        !mon.item &&
        !mon.ability
      )
        continue;
      const activeSlots = Object.entries(side.active).flatMap(([slot, key]) =>
        key === this.monKey(mon.ident) ? [slot] : [],
      );
      const reference = referenceFor?.({
        species: mon.species,
        item: mon.item ?? null,
        nature: mon.nature ?? null,
        moves: [...mon.moves.values()].map((move) => move.name),
        active: activeSlots.length > 0,
      });
      const attrs = [mon.species];
      if (reference?.types) attrs.push(`types ${reference.types}`);
      if (activeSlots.length) attrs.push(`active slot ${activeSlots.join('/')}`);
      if (foesResolved && mon.hpPercent === undefined) attrs.push('not brought this game');
      else attrs.push(`HP ${mon.hpPercent === undefined ? '?' : `${Math.round(mon.hpPercent)}%`}`);
      if (mon.status) attrs.push(mon.status);
      if (mon.fainted) attrs.push('fainted');
      if (!expandedRoster && !activeSlots.length) {
        if (mon.moves.size) attrs.push(`moves ${[...mon.moves.values()].map((entry) => entry.name).join(', ')}`);
        const speed = own ? mon.stats.spe : undefined;
        if (speed !== undefined) attrs.push(`Speed ${speed}`);
        else if (reference?.speed) attrs.push(`raw Speed range ${reference.speed}`);
        if (mon.item) attrs.push(`item ${mon.item}${mon.itemConsumed ? ' (consumed)' : ''}`);
        if (mon.ability) attrs.push(`ability ${mon.ability}`);
        else if (mon.abilitySuppressed) attrs.push('ability suppressed');
        if (mon.nature) attrs.push(`stat alignment ${mon.nature}`);
        if (mon.mega) attrs.push('Mega Evolved');
        if (!mon.mega && reference?.mega) attrs.push(reference.mega);
        lines.push(`- ${attrs.join('; ')}`);
        continue;
      }
      const boosts = Object.entries(mon.boosts)
        .filter(([, value]) => value)
        .sort(([a], [b]) => a.localeCompare(b));
      if (boosts.length)
        attrs.push(
          `boosts ${boosts
            .map(([stat, value]) => `${STAT_LABELS[stat] ?? stat} ${value >= 0 ? '+' : ''}${value}`)
            .join(', ')}`,
        );
      if (mon.volatiles.size) attrs.push(`volatile ${[...mon.volatiles].sort().join(', ')}`);
      if (mon.moves.size)
        attrs.push(
          `moves ${[...mon.moves.values()]
            .map((entry) => {
              const details = [
                ...(entry.pp !== undefined ? [`PP ${entry.pp}/${entry.maxpp ?? '?'}`] : []),
                ...(entry.used ? [`used ${entry.used}`] : []),
              ];
              const referenceDetail = reference?.moves[this.speciesKey(entry.name)];
              return `${entry.name}${referenceDetail ? ` [${referenceDetail}]` : ''}${
                details.length ? ` (${details.join('; ')})` : ''
              }`;
            })
            .join(', ')}`,
        );
      if (mon.protectSuccessStreak > 0)
        attrs.push(
          mon.protectSuccessStreak === 1
            ? 'Protect success rate reduced next use'
            : `Protect success rate heavily reduced (streak ${mon.protectSuccessStreak})`,
        );
      if (mon.lastMove) {
        const target = mon.lastMove.target ? ` into ${this.targetSpecies(mon.lastMove.target)}` : '';
        attrs.push(`last move ${mon.lastMove.name}${target} (turn ${mon.lastMove.turn})`);
      }
      if (mon.choiceLock) attrs.push(`Choice-locked into ${mon.choiceLock}`);
      if (own && Object.keys(mon.stats).length) {
        const maxHp = /\/(\d+)/.exec(mon.hp ?? '')?.[1];
        attrs.push(
          `stats ${maxHp ? `Max HP ${maxHp}, ` : ''}${Object.entries(mon.stats)
            .map(([stat, value]) => `${STAT_LABELS[stat] ?? stat} ${value}`)
            .join(', ')}`,
        );
      } else if (reference?.speed) attrs.push(`raw Speed range ${reference.speed}`);
      if (mon.item) attrs.push(`item ${mon.item}${mon.itemConsumed ? ' (consumed)' : ''}`);
      if (mon.ability) attrs.push(`ability ${mon.ability}`);
      else if (mon.abilitySuppressed) attrs.push('ability suppressed');
      if (mon.nature) attrs.push(`stat alignment ${mon.nature}`);
      if (mon.mega) attrs.push('Mega Evolved');
      if (!mon.mega && reference?.mega) attrs.push(reference.mega);
      lines.push(`- ${attrs.join('; ')}`);
    }
    if (lines.length === 1) lines.push('- no Pokémon revealed');
    return lines;
  }

  private updateOwnRequest(request: BattleRequest): void {
    const requested = request.side?.pokemon ?? [];
    if (!request.teamPreview && requested.length) {
      const brought = new Set(
        requested.map((pokemon) => this.monKey(text(pokemon.ident))).filter((key) => key !== `${this.pid}:pokémon`),
      );
      for (const [key, mon] of this.sides[this.pid].mons) mon.brought = brought.has(key);
      if (request.active) this.sides[this.pid].active = {};
    }
    let activeIndex = 0;
    for (const pokemon of requested) {
      const ident = text(pokemon.ident);
      if (!ident) continue;
      const mon = this.mon(ident);
      if (!request.teamPreview) mon.brought = true;
      this.setDetails(mon, text(pokemon.details));
      const condition = text(pokemon.condition);
      this.setHp(mon, condition);
      const conditionParts = condition.split(' ');
      mon.status = conditionParts[1] && conditionParts[1] !== 'fnt' ? conditionParts[1] : undefined;
      mon.item = text(pokemon.item) || mon.item;
      mon.ability = text(pokemon.ability) || text(pokemon.baseAbility) || mon.ability;
      if (text(pokemon.ability) || text(pokemon.baseAbility)) mon.abilitySuppressed = false;
      const stats = asRecord(pokemon.stats);
      mon.stats = Object.fromEntries(
        Object.entries(stats).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isInteger(entry[1]),
        ),
      );
      for (const move of asStrings(pokemon.moves)) if (move) mon.recordMove(move);
      if (!pokemon.active) continue;
      const slot = activeIndex++;
      this.sides[this.pid].active[String.fromCharCode('a'.charCodeAt(0) + slot)] = this.monKey(ident);
      const active = request.active?.[slot];
      if (!active) continue;
      for (const move of asRecords(active.moves)) {
        const name = text(move.move) || text(move.id);
        if (!name) continue;
        const entry = mon.recordMove(name);
        if (Number.isInteger(move.pp)) entry.pp = move.pp as number;
        if (Number.isInteger(move.maxpp)) entry.maxpp = move.maxpp as number;
      }
    }
  }

  private mon(ident: string): MonState {
    const [parsedSide] = this.identParts(ident);
    const side = parsedSide ?? this.pid;
    const key = this.monKey(ident);
    const mon = this.sides[side].mons.get(key) ?? new MonState(ident);
    if (mon.species === 'Pokémon') mon.species = this.nickname(ident);
    mon.ident = ident;
    this.sides[side].mons.set(key, mon);
    return mon;
  }

  private setDetails(mon: MonState, details: string): void {
    if (!details) return;
    const [species] = details.split(',').map((value) => value.trim());
    if (species) {
      mon.species = species;
      mon.formes.add(this.speciesKey(species));
    }
  }

  private setHp(mon: MonState, hp: string): void {
    if (!hp) return;
    const [rawFirst = '', status] = hp.trim().split(/\s+/);
    const match = /^(\d+)\/(\d+)[a-z]*$/i.exec(rawFirst);
    const first = match ? `${match[1]}/${match[2]}` : rawFirst;
    mon.hp = status ? `${first} ${status}` : first;
    if (match) {
      const current = Number(match[1]);
      const maximum = Number(match[2]);
      if (maximum) mon.hpPercent = (100 * current!) / maximum;
    } else if (first === '0') mon.hpPercent = 0;
    mon.fainted = status === 'fnt' || mon.hpPercent === 0;
    if (status && status !== 'fnt') mon.status = status;
  }

  private showTeam(pidValue: string, packed: string): void {
    if (pidValue !== 'p1' && pidValue !== 'p2') return;
    const sheet = packed
      .split(']')
      .filter(Boolean)
      .map((entry) => {
        const fields = entry.split('|');
        const nickname = fields[0] || 'Pokémon';
        const mon = new MonState(`${pidValue}: ${nickname}`);
        mon.species = fields[1] || nickname;
        mon.item = fields[2] || undefined;
        mon.ability = fields[3] || undefined;
        for (const move of fields[4]?.split(',') ?? []) if (move) mon.recordMove(move);
        mon.nature = fields[5] || undefined;
        return mon;
      });
    const side = this.sides[pidValue];
    side.sheet = sheet;
    side.showteam = true;
    const bySpecies = new Map([...side.mons.values()].map((mon) => [this.speciesKey(mon.species), mon]));
    for (const sheetMon of sheet) {
      const mon = bySpecies.get(this.speciesKey(sheetMon.species));
      if (mon) this.mergeMon(mon, sheetMon);
    }
  }

  private mergeSheetMon(mon: MonState, side: SideState): void {
    const sheetMon = side.sheet.find(
      (candidate) => this.speciesKey(candidate.species) === this.speciesKey(mon.species),
    );
    if (sheetMon) this.mergeMon(mon, sheetMon);
  }

  private mergeMon(mon: MonState, sheet: MonState): void {
    mon.item ||= sheet.item;
    mon.ability ||= sheet.ability;
    mon.nature ||= sheet.nature;
    for (const move of sheet.moves.values()) mon.recordMove(move.name);
  }

  private identParts(ident: string): [Pid | undefined, string] {
    const head = ident.split(':')[0]!;
    return head.startsWith('p1') || head.startsWith('p2')
      ? [head.slice(0, 2) as Pid, head.slice(2, 3) || 'a']
      : [undefined, 'a'];
  }

  private monKey(ident: string): string {
    const side = ident.startsWith('p1') || ident.startsWith('p2') ? ident.slice(0, 2) : '';
    return `${side}:${this.nickname(ident).toLowerCase()}`;
  }

  private nickname(ident: string): string {
    return afterColon(ident) || 'Pokémon';
  }

  private speciesKey(species: string): string {
    return species.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private effect(value: string): string {
    return afterColon(value);
  }

  static requestName(pokemon: JsonObject): string {
    const fromDetails = text(pokemon.details).split(',', 1)[0]?.trim();
    if (fromDetails) return fromDetails;
    return afterColon(text(pokemon.ident)) || 'Pokémon';
  }

  private targetSpecies(ident: string): string {
    const side = this.identParts(ident)[0];
    if (side) {
      const mon = this.sides[side].mons.get(this.monKey(ident));
      if (mon?.species && mon.species !== 'Pokémon') return mon.species;
    }
    return this.nickname(ident);
  }
}
