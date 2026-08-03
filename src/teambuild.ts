import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { completeWithDexTools } from './dex-lookups.js';
import type { DraftBoardMon } from './draft.js';
import type { TeambuildSetView, TeambuildView } from './gui/api.js';
import { defaultPsDir } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
  resolveSpecOverride,
} from './providers.js';
import { type Rng, shuffle } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import type { ShowdownApi } from './showdown.js';
import { loadShowdown } from './showdown.js';
import { normalizePackedTeam, validateTeam } from './teams.js';
import type { JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';
import { clip } from './value.js';

const TEAMBUILD_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, coach of {{team}} in a Pokémon VGC draft league, format {{format}}.',
    '',
    'You drafted a roster of {{picks}} Pokémon and keep it all season. Before every match you choose exactly 6 of them',
    'and build each set from scratch. Your private draft note is supplied below as revisable context, not a constraint.',
    '',
    'FORMAT RULES',
    '- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are open, so your opponent reads your',
    '  moves, items, abilities, and natures — but not your exact EV spreads.',
    '- Every Pokémon is set to level 50.',
    '- EVs: {{evLimit}} points total across the team member, at most {{evMax}} in any one stat. IVs are fixed at maximum.',
    '  This is the Champions EV system, not the older 508/252 one. Points are whole numbers.',
    '- Each move has at most 20 PP. There is no Terastallisation in this format.',
    '- Item Clause: no two of your six may hold the same item. Species Clause: no two may share a species.',
    '- This game has its own item list, which is shorter than the one you may expect. Many Gen 9 staples do not',
    '  exist here. Use only these items:',
    '{{items}}',
    '- Mega Evolution: a roster entry drafted as a Mega holds its Mega Stone and plays as its base forme until it',
    '  Mega Evolves; one drafted as the base forme may never hold a Mega Stone. If you register more than one Mega',
    '  entry, which of them evolves is chosen during play.',
    '',
    'You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,',
    'what a spread outruns, and how hard an attack lands before you commit EVs to it. They compute from the',
    'simulator this league runs on, so trust them over recollection — this game is newer than your training data.',
    '',
    'Choose the 6 for this specific opponent and build their sets. Reply with JSON only, in this shape:',
    '{"team_plan": "<2-5 sentences on the matchup and how these six answer it>",',
    ' "sets": [{"id": "<board-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly 6 entries in "sets", each one a board id from YOUR ROSTER below.',
  ],
  rosterHeading: 'YOUR ROSTER (board id | name | types | base stats | abilities | legal moves):',
  opponentHeading: 'OPPONENT ROSTER — {{model}} of {{team}} (they pick 6 of these):',
  draftNoteHeading: 'YOUR PRIVATE NOTE AT THE END OF THE DRAFT:',
  playoffContextHeading: 'YOUR PRIVATE CONTEXT FROM EARLIER LEAGUE MATCHES:',
  lockedItem: 'MUST hold {{item}}',
  noMega: 'cannot hold a Mega Stone',
  rejectionTemplate: 'That team was rejected:\n{{error}}\nReply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before finishing the team. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.',
  maxTokens: 65_536,
  timeoutSeconds: 900,
  attempts: 5,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 16,
  maxCallsPerRound: 8,
} as const;

export function teambuildScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(TEAMBUILD_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

interface RawSet {
  id: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  evs: Record<string, number>;
  note: string;
}

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
type Stat = (typeof STATS)[number];

export interface TeambuildResult {
  packed: string;
  view: TeambuildView;
}

export interface TeambuildOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  signal?: AbortSignal;
  recovery?: RecoveryGate;
  makeTeambuildProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
}

export interface TeambuildRequest {
  seriesIndex: number;
  entrant: number;
  opponent: number;
  stage: 'roundrobin' | 'playoff';
  model: string;
  opponentModel: string;
  teamName: string;
  opponentTeamName: string;
  roster: DraftBoardMon[];
  opponentRoster: DraftBoardMon[];
  draftNote: string;
  playoffContext: string[];
  format: string;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'model'
  );
}

type DexLike = ReturnType<ShowdownApi['Dex']['mod']>;

function legalMoves(dex: DexLike, mon: DraftBoardMon): string[] {
  const species = dex.species.get(mon.species);
  const pool = dex.species.getMovePool(species.id);
  const names: string[] = [];
  for (const id of pool) {
    const move = dex.moves.get(id);
    if (move?.exists && !move.isNonstandard) {
      names.push(move.name);
    }
  }
  return names.sort();
}

function rosterBlock(dex: DexLike, roster: DraftBoardMon[], detailed: boolean): string[] {
  const lines: string[] = [];
  for (const mon of roster) {
    const battleForme = dex.species.get(mon.forme ?? mon.species);
    const stats = battleForme.baseStats;
    const abilities = Object.values(battleForme.abilities ?? {})
      .filter(Boolean)
      .join('/');
    const constraint = mon.item
      ? TEAMBUILD_PROMPT_POLICY.lockedItem.replace('{{item}}', mon.item)
      : TEAMBUILD_PROMPT_POLICY.noMega;
    const head =
      `- ${mon.id} | ${mon.name} | ${mon.types.join('/')} | ` +
      `${stats.hp}/${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe} | ${abilities} | ${constraint}`;
    lines.push(head);
    if (detailed) {
      const base = dex.species.get(mon.species);
      const baseAbilities = Object.values(base.abilities ?? {})
        .filter(Boolean)
        .join(' or ');
      const megaAbilities = abilities;
      if (mon.forme) {
        lines.push(
          `    registers as ${base.name}: set "ability" to one of ${baseAbilities}, NOT its Mega ability — ` +
            `it becomes ${mon.forme} with ${megaAbilities} only after it Mega Evolves in battle`,
        );
      }
      lines.push(`    moves: ${legalMoves(dex, mon).join(', ')}`);
    }
  }
  return lines;
}

function isMegaStone(item: { megaStone?: unknown }): boolean {
  return Boolean(item.megaStone);
}

function legalItems(dex: DexLike): string[] {
  const names: string[] = [];
  for (const item of dex.items.all()) {
    if (item.isNonstandard || isMegaStone(item)) continue;
    names.push(item.name);
  }
  return names.sort();
}

function systemPrompt(request: TeambuildRequest, dex: DexLike, evLimit: number, evMax: number): string {
  const values: Record<string, string> = {
    model: request.model,
    team: request.teamName || request.model,
    format: request.format,
    picks: String(request.roster.length),
    evLimit: String(evLimit),
    evMax: String(evMax),
    items: `  ${legalItems(dex).join(', ')}`,
  };
  return TEAMBUILD_PROMPT_POLICY.systemTemplate
    .map((line) =>
      Object.entries(values).reduce(
        (rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value),
        line as string,
      ),
    )
    .join('\n');
}

function userPrompt(request: TeambuildRequest, dex: DexLike): string {
  const lines: string[] = [TEAMBUILD_PROMPT_POLICY.rosterHeading];
  lines.push(...rosterBlock(dex, request.roster, true));
  if (request.draftNote) lines.push('', TEAMBUILD_PROMPT_POLICY.draftNoteHeading, request.draftNote);
  lines.push(
    '',
    TEAMBUILD_PROMPT_POLICY.opponentHeading
      .replace('{{model}}', request.opponentModel)
      .replace('{{team}}', request.opponentTeamName || request.opponentModel),
  );
  lines.push(...rosterBlock(dex, request.opponentRoster, false));
  if (request.stage === 'playoff' && request.playoffContext.length) {
    lines.push(
      '',
      TEAMBUILD_PROMPT_POLICY.playoffContextHeading,
      ...request.playoffContext.map((entry) => `- ${entry}`),
    );
  }
  return lines.join('\n');
}

function parseSets(response: string, roster: DraftBoardMon[]): { sets: RawSet[]; plan: string } | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  const record = parsed as Record<string, unknown>;
  const raw = Array.isArray(record.sets) ? record.sets : undefined;
  if (!raw) return '"sets" must be an array';
  if (raw.length !== 6) return `"sets" must hold exactly 6 entries, not ${raw.length}`;
  const owned = new Map(roster.map((mon) => [mon.id, mon]));
  const sets: RawSet[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    const item = entry as Record<string, unknown>;
    const id = String(item.id ?? '')
      .trim()
      .toLowerCase();
    if (!owned.has(id)) return `"${id}" is not a board id on your roster`;
    if (used.has(id)) return `"${id}" appears twice; bring six different Pokémon`;
    used.add(id);
    const evs: Record<string, number> = {};
    const rawEvs = (item.evs ?? {}) as Record<string, unknown>;
    for (const stat of STATS) evs[stat] = Math.max(0, Math.trunc(Number(rawEvs[stat] ?? 0)) || 0);
    sets.push({
      id,
      item: String(item.item ?? '').trim(),
      ability: String(item.ability ?? '').trim(),
      nature: String(item.nature ?? '').trim(),
      moves: Array.isArray(item.moves) ? item.moves.map((move) => String(move).trim()).filter(Boolean) : [],
      evs,
      note: String(item.note ?? '').trim(),
    });
  }
  return { sets, plan: String(record.team_plan ?? '').trim() };
}

function repairSet(
  dex: DexLike,
  mon: DraftBoardMon,
  set: RawSet,
  evLimit: number,
  evMax: number,
  taken: Set<string>,
  rng: Rng,
): { set: RawSet; repairs: string[] } {
  const repairs: string[] = [];
  const base = dex.species.get(mon.species);

  const candidate = dex.items.get(set.item);
  let itemName = candidate.exists ? candidate.name : '';
  if (mon.item) {
    const required = dex.items.get(mon.item).name;
    if (itemName !== required) {
      repairs.push(`item set to ${required}, which this Mega entry is locked to`);
      itemName = required;
    }
  } else if (!itemName && set.item) {
    repairs.push(`unknown item ${JSON.stringify(set.item)} removed`);
  } else if (isMegaStone(candidate)) {
    repairs.push(`${itemName} removed: this entry was drafted as the base forme`);
    itemName = '';
  } else if (itemName && taken.has(itemName)) {
    repairs.push(`${itemName} removed: Item Clause, another of your six already holds it`);
    itemName = '';
  }
  if (itemName) taken.add(itemName);

  const abilities = Object.values(base.abilities ?? {}).filter(Boolean) as string[];
  let ability = abilities.find((name) => dex.abilities.get(name).name === dex.abilities.get(set.ability).name);
  if (!ability) {
    ability = abilities[0]!;
    repairs.push(`ability set to ${ability}, which ${base.name} can legally have`);
  }

  let nature = dex.natures.get(set.nature);
  if (!nature?.exists) {
    nature = dex.natures.get('Serious');
    repairs.push(`unknown nature ${JSON.stringify(set.nature)} replaced with Serious`);
  }

  const pool = legalMoves(dex, mon);
  const poolById = new Map(pool.map((name) => [dex.moves.get(name).id, name]));
  const moves: string[] = [];
  for (const move of set.moves) {
    const resolved = poolById.get(dex.moves.get(move).id);
    if (!resolved) {
      repairs.push(`${mon.name} cannot learn ${JSON.stringify(move)}; dropped`);
      continue;
    }
    if (!moves.includes(resolved)) moves.push(resolved);
  }
  if (!moves.length && pool.length) {
    const candidate = pool[Math.floor(rng() * pool.length)]!;
    moves.push(candidate);
    repairs.push(`filled an empty move slot with ${candidate}`);
  }

  const evs: Record<string, number> = { ...set.evs };
  for (const stat of STATS) {
    if (evs[stat]! > evMax) {
      repairs.push(`${stat} EVs clamped from ${evs[stat]} to ${evMax}`);
      evs[stat] = evMax;
    }
  }
  let total = STATS.reduce((sum, stat) => sum + evs[stat]!, 0);
  if (total > evLimit) {
    const scale = evLimit / total;
    for (const stat of STATS) evs[stat] = Math.floor(evs[stat]! * scale);
    total = STATS.reduce((sum, stat) => sum + evs[stat]!, 0);
    for (const stat of STATS) {
      if (total >= evLimit) break;
      const room = Math.min(evMax - evs[stat]!, evLimit - total);
      evs[stat] = evs[stat]! + room;
      total += room;
    }
    repairs.push(`EVs scaled to the ${evLimit}-point limit`);
  }

  return {
    set: {
      ...set,
      item: itemName,
      ability,
      nature: nature.name,
      moves,
      evs,
    },
    repairs,
  };
}

function packSet(dex: DexLike, mon: DraftBoardMon, set: RawSet): string {
  const base = dex.species.get(mon.species);
  const evs = STATS.map((stat) => (set.evs[stat] ? String(set.evs[stat]) : '')).join(',');
  return [
    base.name,
    '',
    set.item.replaceAll(' ', ''),
    set.ability.replaceAll(' ', ''),
    set.moves.map((move) => move.replaceAll(' ', '')).join(','),
    set.nature,
    evs,
    '',
    '',
    '',
    '50',
    '',
  ].join('|');
}

export async function runTeambuild(request: TeambuildRequest, options: TeambuildOptions): Promise<TeambuildResult> {
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(request.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const ruleTable = Dex.formats.getRuleTable(format);
  const evLimit = ruleTable.evLimit ?? 508;
  const evMax = 32;
  const reference = new ShowdownReference(request.format, psDir);
  fs.mkdirSync(options.logDir, { recursive: true });
  const logFile = path.join(
    options.logDir,
    `series-${request.seriesIndex + 1}-e${request.entrant}-${slug(request.model)}.jsonl`,
  );

  const system = systemPrompt(request, dex, evLimit, evMax);
  const messages: ProviderMessage[] = [{ role: 'user', content: userPrompt(request, dex) }];
  const reasoning = reasoningForModel(request.model, options);
  const resolvedModel = resolveSpecOverride(request.model);
  const provider =
    request.model === 'random'
      ? undefined
      : (options.makeTeambuildProvider?.(request.model, options.apiKeys?.[request.model], reasoning) ??
        makeProvider(parseSpec(resolvedModel), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(resolvedModel === request.model && options.apiKeys?.[request.model] !== undefined
            ? { apiKey: options.apiKeys[request.model] }
            : {}),
        }));

  const owned = new Map(request.roster.map((mon) => [mon.id, mon]));
  let accepted: { sets: RawSet[]; plan: string } | undefined;
  let lastParsed: { sets: RawSet[]; plan: string } | undefined;
  let attemptsUsed = 0;
  let lastError = '';

  for (let attempt = 1; provider && attempt <= TEAMBUILD_PROMPT_POLICY.attempts && !accepted; attempt += 1) {
    options.signal?.throwIfAborted();
    attemptsUsed = attempt;
    const promptForAttempt = messages[messages.length - 1]!.content ?? '';
    let response = '';
    let usage: Record<string, number> | undefined;
    let error: string | undefined;
    let terminalError: Error | undefined;
    let pauseFailure: ProviderFailure | undefined;
    const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
    try {
      const completion = await completeWithDexTools({
        provider,
        system,
        messages,
        spec: request.model,
        reference,
        policy: TEAMBUILD_PROMPT_POLICY,
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onLookup: (call) => lookups.push(call),
      });
      response = completion.text;
      usage = completion.usage;
      const truncated = completion.finishReason === 'length';
      if (!response.trim() && !truncated && completion.reasoning) {
        const salvaged = parseSets(completion.reasoning, request.roster);
        if (typeof salvaged !== 'string') response = completion.reasoning;
      }
      const parsed = parseSets(response, request.roster);
      if (typeof parsed === 'string') {
        error = truncated ? 'the reply used its whole token budget before finishing the team' : parsed;
        lastError = error;
      } else {
        const problems = validateCandidate(dex, request.format, parsed.sets, owned, psDir);
        if (problems.length) {
          error = problems.join('\n');
          lastError = error;
          lastParsed = parsed;
        } else {
          accepted = parsed;
        }
      }
      if (error) {
        messages.push({
          role: 'assistant',
          content: truncated
            ? '[reply cut off before the team was finished]'
            : response || '[the reply contained no visible text]',
        });
        messages.push({
          role: 'user',
          content: truncated
            ? TEAMBUILD_PROMPT_POLICY.truncatedTemplate.replace('{{budget}}', String(TEAMBUILD_PROMPT_POLICY.maxTokens))
            : TEAMBUILD_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', error),
        });
      }
    } catch (cause) {
      const failure = classifyProviderFailure(cause, request.model);
      error = failure.summary;
      lastError = error;
      if (failure.pausable && options.recovery) pauseFailure = failure;
      else terminalError = new Error(`${failure.summary} The teambuild cannot continue.`, { cause });
    }
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({
        series: request.seriesIndex + 1,
        entrant: request.entrant,
        opponent: request.opponentModel,
        attempt,
        ...(attempt === 1 ? { system } : {}),
        user: promptForAttempt,
        response,
        ...(usage ? { usage } : {}),
        ...(lookups.length ? { tool_lookups: lookups } : {}),
        ...(error ? { error } : {}),
      })}\n`,
      'utf8',
    );
    if (terminalError) throw terminalError;
    if (pauseFailure) {
      await options.recovery?.pause(request.model, pauseFailure.kind, pauseFailure.summary, options.signal);
      attempt -= 1;
    }
  }

  const chosen = accepted ??
    lastParsed ?? {
      sets: fallbackSets(request.roster, options.rng, evLimit, evMax),
      plan: provider
        ? `no parseable team after ${TEAMBUILD_PROMPT_POLICY.attempts} attempts (${lastError})`
        : 'random baseline: six of the roster with repaired legal sets',
    };
  const taken = new Set<string>();
  const views: TeambuildSetView[] = [];
  const packedSets: string[] = [];
  let repaired: Array<{ mon: DraftBoardMon; set: RawSet; repairs: string[] }> = chosen.sets.map((raw) => {
    const mon = owned.get(raw.id)!;
    return accepted
      ? { mon, set: raw, repairs: [] }
      : { mon, ...repairSet(dex, mon, raw, evLimit, evMax, taken, options.rng) };
  });

  const problems = validateCandidate(
    dex,
    request.format,
    repaired.map((entry) => entry.set),
    owned,
    psDir,
  );
  if (problems.length) {
    const fallbackTaken = new Set<string>();
    repaired = fallbackSets(request.roster, options.rng, evLimit, evMax).map((raw) => {
      const mon = owned.get(raw.id)!;
      const rebuilt = repairSet(dex, mon, raw, evLimit, evMax, fallbackTaken, options.rng);
      return { mon, set: rebuilt.set, repairs: [`rebuilt from scratch: ${problems.join('; ')}`, ...rebuilt.repairs] };
    });
    const fallbackProblems = validateCandidate(
      dex,
      request.format,
      repaired.map((entry) => entry.set),
      owned,
      psDir,
    );
    if (fallbackProblems.length) {
      throw new Error(`could not create a legal fallback team: ${fallbackProblems.join('; ')}`);
    }
  }

  for (const { mon, set, repairs } of repaired) {
    packedSets.push(packSet(dex, mon, set));
    views.push({
      species: mon.name,
      spriteId: dex.species.get(mon.forme ?? mon.species).spriteid,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs: set.evs,
      repaired: repairs.length > 0,
      repairs,
    });
  }

  const packed = normalizePackedTeam(packedSets.join(']'), psDir);
  const view: TeambuildView = {
    seriesIndex: request.seriesIndex,
    entrant: request.entrant,
    opponent: request.opponent,
    brought: repaired.map((entry) => entry.mon.id),
    sets: views,
    rationale: clip(chosen.plan, 2_000),
    attempts: attemptsUsed,
  };
  fs.appendFileSync(
    path.join(options.logDir, 'teambuild.jsonl'),
    `${JSON.stringify({ model: request.model, team_name: request.teamName, ...view, packed, timestamp: new Date().toISOString() })}\n`,
    'utf8',
  );
  return { packed, view };
}

function validateCandidate(
  dex: DexLike,
  format: string,
  sets: RawSet[],
  owned: Map<string, DraftBoardMon>,
  psDir: string,
): string[] {
  const problems: string[] = [];
  for (const set of sets) {
    const mon = owned.get(set.id)!;
    const label = `${mon.name}:`;
    const item = dex.items.get(set.item);
    if (mon.item) {
      if (!item?.exists || item.name !== dex.items.get(mon.item).name) {
        problems.push(`${label} drafted as a Mega, so it must hold ${dex.items.get(mon.item).name}`);
      }
    } else if (item?.exists && item.megaStone) {
      problems.push(`${label} drafted as the base forme, so it can never hold ${item.name}`);
    }
  }

  const { Teams } = loadShowdown(psDir);
  const packed = sets.map((set) => packSet(dex, owned.get(set.id)!, set)).join(']');
  const unpacked = Teams.unpack(packed);
  if (!unpacked) return [...problems, 'the sets could not be assembled into a team'];
  try {
    validateTeam(packed, format, psDir);
  } catch (cause) {
    problems.push(...(cause instanceof Error ? cause.message : String(cause)).split('\n'));
  }
  return problems;
}

function minimalSet(mon: DraftBoardMon, evLimit: number, evMax: number): RawSet {
  const evs = Object.fromEntries(STATS.map((stat) => [stat, 0])) as Record<Stat, number>;
  let spent = 0;
  for (const stat of STATS) {
    const share = Math.min(evMax, Math.floor(evLimit / STATS.length), evLimit - spent);
    evs[stat] = share;
    spent += share;
  }
  return { id: mon.id, item: mon.item ?? '', ability: '', nature: 'Hardy', moves: [], evs, note: '' };
}

function fallbackSets(roster: DraftBoardMon[], rng: Rng, evLimit: number, evMax: number): RawSet[] {
  const chosen: DraftBoardMon[] = [];
  const bases = new Set<string>();
  for (const mon of shuffle(roster, rng)) {
    if (chosen.length >= 6 || bases.has(mon.base)) continue;
    bases.add(mon.base);
    chosen.push(mon);
  }
  return chosen.map((mon) => minimalSet(mon, evLimit, evMax));
}
