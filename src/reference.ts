import type { Dex } from 'pokemon-showdown';
import { defaultPsDir } from './paths.js';
import { loadShowdown, showdownCommit } from './showdown.js';
import type { ToolDefinition } from './types.js';

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const DEX_TOOLS: ToolDefinition[] = [
  tool(
    'lookup_species',
    'Look up a species: typing, abilities, base stats, forme, Mega Stone outcomes, and optional nature-based Speed range.',
    {
      name: { type: 'string' },
      item: { type: ['string', 'null'] },
      nature: { type: ['string', 'null'] },
    },
    ['name'],
  ),
  tool(
    'lookup_move',
    'Look up a move: type, category, power, accuracy, priority, target, and effect text.',
    { name: { type: 'string' } },
    ['name'],
  ),
  tool('lookup_item', "Look up an item's effect text and mega-stone behaviour.", { name: { type: 'string' } }, [
    'name',
  ]),
  tool('lookup_ability', "Look up an ability's effect text.", { name: { type: 'string' } }, ['name']),
  tool('lookup_nature', 'Look up a Showdown nature/stat alignment (+stat / -stat).', { name: { type: 'string' } }, [
    'name',
  ]),
  tool(
    'lookup_matchup',
    'Look up type-chart effectiveness for an attacking move or type into a defending species. Returns immunity/SE/NVE multipliers only—not damage.',
    {
      attacker_type: { type: 'string', description: 'Attacking type, or omit when move is provided.' },
      move: { type: 'string', description: 'Move name; its type is used when provided.' },
      defender: { type: 'string', description: 'Defending species name.' },
    },
    ['defender'],
  ),
  tool(
    'estimate_damage',
    'Estimate Gen 9 level-50 damage in doubles from base stats, STAB, type chart, weather, common items, and spread reduction. Ignores abilities, boosts, burn, screens, and terrain. Own exact stats may be supplied; opposing stats use legal IV/EV ranges from the open team sheet nature only. Never invent hidden IVs/EVs.',
    {
      attacker: { type: 'string' },
      defender: { type: 'string' },
      move: { type: 'string' },
      attacker_stats: {
        type: 'object',
        description: 'Optional exact attacker stats from your request (atk/def/spa/spd/spe).',
        properties: {
          atk: { type: 'number' },
          def: { type: 'number' },
          spa: { type: 'number' },
          spd: { type: 'number' },
          spe: { type: 'number' },
        },
        additionalProperties: false,
      },
      attacker_hp: { type: 'number', description: 'Optional current attacker HP for HP-scaling moves.' },
      attacker_max_hp: { type: 'number' },
      defender_hp: {
        type: 'number',
        description: 'Exact current defender HP in raw points—own Pokémon only, whose real HP you know.',
      },
      defender_max_hp: { type: 'number', description: 'Exact defender max HP in raw points (own side only).' },
      defender_hp_percent: {
        type: 'number',
        description: 'Foe HP as the percent shown in battle (0-100). Use this for opponents; never guess raw foe HP.',
      },
      attacker_item: { type: 'string' },
      defender_item: { type: 'string' },
      attacker_nature: { type: 'string' },
      defender_nature: { type: 'string' },
      weather: { type: 'string' },
      is_spread_hit: {
        type: 'boolean',
        description:
          'True when a spread move hits more than one Pokémon (0.75x in doubles). Default true for allAdjacent moves.',
      },
    },
    ['attacker', 'defender', 'move'],
  ),
];

type SpeciesSet = [name: string, item?: string | null, nature?: string | null];

export interface ReferenceQuery {
  speciesItems?: Array<[string, string | null]>;
  speciesSets?: SpeciesSet[];
  moves?: string[];
  items?: string[];
  abilities?: string[];
  natures?: string[];
}

export interface CompactMon {
  species: string;
  item?: string | null;
  nature?: string | null;
  moves?: string[];
  active?: boolean;
}

export interface MatchupMon {
  species: string;
  moves: string[];
  ally?: boolean;
}

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function uniqueNames(values: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const clean = value?.trim();
    if (clean) names.set(id(clean), names.get(id(clean)) ?? clean);
  }
  return [...names.values()].sort((a, b) => id(a).localeCompare(id(b)));
}

function cleanDescription(value: unknown): string {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean).join(' ') : '';
}

function baseStats(stats: Dex.StatsTable): string {
  return `base stats HP ${stats.hp}, Atk ${stats.atk}, Def ${stats.def}, SpA ${stats.spa}, SpD ${stats.spd}, Spe ${stats.spe}`;
}

function speedRange(base: number, nature?: { plus?: string; minus?: string }): [number, number] {
  const modifier = nature?.plus === 'spe' ? 1.1 : nature?.minus === 'spe' ? 0.9 : nature ? 1 : undefined;
  const stat = (iv: number, ev: number, multiplier: number) =>
    Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * 50) / 100) + 5) * multiplier);
  return modifier === undefined
    ? [stat(0, 0, 0.9), stat(31, 252, 1.1)]
    : [stat(0, 0, modifier), stat(31, 252, modifier)];
}

function statRange(
  base: number,
  nature?: { plus?: string; minus?: string },
  statName?: 'atk' | 'def' | 'spa' | 'spd' | 'spe',
): [number, number] {
  if (!statName || statName === 'spe') return speedRange(base, nature);
  const modifier =
    nature && statName ? (nature.plus === statName ? 1.1 : nature.minus === statName ? 0.9 : 1) : undefined;
  const stat = (iv: number, ev: number, multiplier: number) =>
    Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * 50) / 100) + 5) * multiplier);
  return modifier === undefined
    ? [stat(0, 0, 0.9), stat(31, 252, 1.1)]
    : [stat(0, 0, modifier), stat(31, 252, modifier)];
}

function hpRange(base: number): [number, number] {
  const hp = (iv: number, ev: number) => Math.floor(((2 * base + iv + Math.floor(ev / 4)) * 50) / 100) + 50 + 10;
  return [hp(0, 0), hp(31, 252)];
}

function effectivenessLabel(mod: number): string {
  if (mod === 0) return 'immune (0x)';
  if (mod === 1) return 'neutral (1x)';
  if (mod === 2) return 'super-effective (2x)';
  if (mod === 4) return 'super-effective (4x)';
  if (mod === 0.5) return 'not very effective (0.5x)';
  if (mod === 0.25) return 'not very effective (0.25x)';
  return `${mod}x`;
}

function typeModifier(
  dex: {
    getImmunity: (source: string, target: string[]) => boolean;
    getEffectiveness: (source: string, target: string[]) => number;
  },
  attackType: string,
  defenderTypes: string[],
): number {
  if (!dex.getImmunity(attackType, defenderTypes)) return 0;
  return 2 ** dex.getEffectiveness(attackType, defenderTypes);
}

function asFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const TYPE_BOOST_ITEMS: Record<string, string> = {
  charcoal: 'Fire',
  mysticwater: 'Water',
  miracleseed: 'Grass',
  magnet: 'Electric',
  nevermeltice: 'Ice',
  blackbelt: 'Fighting',
  poisonbarb: 'Poison',
  softsand: 'Ground',
  sharpbeak: 'Flying',
  twistedspoon: 'Psychic',
  silverpowder: 'Bug',
  hardstone: 'Rock',
  spelltag: 'Ghost',
  dragonfang: 'Dragon',
  blackglasses: 'Dark',
  metalcoat: 'Steel',
  fairyfeather: 'Fairy',
};

export class ShowdownReference {
  private readonly dex;

  constructor(
    readonly format: string,
    readonly psDir = defaultPsDir(),
  ) {
    this.dex = loadShowdown(psDir).Dex.forFormat(format);
  }

  get revision(): string {
    return showdownCommit(this.psDir).slice(0, 12);
  }

  /** Compact always-on context: typing, speed band, move type/BP only. */
  renderCompact(mons: CompactMon[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const mon of mons) {
      const species = this.dex.species.get(mon.species);
      if (!species.exists) continue;
      const key = `${species.id}|${id(mon.nature ?? '')}|${id(mon.item ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const nature = mon.nature ? this.dex.natures.get(mon.nature) : undefined;
      const knownNature = nature?.exists ? nature : undefined;
      const [low, high] = speedRange(species.baseStats.spe, knownNature);
      const speed = knownNature ? `Spe ${low}-${high} ${knownNature.name}` : `Spe ${low}-${high}`;
      const moveBits = uniqueNames(mon.moves ?? [])
        .flatMap((moveName) => {
          const move = this.dex.moves.get(moveName);
          if (!move.exists) return [];
          const power = move.basePower ? String(move.basePower) : '—';
          return [`${move.name} ${move.type}/${move.category}/${power}`];
        })
        .slice(0, 6);
      const active = mon.active ? 'active; ' : '';
      lines.push(
        `- ${species.name}: ${species.types.join('/')}; ${active}${speed}${mon.item ? `; item ${mon.item}` : ''}${
          moveBits.length ? `; moves ${moveBits.join(', ')}` : ''
        }`,
      );
    }
    return lines.length ? [`Compact Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  renderActiveMatchups(attackers: MatchupMon[], defenders: MatchupMon[]): string[] {
    const lines: string[] = [];
    for (const attacker of attackers) {
      const species = this.dex.species.get(attacker.species);
      if (!species.exists) continue;
      for (const moveName of uniqueNames(attacker.moves)) {
        const move = this.dex.moves.get(moveName);
        if (!move.exists || move.category === 'Status' || !move.type || move.type === '???') continue;
        const bits: string[] = [];
        for (const defender of defenders) {
          if (attacker.ally && defender.ally) continue;
          const target = this.dex.species.get(defender.species);
          if (!target.exists) continue;
          const mod = typeModifier(this.dex, move.type, target.types);
          bits.push(`${target.name} ${effectivenessLabel(mod)}`);
        }
        if (bits.length) lines.push(`- ${species.name} ${move.name} (${move.type}): ${bits.join('; ')}`);
      }
    }
    return lines;
  }

  render(query: ReferenceQuery = {}): string[] {
    const speciesSets: SpeciesSet[] = [
      ...(query.speciesSets ?? []),
      ...(query.speciesItems ?? []).map(([name, item]): SpeciesSet => [name, item]),
    ];
    const moves = uniqueNames(query.moves ?? []);
    const items = uniqueNames([...(query.items ?? []), ...speciesSets.map((set) => set[1])]);
    const abilities = uniqueNames(query.abilities ?? []);
    const natures = uniqueNames([...(query.natures ?? []), ...speciesSets.map((set) => set[2])]);
    const lines: string[] = [];

    const speciesGroups = new Map<string, { species: Dex.Species; sets: SpeciesSet[] }>();
    for (const set of speciesSets) {
      const species = this.dex.species.get(set[0]);
      if (!species.exists) continue;
      const group = speciesGroups.get(species.id) ?? { species, sets: [] };
      if (!group.sets.some((current) => JSON.stringify(current.slice(1)) === JSON.stringify(set.slice(1))))
        group.sets.push(set);
      speciesGroups.set(species.id, group);
    }
    for (const { species, sets } of [...speciesGroups.values()].sort((a, b) =>
      id(a.species.name).localeCompare(id(b.species.name)),
    )) {
      const abilityNames = uniqueNames(Object.values(species.abilities));
      const details = [
        species.types.join('/'),
        baseStats(species.baseStats),
        ...(abilityNames.length ? [`abilities ${abilityNames.join('/')}`] : []),
      ];
      if (species.forme) details.push(`forme ${species.forme}`);
      for (const [, , natureName] of sets) {
        const nature = natureName ? this.dex.natures.get(natureName) : undefined;
        const knownNature = nature?.exists ? nature : undefined;
        const [low, high] = speedRange(species.baseStats.spe, knownNature);
        const detail = knownNature
          ? `Speed ${low}-${high} with ${knownNature.name} alignment (full legal IV/EV range)`
          : `Speed ${low}-${high} (full legal IV/EV/nature range)`;
        if (!details.includes(detail)) details.push(detail);
      }
      for (const itemName of uniqueNames(sets.map((set) => set[1]))) {
        const item = this.dex.items.get(itemName);
        if (!item.exists || !item.megaStone) continue;
        for (const formeName of species.otherFormes ?? []) {
          const mega = this.dex.species.get(formeName);
          if (!mega.exists || !/^Mega(?:-|$)/.test(mega.forme)) continue;
          const target = typeof item.megaStone === 'string' ? item.megaStone : item.megaStone[species.name];
          if (id(target ?? '') !== id(mega.name)) continue;
          const ranges = sets.flatMap(([, visibleItem, natureName]) => {
            if (id(visibleItem ?? '') !== id(itemName)) return [];
            const nature = natureName ? this.dex.natures.get(natureName) : undefined;
            const knownNature = nature?.exists ? nature : undefined;
            const [low, high] = speedRange(mega.baseStats.spe, knownNature);
            return [`Speed ${low}-${high}${knownNature ? ` with ${knownNature.name} alignment` : ''}`];
          });
          const megaAbilities = uniqueNames(Object.values(mega.abilities));
          for (const ability of megaAbilities)
            if (!abilities.some((current) => id(current) === id(ability))) abilities.push(ability);
          details.push(
            `with ${item.name} -> ${mega.name} (${mega.types.join('/')}, ${baseStats(mega.baseStats)}, abilities ${megaAbilities.join('/')}${ranges.length ? `; ${[...new Set(ranges)].sort().join(', ')}` : ''})`,
          );
        }
      }
      lines.push(`- Species ${species.name}: ${details.join('; ')}`);
    }

    for (const name of moves) {
      const move = this.dex.moves.get(name);
      if (!move.exists) continue;
      const details = [
        move.type,
        move.category,
        move.basePower ? `BP ${move.basePower}` : 'BP —',
        move.accuracy === true ? 'always hits' : `acc ${move.accuracy}%`,
        `priority ${move.priority >= 0 ? '+' : ''}${move.priority}`,
        `target ${move.target}`,
      ];
      const description = cleanDescription(move.desc || move.shortDesc);
      if (description) details.push(description);
      lines.push(`- Move ${move.name}: ${details.join('; ')}`);
    }
    for (const name of items) {
      const item = this.dex.items.get(name);
      const description = item.exists ? cleanDescription(item.shortDesc || item.desc) : '';
      if (description) lines.push(`- Item ${item.name}: ${description}`);
    }
    for (const name of abilities) {
      const ability = this.dex.abilities.get(name);
      const description = ability.exists ? cleanDescription(ability.shortDesc || ability.desc) : '';
      if (description) lines.push(`- Ability ${ability.name}: ${description}`);
    }
    for (const name of natures) {
      const nature = this.dex.natures.get(name);
      if (!nature.exists) continue;
      lines.push(
        nature.plus && nature.minus
          ? `- Stat alignment ${nature.name} (Showdown Nature): +${nature.plus}, -${nature.minus}`
          : `- Stat alignment ${nature.name} (Showdown Nature): neutral`,
      );
    }
    return lines.length ? [`Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  lookup(name: string, args: Record<string, unknown> = {}): string {
    const value = typeof args.name === 'string' ? args.name : '';
    if (name === 'lookup_species') return this.lookupSpecies(value, args.item, args.nature);
    if (name === 'lookup_move') return this.lookupOne('Move', value, { moves: [value] });
    if (name === 'lookup_item') return this.lookupOne('Item', value, { items: [value] });
    if (name === 'lookup_ability') return this.lookupOne('Ability', value, { abilities: [value] });
    if (name === 'lookup_nature') return this.lookupOne('Nature', value, { natures: [value] }, '- Stat alignment ');
    if (name === 'lookup_matchup') return this.lookupMatchup(args);
    if (name === 'estimate_damage') return this.estimateDamage(args);
    return `Unknown tool: ${name}`;
  }

  lookupSpecies(name: string, item?: unknown, nature?: unknown): string {
    if (!name.trim()) return 'Species name is required.';
    const lines = this.render({
      speciesSets: [
        [
          name,
          typeof item === 'string' && item.trim() ? item : null,
          typeof nature === 'string' && nature.trim() ? nature : null,
        ],
      ],
    });
    return (
      lines.find((line) => line.startsWith('- Species ')) ??
      `No species data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }

  private lookupMatchup(args: Record<string, unknown>): string {
    const defenderName = typeof args.defender === 'string' ? args.defender : '';
    if (!defenderName.trim()) return 'defender is required.';
    const defender = this.dex.species.get(defenderName);
    if (!defender.exists) return `No species data for ${JSON.stringify(defenderName)} in ${this.format}.`;
    let attackType = typeof args.attacker_type === 'string' ? args.attacker_type : '';
    let moveName = typeof args.move === 'string' ? args.move : '';
    if (moveName.trim()) {
      const move = this.dex.moves.get(moveName);
      if (!move.exists) return `No move data for ${JSON.stringify(moveName)} in ${this.format}.`;
      attackType = move.type;
      moveName = move.name;
    }
    if (!attackType.trim()) return 'Provide move or attacker_type.';
    const type = this.dex.types.get(attackType);
    if (!type.exists) return `No type data for ${JSON.stringify(attackType)}.`;
    const mod = typeModifier(this.dex, type.name, defender.types);
    const source = moveName ? `${moveName} (${type.name})` : type.name;
    return `${source} into ${defender.name} (${defender.types.join('/')}): ${effectivenessLabel(mod)}.`;
  }

  private estimateDamage(args: Record<string, unknown>): string {
    const attackerName = typeof args.attacker === 'string' ? args.attacker : '';
    const defenderName = typeof args.defender === 'string' ? args.defender : '';
    const moveName = typeof args.move === 'string' ? args.move : '';
    if (!attackerName.trim() || !defenderName.trim() || !moveName.trim())
      return 'attacker, defender, and move are required.';
    const attacker = this.dex.species.get(attackerName);
    const defender = this.dex.species.get(defenderName);
    const move = this.dex.moves.get(moveName);
    if (!attacker.exists) return `No species data for ${JSON.stringify(attackerName)}.`;
    if (!defender.exists) return `No species data for ${JSON.stringify(defenderName)}.`;
    if (!move.exists) return `No move data for ${JSON.stringify(moveName)}.`;
    if (move.category === 'Status' || !move.basePower)
      return `${move.name} is not a standard damaging move with a base power; no estimate.`;

    const attackerNatureName = typeof args.attacker_nature === 'string' ? args.attacker_nature : undefined;
    const defenderNatureName = typeof args.defender_nature === 'string' ? args.defender_nature : undefined;
    const attackerNature = attackerNatureName ? this.dex.natures.get(attackerNatureName) : undefined;
    const defenderNature = defenderNatureName ? this.dex.natures.get(defenderNatureName) : undefined;
    const attackStat = move.category === 'Special' ? 'spa' : 'atk';
    const defenseStat = move.category === 'Special' ? 'spd' : 'def';
    const exact = args.attacker_stats && typeof args.attacker_stats === 'object' ? args.attacker_stats : undefined;
    const exactAttack = exact && asFinite((exact as Record<string, unknown>)[attackStat]);
    const [atkLow, atkHigh] =
      exactAttack !== undefined
        ? [exactAttack, exactAttack]
        : statRange(attacker.baseStats[attackStat], attackerNature?.exists ? attackerNature : undefined, attackStat);
    const [defLow, defHigh] = statRange(
      defender.baseStats[defenseStat],
      defenderNature?.exists ? defenderNature : undefined,
      defenseStat,
    );
    const [hpLow, hpHigh] = hpRange(defender.baseStats.hp);
    let defenderHp = asFinite(args.defender_hp);
    let defenderMaxHp = asFinite(args.defender_max_hp);
    let hpPercent = asFinite(args.defender_hp_percent);
    // Showdown shows foe HP as x/100; a "max HP" below the species' legal floor is that percent scale.
    if (defenderMaxHp !== undefined && defenderMaxHp < hpLow) {
      if (hpPercent === undefined && defenderHp !== undefined && defenderMaxHp > 0)
        hpPercent = (100 * defenderHp) / defenderMaxHp;
      defenderHp = undefined;
      defenderMaxHp = undefined;
    }

    let power = move.basePower;
    const weather = typeof args.weather === 'string' ? id(args.weather) : '';
    let moveType = move.type;
    if (id(move.name) === 'weatherball') {
      if (weather.includes('sun')) {
        moveType = 'Fire';
        power = 100;
      } else if (weather.includes('rain')) {
        moveType = 'Water';
        power = 100;
      } else if (weather.includes('sand')) {
        moveType = 'Rock';
        power = 100;
      } else if (weather.includes('snow') || weather.includes('hail')) {
        moveType = 'Ice';
        power = 100;
      }
    }
    if (id(move.name) === 'eruption' || id(move.name) === 'waterspout') {
      const hp = asFinite(args.attacker_hp);
      const maxHp = asFinite(args.attacker_max_hp);
      if (hp !== undefined && maxHp && maxHp > 0) power = Math.max(1, Math.floor((power * hp) / maxHp));
    }

    const typeMod = typeModifier(this.dex, moveType, defender.types);
    if (typeMod === 0) return `${attacker.name} ${move.name} into ${defender.name}: immune (0 damage).`;

    let weatherMod = 1;
    if (weather.includes('sun') && moveType === 'Fire') weatherMod = 1.5;
    if (weather.includes('sun') && moveType === 'Water') weatherMod = 0.5;
    if (weather.includes('rain') && moveType === 'Water') weatherMod = 1.5;
    if (weather.includes('rain') && moveType === 'Fire') weatherMod = 0.5;

    const stab = attacker.types.includes(moveType) ? 1.5 : 1;
    const itemName = typeof args.attacker_item === 'string' ? args.attacker_item : '';
    const item = itemName ? this.dex.items.get(itemName) : undefined;
    let itemMod = 1;
    if (item?.exists) {
      if (id(item.name) === 'lifeorb') itemMod = 1.3;
      else if (id(item.name) === 'choiceband' && move.category === 'Physical') itemMod = 1.5;
      else if (id(item.name) === 'choicespecs' && move.category === 'Special') itemMod = 1.5;
      else if (TYPE_BOOST_ITEMS[id(item.name)] === moveType) itemMod = 1.2;
    }

    const spreadDefault = ['allAdjacent', 'allAdjacentFoes', 'all'].includes(move.target);
    const isSpread = typeof args.is_spread_hit === 'boolean' ? args.is_spread_hit : spreadDefault;
    const spreadMod = isSpread ? 0.75 : 1;

    const roll = (attack: number, defense: number, random: number) => {
      const base = Math.floor(Math.floor((Math.floor((2 * 50) / 5 + 2) * power * attack) / defense) / 50) + 2;
      return Math.max(
        1,
        Math.floor(
          Math.floor(Math.floor(Math.floor(Math.floor(base * weatherMod) * stab) * typeMod) * itemMod * spreadMod) *
            random,
        ),
      );
    };

    const minDamage = roll(atkLow, defHigh, 0.85);
    const maxDamage = roll(atkHigh, defLow, 1);
    const pct = (damage: number, hp: number) => Math.round((damage / hp) * 1000) / 10;
    let hpText: string;
    if (defenderHp !== undefined || defenderMaxHp !== undefined) {
      const basis = defenderHp ?? defenderMaxHp!;
      hpText = `${pct(minDamage, basis)}-${pct(maxDamage, basis)}% of ${defenderHp !== undefined ? 'current' : 'max'} HP ${basis}`;
    } else {
      hpText = `${pct(minDamage, hpHigh)}-${pct(maxDamage, hpLow)}% of max HP (legal max HP ${hpLow}-${hpHigh})`;
      if (hpPercent !== undefined)
        hpText += `; defender shown at ${Math.round(hpPercent)}%—KO only when damage % exceeds that`;
    }
    const exactNote =
      exactAttack !== undefined ? 'attacker attack stat exact from request; ' : 'attacker attack stat legal range; ';
    const defNote = 'defender defense/HP use open-sheet legal EV/IV ranges only (no private foe values).';
    return [
      `${attacker.name} ${move.name} (${moveType} ${move.category} BP ${power}) into ${defender.name}:`,
      `damage ${minDamage}-${maxDamage} (${hpText})`,
      `type ${effectivenessLabel(typeMod)}; STAB ${stab}x; weather ${weatherMod}x; item ${itemMod}x; spread ${spreadMod}x.`,
      `${exactNote}${defNote}`,
      'Not modeled: abilities, stat boosts, burn, screens, terrain—adjust the range yourself when these apply.',
    ].join(' ');
  }

  private lookupOne(kind: string, name: string, query: ReferenceQuery, prefix = `- ${kind} `): string {
    if (!name.trim()) return `${kind} name is required.`;
    return (
      this.render(query).find((line) => line.startsWith(prefix)) ??
      `No ${kind.toLowerCase()} data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }
}
