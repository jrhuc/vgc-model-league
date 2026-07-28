import { createHash } from 'node:crypto';
import type { Battle, Dex } from 'pokemon-showdown';
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
    'Look up a species: typing, abilities, base stats, forme, Mega Stone outcomes, and optional nature-based raw Speed range.',
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
    'calculate_stats',
    'Calculate exact raw stats for a proposed spread using this format simulator, including Champions Stat Points and fixed maximum IVs.',
    {
      species: { type: 'string' },
      nature: { type: 'string' },
      evs: {
        type: 'object',
        description: 'Format investment values: Stat Points in Champions, EVs elsewhere. Omitted stats are 0.',
        properties: {
          hp: { type: 'integer', minimum: 0 },
          atk: { type: 'integer', minimum: 0 },
          def: { type: 'integer', minimum: 0 },
          spa: { type: 'integer', minimum: 0 },
          spd: { type: 'integer', minimum: 0 },
          spe: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    ['species', 'nature', 'evs'],
  ),
  tool(
    'lookup_matchup',
    'Look up type-chart effectiveness for an attacking move or type into a defending species. Returns immunity/SE/NVE multipliers only, not damage.',
    {
      attacker: {
        type: 'string',
        description: 'Attacking species, required for form-dependent moves such as Raging Bull.',
      },
      attacker_type: { type: 'string', description: 'Attacking type, or omit when move is provided.' },
      move: { type: 'string', description: 'Move name; its contextual type is used when provided.' },
      defender: { type: 'string', description: 'Defending species name.' },
    },
    ['defender'],
  ),
  tool(
    'estimate_damage',
    "Estimate Gen 9 level-50 damage in doubles as a percentage range from base stats, STAB, type chart, weather, common items, and spread reduction. Ignores abilities, boosts, burn, screens, and terrain. Supply your own Pokémon's exact battle stats on whichever side is yours to narrow the range; opposing stats use format-legal investment ranges from the open team sheet nature only. Never invent hidden investment or raw HP.",
    {
      attacker: { type: 'string' },
      defender: { type: 'string' },
      move: { type: 'string' },
      attacker_stats: {
        type: 'object',
        description: 'Optional exact positive attacker stats from your request (atk/def/spa/spd/spe).',
        properties: {
          atk: { type: 'number', exclusiveMinimum: 0 },
          def: { type: 'number', exclusiveMinimum: 0 },
          spa: { type: 'number', exclusiveMinimum: 0 },
          spd: { type: 'number', exclusiveMinimum: 0 },
          spe: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      defender_stats: {
        type: 'object',
        description:
          'Optional exact positive defender stats when the defender is your own Pokémon (hp/atk/def/spa/spd/spe).',
        properties: {
          hp: { type: 'number', exclusiveMinimum: 0 },
          atk: { type: 'number', exclusiveMinimum: 0 },
          def: { type: 'number', exclusiveMinimum: 0 },
          spa: { type: 'number', exclusiveMinimum: 0 },
          spd: { type: 'number', exclusiveMinimum: 0 },
          spe: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
      attacker_hp_percent: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Current attacker HP percentage for HP-scaling moves.',
      },
      defender_hp_percent: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Current defender HP percentage shown in battle.',
      },
      attacker_item: { type: 'string' },
      defender_item: {
        type: 'string',
        description: 'Modeled: Assault Vest and Eviolite only. Other defensive items are ignored.',
      },
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

export interface CompactMonReference {
  types: string;
  speed: string;
  moves: Readonly<Record<string, string>>;
  mega?: string;
}

export interface SpeedProfileInput {
  species: string;
  nature?: string | null;
  exact?: number;
  item?: string | null;
  itemConsumed?: boolean;
  ability?: string | null;
  status?: string | null;
  boost?: number;
  tailwind?: boolean;
  weather?: string | null;
  terrain?: string | null;
}

export interface SpeedProfile {
  raw: [number, number];
  effective: [number, number];
  modifiers: string[];
}

export interface MatchupMon {
  species: string;
  moves: string[];
  ally?: boolean;
}

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalWeather(value: string): string {
  return id(value.replace(/\s*\(\d+\s+turns?\s+left\)\s*$/i, ''));
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
  return `base stats HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}`;
}

const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
type StatId = (typeof STAT_IDS)[number];
type BattleStatCalculator = Pick<Battle, 'dex' | 'ruleTable' | 'statModify'>;
type PokemonSet = Parameters<Battle['statModify']>[1];

function investmentLimits(battle: BattleStatCalculator): { perStat: number; total: number | null; fixedIvs: boolean } {
  const champions = battle.dex.currentMod.startsWith('champions');
  const total = battle.ruleTable.evLimit;
  return {
    perStat: champions ? 32 : total === 0 ? 0 : Math.min(252, total ?? 252),
    total,
    fixedIvs: champions,
  };
}

function statSet(battle: BattleStatCalculator, nature: string, evs: Dex.StatsTable, ivs: Dex.StatsTable): PokemonSet {
  const level =
    battle.ruleTable.adjustLevel ??
    battle.ruleTable.adjustLevelDown ??
    battle.ruleTable.defaultLevel ??
    battle.ruleTable.maxLevel ??
    100;
  return { name: '', species: '', item: '', ability: '', moves: [], nature, gender: '', evs, ivs, level };
}

function statRange(
  battle: BattleStatCalculator,
  baseStats: Dex.StatsTable,
  nature: { name: string } | undefined,
  statName: Exclude<StatId, 'hp'>,
): [number, number] {
  const limits = investmentLimits(battle);
  const natures = battle.dex.natures.all();
  const lowNature =
    nature?.name ??
    natures.find((entry: { minus?: string; name: string }) => entry.minus === statName)?.name ??
    'Serious';
  const highNature =
    nature?.name ??
    natures.find((entry: { plus?: string; name: string }) => entry.plus === statName)?.name ??
    'Serious';
  const lowEvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, 0])) as Dex.StatsTable;
  const highEvs = Object.fromEntries(
    STAT_IDS.map((stat) => [stat, stat === statName ? limits.perStat : 0]),
  ) as Dex.StatsTable;
  const lowIvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, limits.fixedIvs ? 31 : 0])) as Dex.StatsTable;
  const highIvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, 31])) as Dex.StatsTable;
  return [
    battle.statModify(baseStats, statSet(battle, lowNature, lowEvs, lowIvs), statName),
    battle.statModify(baseStats, statSet(battle, highNature, highEvs, highIvs), statName),
  ];
}

function hpRange(battle: BattleStatCalculator, baseStats: Dex.StatsTable): [number, number] {
  const limits = investmentLimits(battle);
  const lowEvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, 0])) as Dex.StatsTable;
  const highEvs = Object.fromEntries(
    STAT_IDS.map((stat) => [stat, stat === 'hp' ? limits.perStat : 0]),
  ) as Dex.StatsTable;
  const lowIvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, limits.fixedIvs ? 31 : 0])) as Dex.StatsTable;
  const highIvs = Object.fromEntries(STAT_IDS.map((stat) => [stat, 31])) as Dex.StatsTable;
  return [
    battle.statModify(baseStats, statSet(battle, 'Serious', lowEvs, lowIvs), 'hp'),
    battle.statModify(baseStats, statSet(battle, 'Serious', highEvs, highIvs), 'hp'),
  ];
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

// The per-type factors let a model with a wrong internal chart see exactly which pairing it misremembers
// instead of dismissing the combined multiplier as a tool bug.
function effectivenessDetail(
  dex: {
    getImmunity: (source: string, target: string[]) => boolean;
    getEffectiveness: (source: string, target: string[]) => number;
  },
  attackType: string,
  defenderTypes: string[],
): string {
  const mod = typeModifier(dex, attackType, defenderTypes);
  const parts = defenderTypes.map((type) => `vs ${type} ${typeModifier(dex, attackType, [type])}x`);
  return `${effectivenessLabel(mod)} = ${attackType} ${parts.join(' × ')}`;
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

const WEATHER_BALL_TYPE: Record<string, string> = {
  sun: 'Fire',
  sunnyday: 'Fire',
  desolateland: 'Fire',
  rain: 'Water',
  raindance: 'Water',
  primordialsea: 'Water',
  sand: 'Rock',
  sandstorm: 'Rock',
  snow: 'Ice',
  snowscape: 'Ice',
  hail: 'Ice',
};

function weatherBallOverride(moveId: string, weather: string): { type: string; power: number } | null {
  const type = WEATHER_BALL_TYPE[weather];
  return moveId === 'weatherball' && type ? { type, power: 100 } : null;
}

const RAGING_BULL_TYPE: Record<string, string> = {
  taurospaldeacombat: 'Fighting',
  taurospaldeablaze: 'Fire',
  taurospaldeaaqua: 'Water',
};

function speciesMoveType(moveId: string, defaultType: string, speciesName: string): string {
  return moveId === 'ragingbull' ? (RAGING_BULL_TYPE[id(speciesName)] ?? defaultType) : defaultType;
}

const SPEED_HALVING_ITEMS = new Set([
  'ironball',
  'machobrace',
  'poweranklet',
  'powerband',
  'powerbelt',
  'powerbracer',
  'powerlens',
  'powerweight',
]);

function modifyRange(range: [number, number], numerator: number, denominator = 1): [number, number] {
  return [
    Math.max(1, Math.floor((range[0] * numerator) / denominator)),
    Math.max(1, Math.floor((range[1] * numerator) / denominator)),
  ];
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

const TARGET_TAGS: Record<string, string> = {
  allAdjacentFoes: 'spread',
  allAdjacent: 'spread+ally',
  self: 'self',
  adjacentAlly: 'ally',
  adjacentAllyOrSelf: 'ally/self',
  allySide: 'ally-side',
  allyTeam: 'ally-side',
  allies: 'ally-side',
  foeSide: 'foe-side',
  all: 'field',
  any: 'any-range',
  randomNormal: 'random-foe',
};

export class ShowdownReference {
  private readonly dex;
  private readonly battle: Battle;

  constructor(
    readonly format: string,
    readonly psDir = defaultPsDir(),
  ) {
    const { Battle, Dex } = loadShowdown(psDir);
    const resolvedFormat = Dex.formats.get(format);
    this.dex = Dex.forFormat(resolvedFormat);
    this.battle = new Battle({ formatid: resolvedFormat.id, format: resolvedFormat });
  }

  get revision(): string {
    return showdownCommit(this.psDir).slice(0, 12);
  }

  static renderRevision(): string {
    const prototype = ShowdownReference.prototype as unknown as Record<string, unknown>;
    const surfaces = [
      Object.getOwnPropertyDescriptor(ShowdownReference.prototype, 'revision')?.get,
      ShowdownReference.prototype.renderCompact,
      ShowdownReference.prototype.describeCompact,
      ShowdownReference.prototype.speedProfile,
      ShowdownReference.prototype.movePriority,
      ShowdownReference.prototype.renderActiveMatchups,
      ShowdownReference.prototype.render,
      ShowdownReference.prototype.lookup,
      prototype.lookupSpecies,
      prototype.lookupOne,
      prototype.lookupMatchup,
      prototype.estimateDamage,
      id,
      canonicalWeather,
      uniqueNames,
      cleanDescription,
      baseStats,
      statRange,
      hpRange,
      investmentLimits,
      statSet,
      effectivenessLabel,
      effectivenessDetail,
      typeModifier,
      asFinite,
      weatherBallOverride,
      speciesMoveType,
      JSON.stringify(RAGING_BULL_TYPE),
      JSON.stringify(WEATHER_BALL_TYPE),
      JSON.stringify(SPEED_HALVING_ITEMS),
      JSON.stringify(TYPE_BOOST_ITEMS),
    ];
    return createHash('sha256')
      .update(surfaces.map((surface) => String(surface)).join('\n'))
      .digest('hex')
      .slice(0, 12);
  }

  renderCompact(mons: CompactMon[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const mon of mons) {
      const species = this.dex.species.get(mon.species);
      if (!species.exists) continue;
      const key = `${species.id}|${id(mon.nature ?? '')}|${id(mon.item ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reference = this.describeCompact(mon);
      if (!reference) continue;
      const moves = uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const detail = reference.moves[id(moveName)];
        return detail ? [`${moveName} ${detail}`] : [];
      });
      const active = mon.active ? 'active; ' : '';
      lines.push(
        `- ${species.name}: ${reference.types}; ${active}raw Speed ${reference.speed}${mon.item ? `; item ${mon.item}` : ''}${
          reference.mega ? ` (${reference.mega})` : ''
        }${moves.length ? `; moves ${moves.join(', ')}` : ''}`,
      );
    }
    return lines.length ? [`Compact Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  describeCompact(mon: CompactMon): CompactMonReference | undefined {
    const species = this.dex.species.get(mon.species);
    if (!species.exists) return undefined;
    const nature = mon.nature ? this.dex.natures.get(mon.nature) : undefined;
    const knownNature = nature?.exists ? nature : undefined;
    const [low, high] = statRange(this.battle, species.baseStats, knownNature, 'spe');
    const moves = Object.fromEntries(
      uniqueNames(mon.moves ?? []).flatMap((moveName) => {
        const move = this.dex.moves.get(moveName);
        if (!move.exists) return [];
        const power = move.basePower ? String(move.basePower) : 'no power';
        const moveType = speciesMoveType(move.id, move.type, species.name);
        const details = [`${moveType}/${move.category}/${power}`];
        if (move.target !== 'normal') details.push(TARGET_TAGS[move.target] ?? move.target);
        if (move.priority) details.push(`priority ${move.priority > 0 ? '+' : ''}${move.priority}`);
        if (move.accuracy !== true && move.accuracy < 100) details.push(`accuracy ${move.accuracy}%`);
        if (move.flags.powder)
          details.push('powder: fails on Grass types, Overcoat, and Safety Goggles (including redirection)');
        return [[move.id, details.join('/')]];
      }),
    );
    const mega: string[] = [];
    const item = mon.item ? this.dex.items.get(mon.item) : undefined;
    if (item?.exists && item.megaStone) {
      for (const formeName of species.otherFormes ?? []) {
        const forme = this.dex.species.get(formeName);
        if (!forme.exists || !/^Mega(?:-|$)/.test(forme.forme)) continue;
        const target = typeof item.megaStone === 'string' ? item.megaStone : item.megaStone[species.name];
        if (id(target ?? '') !== id(forme.name)) continue;
        const [megaLow, megaHigh] = statRange(this.battle, forme.baseStats, knownNature, 'spe');
        mega.push(
          `if Mega Evolved -> ${forme.name}: ${forme.types.join('/')}, ability ${uniqueNames(Object.values(forme.abilities)).join('/')}, ${baseStats(forme.baseStats)}, raw Speed ${megaLow}-${megaHigh}`,
        );
      }
    }
    return {
      types: species.types.join('/'),
      speed: `${low}-${high}`,
      moves,
      ...(mega.length ? { mega: mega.join('; ') } : {}),
    };
  }

  speedProfile(input: SpeedProfileInput): SpeedProfile | undefined {
    const species = this.dex.species.get(input.species);
    if (!species.exists) return undefined;
    const nature = input.nature ? this.dex.natures.get(input.nature) : undefined;
    const exact = Number.isInteger(input.exact) && input.exact! > 0 ? input.exact : undefined;
    const raw: [number, number] =
      exact === undefined
        ? statRange(this.battle, species.baseStats, nature?.exists ? nature : undefined, 'spe')
        : [exact, exact];
    const stage = Math.max(-6, Math.min(6, Math.trunc(input.boost ?? 0)));
    let effective = stage >= 0 ? modifyRange(raw, 2 + stage, 2) : modifyRange(raw, 2, 2 - stage);
    const modifiers: string[] = [];
    if (stage) modifiers.push(`Speed stage ${stage > 0 ? '+' : ''}${stage}`);

    const fallbackAbility = Object.values(species.abilities)[0];
    const ability = id(input.ability || fallbackAbility || '');
    const weather = canonicalWeather(input.weather ?? '');
    const terrain = id(input.terrain ?? '');
    let numerator = 1;
    let denominator = 1;
    const multiply = (label: string, top: number, bottom = 1) => {
      numerator *= top;
      denominator *= bottom;
      modifiers.push(label);
    };
    if (
      (ability === 'chlorophyll' && ['sun', 'sunnyday', 'desolateland'].includes(weather)) ||
      (ability === 'swiftswim' && ['rain', 'raindance', 'primordialsea'].includes(weather)) ||
      (ability === 'sandrush' && ['sand', 'sandstorm'].includes(weather)) ||
      (ability === 'slushrush' && ['hail', 'snow', 'snowscape'].includes(weather))
    )
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === 'surgesurfer' && ['electricterrain', 'electric'].includes(terrain))
      multiply(`${input.ability || fallbackAbility} ×2`, 2);
    if (ability === 'quickfeet' && input.status) multiply(`${input.ability || fallbackAbility} ×1.5`, 3, 2);
    if (ability === 'unburden' && input.itemConsumed) multiply(`${input.ability || fallbackAbility} ×2`, 2);

    const item = input.itemConsumed ? '' : id(input.item ?? '');
    if (item === 'choicescarf') multiply('Choice Scarf ×1.5', 3, 2);
    else if (SPEED_HALVING_ITEMS.has(item)) multiply(`${input.item} ×0.5`, 1, 2);
    if (input.tailwind) multiply('Tailwind ×2', 2);
    if (id(input.status ?? '') === 'par' && ability !== 'quickfeet') multiply('paralysis ×0.5', 1, 2);
    effective = modifyRange(effective, numerator, denominator);
    return { raw, effective, modifiers };
  }

  movePriority(name: string): number | undefined {
    const move = this.dex.moves.get(name);
    return move.exists ? move.priority : undefined;
  }

  renderActiveMatchups(attackers: MatchupMon[], defenders: MatchupMon[], weather = ''): string[] {
    const lines: string[] = [];
    let examined = false;
    const weatherId = canonicalWeather(weather);
    for (const attacker of attackers) {
      const species = this.dex.species.get(attacker.species);
      if (!species.exists) continue;
      for (const moveName of uniqueNames(attacker.moves)) {
        const move = this.dex.moves.get(moveName);
        if (!move.exists || move.category === 'Status' || !move.type || move.type === '???') continue;
        const override = weatherBallOverride(move.id, weatherId);
        const moveType = override?.type ?? speciesMoveType(move.id, move.type, species.name);
        const contextualType = moveType !== move.type;
        const typeLabel = override
          ? `currently ${override.type} in ${weather}`
          : contextualType
            ? `currently ${moveType} for ${species.name}`
            : moveType;
        const bits: string[] = [];
        for (const defender of defenders) {
          if (attacker.ally !== undefined && defender.ally !== undefined && attacker.ally === defender.ally) continue;
          const target = this.dex.species.get(defender.species);
          if (!target.exists) continue;
          examined = true;
          const mod = typeModifier(this.dex, moveType, target.types);
          if (mod !== 1) bits.push(`${target.name} ${effectivenessLabel(mod)}`);
        }
        if (bits.length) lines.push(`- ${species.name} ${move.name} (${typeLabel}): ${bits.join('; ')}`);
      }
    }
    if (examined) lines.push('- Damaging matchups not listed above are neutral (1x).');
    return lines;
  }

  render(query: ReferenceQuery = {}): string[] {
    const speciesSets = query.speciesSets ?? [];
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
    const fixedIvs = investmentLimits(this.battle).fixedIvs;
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
        const [low, high] = statRange(this.battle, species.baseStats, knownNature, 'spe');
        const detail = knownNature
          ? `raw Speed ${low}-${high} with ${knownNature.name} alignment (${fixedIvs ? 'fixed maximum IV/Stat Point range' : 'full legal IV/EV range'})`
          : `raw Speed ${low}-${high} (${fixedIvs ? 'fixed maximum IV/Stat Point/nature range' : 'full legal IV/EV/nature range'})`;
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
            const [low, high] = statRange(this.battle, mega.baseStats, knownNature, 'spe');
            return [`raw Speed ${low}-${high}${knownNature ? ` with ${knownNature.name} alignment` : ''}`];
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
        move.basePower ? `BP ${move.basePower}` : 'BP none',
        move.accuracy === true ? 'always hits' : `acc ${move.accuracy}%`,
        `priority ${move.priority >= 0 ? '+' : ''}${move.priority}`,
        `target ${move.target}`,
      ];
      if (move.flags.powder)
        details.push(
          'powder move: no effect on Grass types, Overcoat, or Safety Goggles holders (including redirection)',
        );
      if (move.flags.sound) details.push('sound move: blocked by Soundproof, bypasses Substitute');
      const description = cleanDescription(move.desc || move.shortDesc);
      if (description) details.push(description);
      lines.push(`- Move ${move.name}: ${details.join('; ')}`);
    }
    for (const name of items) {
      const item = this.dex.items.get(name);
      const description = item.exists ? cleanDescription(item.desc || item.shortDesc) : '';
      if (description) lines.push(`- Item ${item.name}: ${description}`);
    }
    for (const name of abilities) {
      const ability = this.dex.abilities.get(name);
      const description = ability.exists ? cleanDescription(ability.desc || ability.shortDesc) : '';
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
    if (name === 'calculate_stats') return this.calculateStats(args);
    if (name === 'lookup_matchup') return this.lookupMatchup(args);
    if (name === 'estimate_damage') return this.estimateDamage(args);
    return `Unknown tool: ${name}`;
  }

  private lookupSpecies(name: string, item?: unknown, nature?: unknown): string {
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
    const attackerName = typeof args.attacker === 'string' ? args.attacker : '';
    const attacker = attackerName ? this.dex.species.get(attackerName) : undefined;
    let attackType = typeof args.attacker_type === 'string' ? args.attacker_type : '';
    let moveName = typeof args.move === 'string' ? args.move : '';
    if (moveName.trim()) {
      const move = this.dex.moves.get(moveName);
      if (!move.exists) return `No move data for ${JSON.stringify(moveName)} in ${this.format}.`;
      if (move.id === 'ragingbull' && !attacker?.exists) return 'attacker is required to resolve Raging Bull typing.';
      attackType = speciesMoveType(move.id, move.type, attacker?.name ?? '');
      moveName = move.name;
    }
    if (!attackType.trim()) return 'Provide move or attacker_type.';
    const type = this.dex.types.get(attackType);
    if (!type.exists) return `No type data for ${JSON.stringify(attackType)}.`;
    const source = moveName ? `${moveName} (${type.name})` : type.name;
    return `${source} into ${defender.name} (${defender.types.join('/')}): ${effectivenessDetail(this.dex, type.name, defender.types)}.`;
  }

  private calculateStats(args: Record<string, unknown>): string {
    const speciesName = typeof args.species === 'string' ? args.species : '';
    const natureName = typeof args.nature === 'string' ? args.nature : '';
    if (!speciesName.trim() || !natureName.trim() || !args.evs || typeof args.evs !== 'object') {
      return 'species, nature, and evs are required.';
    }
    const species = this.dex.species.get(speciesName);
    if (!species.exists) return `No species data for ${JSON.stringify(speciesName)} in ${this.format}.`;
    const nature = this.dex.natures.get(natureName);
    if (!nature.exists) return `No nature data for ${JSON.stringify(natureName)} in ${this.format}.`;
    const raw = args.evs as Record<string, unknown>;
    const limits = investmentLimits(this.battle);
    const evs = Object.fromEntries(
      STAT_IDS.map((stat) => [stat, raw[stat] === undefined ? 0 : Number(raw[stat])]),
    ) as Dex.StatsTable;
    for (const stat of STAT_IDS) {
      if (!Number.isInteger(evs[stat]) || evs[stat] < 0 || evs[stat] > limits.perStat) {
        return `${stat} investment must be an integer from 0 to ${limits.perStat}.`;
      }
    }
    const total = STAT_IDS.reduce((sum, stat) => sum + evs[stat], 0);
    if (limits.total !== null && total > limits.total) {
      return `Total investment ${total} exceeds this format's limit of ${limits.total}.`;
    }
    const ivs = Object.fromEntries(STAT_IDS.map((stat) => [stat, 31])) as Dex.StatsTable;
    const stats = this.battle.spreadModify(species.baseStats, statSet(this.battle, nature.name, evs, ivs));
    const label = limits.fixedIvs ? 'Stat Points' : 'EVs';
    return `${species.name} (${nature.name}; ${label} ${total}${limits.total === null ? '' : `/${limits.total}`}): HP ${stats.hp}, Attack ${stats.atk}, Defense ${stats.def}, Special Attack ${stats.spa}, Special Defense ${stats.spd}, Speed ${stats.spe}.`;
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
    const suppliedAttack = exact && asFinite((exact as Record<string, unknown>)[attackStat]);
    const exactAttack = suppliedAttack !== undefined && suppliedAttack > 0 ? suppliedAttack : undefined;
    const [atkLow, atkHigh] =
      exactAttack !== undefined
        ? [exactAttack, exactAttack]
        : statRange(this.battle, attacker.baseStats, attackerNature?.exists ? attackerNature : undefined, attackStat);
    const defenderItemName = typeof args.defender_item === 'string' ? args.defender_item : '';
    const defenderItem = defenderItemName ? this.dex.items.get(defenderItemName) : undefined;
    let defenderItemMod = 1;
    if (defenderItem?.exists) {
      if (id(defenderItem.name) === 'assaultvest' && move.category === 'Special') defenderItemMod = 1.5;
      else if (id(defenderItem.name) === 'eviolite' && defender.nfe) defenderItemMod = 1.5;
    }
    const exactDefender =
      args.defender_stats && typeof args.defender_stats === 'object' ? args.defender_stats : undefined;
    const suppliedDefense = exactDefender && asFinite((exactDefender as Record<string, unknown>)[defenseStat]);
    const exactDefense = suppliedDefense !== undefined && suppliedDefense > 0 ? suppliedDefense : undefined;
    const suppliedHp = exactDefender && asFinite((exactDefender as Record<string, unknown>).hp);
    const exactHp = suppliedHp !== undefined && suppliedHp > 0 ? suppliedHp : undefined;
    let [defLow, defHigh] =
      exactDefense !== undefined
        ? [exactDefense, exactDefense]
        : statRange(this.battle, defender.baseStats, defenderNature?.exists ? defenderNature : undefined, defenseStat);
    defLow = Math.floor(defLow * defenderItemMod);
    defHigh = Math.floor(defHigh * defenderItemMod);
    const [hpLow, hpHigh] = exactHp !== undefined ? [exactHp, exactHp] : hpRange(this.battle, defender.baseStats);
    const suppliedHpPercent = asFinite(args.defender_hp_percent);
    const hpPercent = suppliedHpPercent === undefined ? undefined : Math.max(0, Math.min(100, suppliedHpPercent));

    let power = move.basePower;
    const weather = typeof args.weather === 'string' ? canonicalWeather(args.weather) : '';
    let moveType = speciesMoveType(move.id, move.type, attacker.name);
    const override = weatherBallOverride(move.id, weather);
    if (override) {
      moveType = override.type;
      power = override.power;
    }
    if (move.id === 'eruption' || move.id === 'waterspout') {
      const attackerHpPercent = asFinite(args.attacker_hp_percent);
      if (attackerHpPercent !== undefined)
        power = Math.max(1, Math.floor((power * Math.max(0, Math.min(100, attackerHpPercent))) / 100));
    }

    const typeMod = typeModifier(this.dex, moveType, defender.types);
    if (typeMod === 0)
      return `${attacker.name} ${move.name} into ${defender.name}: ${effectivenessDetail(this.dex, moveType, defender.types)}; 0% damage. Cannot KO.`;

    if (weather === 'desolateland' && moveType === 'Water')
      return `${attacker.name} ${move.name} into ${defender.name}: fails in Desolate Land; 0% damage. Cannot KO.`;
    if (weather === 'primordialsea' && moveType === 'Fire')
      return `${attacker.name} ${move.name} into ${defender.name}: fails in Primordial Sea; 0% damage. Cannot KO.`;
    const sun = WEATHER_BALL_TYPE[weather] === 'Fire';
    const rain = WEATHER_BALL_TYPE[weather] === 'Water';
    let weatherMod = 1;
    if (sun && moveType === 'Fire') weatherMod = 1.5;
    if (sun && moveType === 'Water') weatherMod = 0.5;
    if (rain && moveType === 'Water') weatherMod = 1.5;
    if (rain && moveType === 'Fire') weatherMod = 0.5;

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
    const minimumPercent = pct(minDamage, hpHigh);
    const maximumPercent = pct(maxDamage, hpLow);
    const targetPercent = hpPercent ?? 100;
    const fullHealth = targetPercent === 100;
    const guaranteed = 100 * minDamage >= targetPercent * hpHigh;
    const possible = 100 * maxDamage >= targetPercent * hpLow;
    const outcome =
      targetPercent <= 0
        ? 'Target is already at 0%.'
        : guaranteed
          ? `Guaranteed ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`} across the full legal range.`
          : possible
            ? `Possible ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`}, not guaranteed across the legal range.`
            : `Cannot ${fullHealth ? 'OHKO' : `KO from the shown ${Math.round(targetPercent)}%`} in this estimate.`;
    const shownHp = hpPercent === undefined ? '' : ` Target HP shown: ${Math.round(hpPercent)}%.`;
    const attackBasis = exactAttack !== undefined ? 'attack exact from request' : 'legal attack range';
    const defenseBasis =
      exactDefense !== undefined && exactHp !== undefined
        ? 'defense/HP exact from request'
        : exactDefense !== undefined
          ? 'defense exact from request, open-sheet HP range'
          : exactHp !== undefined
            ? 'HP exact from request, open-sheet defense range'
            : 'open-sheet defense/HP range';
    return `${attacker.name} ${move.name} (${moveType} ${move.category} BP ${power}) into ${defender.name}: ${minimumPercent}-${maximumPercent}% of maximum HP.${shownHp} ${outcome} ${effectivenessDetail(this.dex, moveType, defender.types)}; modifiers STAB ${stab}x, weather ${weatherMod}x, item ${itemMod}x, defender item ${defenderItemMod}x, spread ${spreadMod}x; ${attackBasis}, ${defenseBasis}. Omits abilities, boosts, burn, screens, terrain, and defensive items other than Assault Vest/Eviolite.`;
  }

  private lookupOne(kind: string, name: string, query: ReferenceQuery, prefix = `- ${kind} `): string {
    if (!name.trim()) return `${kind} name is required.`;
    return (
      this.render(query).find((line) => line.startsWith(prefix)) ??
      `No ${kind.toLowerCase()} data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }
}
