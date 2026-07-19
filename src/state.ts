import type { CompactMon, MatchupMon } from './reference.js';
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
  duration: number;
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
  item: string | undefined;
  itemConsumed = false;
  ability: string | undefined;
  nature: string | undefined;
  mega = false;
  fainted = false;
  preview = false;
  brought: boolean | undefined;
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

const SCREEN_MOVES = new Set(['reflect', 'lightscreen', 'auroraveil']);

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

export class BattleState {
  turn = 0;
  weather: TimedEffect | undefined;
  fields = new Map<string, TimedEffect>();
  sides: Record<Pid, SideState> = { p1: new SideState(), p2: new SideState() };

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
    if (kind === 'turn' && args[0]) this.turn = Number(args[0]);
    else if ((kind === 'switch' || kind === 'drag' || kind === 'replace') && args.length >= 3) {
      const mon = this.mon(args[0]!);
      this.setDetails(mon, args[1]!);
      this.setHp(mon, args[2]!);
      const [side, slot] = this.identParts(args[0]!);
      if (side) {
        this.mergeSheetMon(mon, this.sides[side]);
        const previous = this.sides[side].active[slot];
        const previousMon = previous ? this.sides[side].mons.get(previous) : undefined;
        if (previousMon) {
          previousMon.boosts = {};
          previousMon.volatiles.clear();
        }
        if (kind !== 'replace') {
          mon.boosts = {};
          mon.volatiles.clear();
          mon.protectSuccessStreak = 0;
        }
        this.sides[side].active[slot] = this.monKey(args[0]!);
      }
    } else if (kind === 'detailschange' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      const previous = mon.species;
      this.setDetails(mon, args[1]!);
      if (this.speciesKey(previous) !== this.speciesKey(mon.species)) mon.ability = undefined;
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
      if (kind === '-start') mon.volatiles.add(effect);
      else mon.volatiles.delete(effect);
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
        this.weather = { name, startedTurn: Math.max(1, this.turn), duration: extended ? 8 : 5 };
      }
    } else if (kind === '-fieldstart' && args[0]) {
      const name = this.effect(args[0]);
      this.fields.set(this.speciesKey(name), { name, startedTurn: Math.max(1, this.turn), duration: 5 });
    } else if (kind === '-fieldend' && args[0]) this.fields.delete(this.speciesKey(this.effect(args[0]!)));
    else if ((kind === '-sidestart' || kind === '-sideend') && args.length >= 2) {
      const side = args[0]!.split(':')[0]!;
      if (side === 'p1' || side === 'p2') {
        const effect = this.effect(args[1]!);
        const key = this.speciesKey(effect);
        if (kind === '-sidestart') {
          let duration = key === 'tailwind' ? 4 : 5;
          if (SCREEN_MOVES.has(key)) {
            const setter =
              this.lastMoveUserThisTurn(key, side) ??
              [...this.sides[side].mons.values()].find((mon) => mon.item && this.speciesKey(mon.item) === 'lightclay');
            if (setter?.item && this.speciesKey(setter.item) === 'lightclay') duration = 8;
          }
          this.sides[side].conditions.set(key, { name: effect, startedTurn: Math.max(1, this.turn), duration });
        } else this.sides[side].conditions.delete(key);
      }
    } else if (kind === '-item' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.item = args[1];
      mon.itemConsumed = false;
    } else if (kind === '-enditem' && args[0]) {
      const mon = this.mon(args[0]);
      if (args[1]) mon.item = args[1];
      mon.itemConsumed = true;
    } else if (kind === '-ability' && args.length >= 2) this.mon(args[0]!).ability = args[1];
    else if (kind === '-mega' && args[0]) {
      const mon = this.mon(args[0]);
      mon.mega = true;
      mon.ability = undefined;
    } else if (kind === '-formechange' && args.length >= 2) {
      const mon = this.mon(args[0]!);
      mon.species = args[1]!;
      mon.ability = undefined;
    } else if (kind === 'showteam' && args.length >= 2) this.showTeam(args[0]!, args.slice(1).join('|'));
  }

  render(request: BattleRequest): string {
    this.updateOwnRequest(request);
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    return [
      `Turn: ${this.turn}`,
      `Weather: ${this.weatherLabel()}`,
      `Field: ${this.fieldLabels().join(', ') || 'none'}`,
      ...this.renderSide(this.pid, true),
      ...this.renderSide(foe, false),
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

  /** Active + brought/revealed bench only, for compact always-on mechanics. */
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

  activeMatchupSides(): { allies: MatchupMon[]; foes: MatchupMon[] } {
    const collect = (pid: Pid, ally: boolean): MatchupMon[] => {
      const side = this.sides[pid];
      return (['a', 'b'] as const).flatMap((slot) => {
        const key = side.active[slot];
        const mon = key ? side.mons.get(key) : undefined;
        if (!mon || mon.fainted) return [];
        return [
          {
            species: mon.species,
            moves: [...mon.moves.values()].map((move) => move.name),
            ally,
          },
        ];
      });
    };
    const foe: Pid = this.pid === 'p1' ? 'p2' : 'p1';
    return { allies: collect(this.pid, true), foes: collect(foe, false) };
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
        .map((mon) => this.speciesKey(mon.species)),
    );
    for (const mon of mons) {
      if (mon.hp === undefined && !mon.moves.size) continue;
      const sheetMon = side.sheet.find((candidate) => this.monKey(candidate.ident) === this.monKey(mon.ident));
      if (sheetMon) rich.add(this.speciesKey(sheetMon.species));
    }
    return mons.filter((mon) => !(mon.preview && mon.hp === undefined && rich.has(this.speciesKey(mon.species))));
  }

  private formatTimed(effect: TimedEffect | undefined): string {
    if (!effect) return 'none';
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

  private renderSide(pid: Pid, own: boolean): string[] {
    const side = this.sides[pid];
    const title = own ? 'Your side' : 'Opponent side';
    const conditions = this.conditionLabels(pid);
    const lines = [`${title} conditions: ${conditions.length ? conditions.join(', ') : 'none'}`];
    const mons = this.withoutPreviewGhosts(
      side,
      [...side.mons.values()].filter((mon) => !own || mon.brought !== false),
    );
    if (!own && side.showteam) {
      const knownSpecies = new Set(mons.map((mon) => this.speciesKey(mon.species)));
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
      const attrs = [mon.species];
      const activeSlots = Object.entries(side.active).flatMap(([slot, key]) =>
        key === this.monKey(mon.ident) ? [slot] : [],
      );
      if (activeSlots.length) attrs.push(`active slot ${activeSlots.join('/')}`);
      attrs.push(`HP ${mon.hp ?? '?'}`);
      if (mon.status) attrs.push(mon.status);
      if (mon.fainted) attrs.push('fainted');
      const boosts = Object.entries(mon.boosts)
        .filter(([, value]) => value)
        .sort(([a], [b]) => a.localeCompare(b));
      if (boosts.length)
        attrs.push(`boosts ${boosts.map(([stat, value]) => `${stat} ${value >= 0 ? '+' : ''}${value}`).join(', ')}`);
      if (mon.volatiles.size) attrs.push(`volatile ${[...mon.volatiles].sort().join(', ')}`);
      if (mon.moves.size)
        attrs.push(
          `moves ${[...mon.moves.values()]
            .map((entry) => {
              const details = [
                ...(entry.pp !== undefined ? [`PP ${entry.pp}/${entry.maxpp ?? '?'}`] : []),
                ...(entry.used ? [`used ${entry.used}`] : []),
              ];
              return `${entry.name}${details.length ? ` (${details.join('; ')})` : ''}`;
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
      if (own && Object.keys(mon.stats).length)
        attrs.push(
          `stats ${Object.entries(mon.stats)
            .map(([stat, value]) => `${stat} ${value}`)
            .join(', ')}`,
        );
      if (mon.item) attrs.push(`item ${mon.item}${mon.itemConsumed ? ' (consumed)' : ''}`);
      if (mon.ability) attrs.push(`ability ${mon.ability}`);
      if (mon.nature) attrs.push(`stat alignment ${mon.nature}`);
      if (mon.mega) attrs.push('Mega Evolved');
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
    if (species) mon.species = species;
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
