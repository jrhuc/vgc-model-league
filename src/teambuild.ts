import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';
import { completeWithDexTools } from './dex-lookups.js';
import {
  type FranchiseMemory,
  MEMORY_TOOL_NOTICE,
  memoryDigest,
  memoryPageTool,
  renderMemory,
} from './franchise-memory.js';
import type { TeambuildSetView, TeambuildView } from './gui/api.js';
import { defaultPsDir } from './paths.js';
import { type MechanicsToolAvailability, mechanicsToolNotice } from './prompt-capabilities.js';
import { FORMAT_AUTHORITY_NOTICE } from './prompts.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { classifyProviderFailure, makeProvider, parseSpec, reasoningForModel } from './providers.js';
import { type Rng, seededRng, shuffle } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import { spriteIdFor } from './run-artifacts.js';
import type { ShowdownApi } from './showdown.js';
import { loadShowdown, showdownCommit } from './showdown.js';
import { normalizeStageEvidence, noStageEvidence, type StageEvidence } from './stage-evidence.js';
import { normalizePackedTeam, validateTeam } from './teams.js';
import type { JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';

const MATCHUP_AVAILABLE_MECHANICS_TOOLS = [
  'You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,',
  'what a spread outruns, and how hard an attack lands. They compute from the',
  'simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;',
  'a hypothetical damage result does not imply omitted abilities or field effects.',
].join('\n');

const GENERAL_AVAILABLE_MECHANICS_TOOLS = [
  'You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,',
  'and damage against representative threats. The tools compute from the simulator this task validates against.',
].join('\n');

const TEAMBUILD_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league, format {{format}}.',
    FORMAT_AUTHORITY_NOTICE,
    '',
    'You drafted a roster of {{picks}} Pokémon and keep it all season. Before every match you choose exactly 6 of them',
    'and build each set from scratch. Your memory is supplied as context, not a constraint; read_memory_page returns one of its pages in full.',
    '',
    'FORMAT RULES',
    '{{teamSheetRule}}',
    '- Every Pokémon is set to level 50.',
    '- EVs: {{evLimit}} points total across the team member, at most {{evMax}} in any one stat. IVs are fixed at maximum.',
    '  This is the Champions EV system, not the older 508/252 one. Points are whole numbers.',
    '- Each move has at most 20 PP.',
    '- Item Clause: no two of your six may hold the same item. Species Clause: no two may share a species.',
    '- This game has its own item list, which is shorter than the one you may expect. Many Gen 9 staples do not',
    '  exist here. Use only these items:',
    '{{items}}',
    '- Mega Evolution: a roster entry drafted as a Mega holds its Mega Stone and plays as its base forme until it',
    '  Mega Evolves; one drafted as the base forme may never hold a Mega Stone. If you register more than one Mega',
    '  entry, which of them evolves is chosen during play.',
    '',
    'You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,',
    'what a spread outruns, and how hard an attack lands. They compute from the',
    'simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;',
    'a hypothetical damage result does not imply omitted abilities or field effects.',
    '',
    'Choose the 6 for this specific opponent and build their sets. Reply with JSON only, in this shape:',
    '{"team_plan": "<2-5 sentences on the matchup and how these six answer it>",',
    ' "sets": [{"id": "<board-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly 6 entries in "sets", each one a board id from YOUR ROSTER below.',
  ],
  rosterHeading: 'YOUR ROSTER (board id | name | types | base stats | abilities | legal moves):',
  opponentHeading: 'OPPONENT ROSTER — {{model}} (they pick 6 of these):',
  priorContextHeading: 'YOUR SEASON SO FAR (your results, what you registered, and your notes against this coach):',
  priorContextNotice:
    'Every coach builds a new six for every matchup; sets, items, moves and spreads seen earlier were built for that series and may not return.',
  lockedItem: 'MUST hold {{item}}',
  noMega: 'cannot hold a Mega Stone',
  rejectionTemplate: 'That team was rejected:\n{{error}}\nReply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before finishing the team. Reply now with only the JSON object, keeping your reasoning short enough to finish inside the budget.',
  maxTokens: 65_536,
  timeoutSeconds: 3600,
  attempts: 5,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 16,
  maxCallsPerRound: 8,
} as const;

const GENERAL_TEAMBUILD_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, building a Pokémon VGC team for format {{format}}.',
    FORMAT_AUTHORITY_NOTICE,
    '',
    'Choose exactly {{teamSize}} entries from the explicit frozen candidate pool supplied below and build every set from scratch.',
    'No particular opponent is specified. Build for robust play across the format; do not assume an opponent roster.',
    'Your memory, when supplied, is context, not a constraint.',
    '',
    'FORMAT RULES',
    '{{teamSheetRule}}',
    '- Every Pokémon is set to level 50.',
    '- EVs: {{evLimit}} points total across the team member, at most {{evMax}} in any one stat. IVs are fixed at maximum.',
    '  This is the Champions EV system, not the older 508/252 one. Points are whole numbers.',
    '- Each move has at most 20 PP.',
    '- Item Clause: no two team members may hold the same item. Species Clause: no two may share a species.',
    '- Use only these items:',
    '{{items}}',
    '- A candidate with a locked item must hold it. A candidate without one cannot hold a Mega Stone.',
    '',
    'You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,',
    'and damage against representative threats. The tools compute from the simulator this task validates against.',
    '',
    'Reply with JSON only, in this shape:',
    '{"team_plan": "<2-5 sentences on the team and its modes>",',
    ' "sets": [{"id": "<candidate-id>", "item": "<item>", "ability": "<ability>", "nature": "<nature>",',
    '           "moves": ["<up to 4 moves>"], "evs": {"hp": 0, "atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0},',
    '           "note": "<one line on this set\'s job>"}]}',
    'Exactly {{teamSize}} entries in "sets", each one a candidate id from the frozen pool below.',
  ],
  candidateHeading: 'FROZEN CANDIDATE POOL (id | name | types | base stats | abilities | legal moves):',
  briefHeading: 'TASK BRIEF:',
} as const;

const TEAMBUILD_RATIONALE_LIMIT = 2_000;
const TEAMBUILD_NOTEBOOK_LIMIT = 4_000;

const TEAMBUILD_RENDERER_PROTOCOL = {
  version: 2,
  responseShape: 'strict-json-v1',
  candidateIdentity: 'frozen-id',
  setPacking: 'showdown-teams-pack',
  setNotes: true,
  promptRenderer: 'ordered-template-replace-all-v1',
  candidateRenderer: 'dex-roster-block-v1',
  sheetRules: {
    open:
      '- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are open, so your opponent reads your\n' +
      '  moves, items, abilities, and natures — but not your exact EV spreads.',
    closed:
      '- Doubles. Both coaches register 6 and bring 4 to each game; team sheets are closed, so neither coach receives ' +
      'the opposing moves, items, abilities, natures, or EV spreads before play.',
  },
  sheetPolicy: 'task-bound',
  evidencePolicy: 'stage-evidence-v1',
} as const;

export type TeamBuildSheetPolicy = 'open' | 'closed';
export type TeamBuildExecutionPolicy = 'league-resilient' | 'strict';

export function teambuildScaffoldRevision(
  sheetPolicy: TeamBuildSheetPolicy = 'open',
  executionPolicy: TeamBuildExecutionPolicy = 'league-resilient',
): string {
  return createHash('sha256')
    .update(JSON.stringify([TEAMBUILD_PROMPT_POLICY, TEAMBUILD_RENDERER_PROTOCOL, sheetPolicy, executionPolicy]))
    .digest('hex')
    .slice(0, 12);
}

export function teamBuildScaffoldRevision(
  objective: TeamBuildObjective,
  sheetPolicy: TeamBuildSheetPolicy,
  executionPolicy: TeamBuildExecutionPolicy,
): string {
  if (objective.kind === 'matchup') return teambuildScaffoldRevision(sheetPolicy, executionPolicy);
  return createHash('sha256')
    .update(
      JSON.stringify([
        TEAMBUILD_PROMPT_POLICY,
        GENERAL_TEAMBUILD_PROMPT_POLICY,
        TEAMBUILD_RENDERER_PROTOCOL,
        sheetPolicy,
        executionPolicy,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
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

export interface TeamBuildCandidate {
  id: string;
  name: string;
  species: string;
  forme?: string;
  item?: string;
  base: string;
  types: string[];
}

interface TeamBuildConstraintBase {
  id: string;
  teamSize: number;
  candidates: readonly TeamBuildCandidate[];
}

export type TeamBuildConstraint =
  | ({ kind: 'draft-picks' } & TeamBuildConstraintBase)
  | ({ kind: 'frozen-candidate-pool' } & TeamBuildConstraintBase);

export type TeamBuildObjective =
  | {
      kind: 'matchup';
      stage: 'roundrobin' | 'playoff';
      opponent: { model: string; candidates: readonly TeamBuildCandidate[] };
      priorContext: readonly string[];
    }
  | { kind: 'general'; brief?: string };

export interface TeamBuildTaskProvenance {
  source: string;
  seed?: string | number;
  parentRunId?: string;
  seriesIndex?: number;
  entrant?: number;
  opponent?: number;
  memoryDigest?: string;
}

export interface TeamBuildTask {
  id: string;
  model: string;
  format: string;
  sheetPolicy: TeamBuildSheetPolicy;
  executionPolicy?: TeamBuildExecutionPolicy;
  constraint: TeamBuildConstraint;
  objective: TeamBuildObjective;
  notebook: string;
  provenance: TeamBuildTaskProvenance;
}

export interface TeamBuildAction {
  selected: string[];
  packed: string;
  sets: TeambuildSetView[];
}

export interface TeamBuildArtifact {
  schemaVersion: 1;
  status: 'valid' | 'invalid';
  task: TeamBuildTask;
  executionPolicy: TeamBuildExecutionPolicy;
  scaffold: string;
  showdownCommit: string;
  action: TeamBuildAction | null;
  evidence: StageEvidence;
  validation: {
    showdown: boolean;
    repaired: boolean;
    repairs: string[];
    problems: string[];
  };
  attempts: number;
  fallback: boolean;
  createdAt: string;
}

export interface TeamBuildResult {
  packed: string | null;
  artifact: TeamBuildArtifact;
}

/** Optional deterministic metadata for the provider-free team-build referee. */
export interface TeamBuildRefereeOptions {
  psDir?: string;
  attempts?: number;
  createdAt?: string;
}

export type TeamBuildSubmissionValidation =
  | { status: 'accepted'; packed: string; artifact: TeamBuildArtifact }
  | { status: 'rejected'; problems: string[]; evidence: StageEvidence; artifact: TeamBuildArtifact };

export interface TeambuildResult {
  packed: string;
  artifact: TeamBuildArtifact;
  view: TeambuildView;
}

export interface TeamBuildOptions extends ModelReasoningConfig {
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  logDir: string;
  rng: Rng;
  /** Optional archival timestamp; defaults to the current time. */
  createdAt?: string;
  signal?: AbortSignal;
  recovery?: RecoveryGate;
  makeTeambuildProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
  memory?: FranchiseMemory;
}

export type TeambuildOptions = TeamBuildOptions;

export interface TeambuildRequest {
  seriesIndex: number;
  entrant: number;
  opponent: number;
  stage: 'roundrobin' | 'playoff';
  model: string;
  opponentModel: string;
  franchiseName: string;
  roster: TeamBuildCandidate[];
  opponentRoster: TeamBuildCandidate[];
  memory: FranchiseMemory;
  playoffContext: string[];
  format: string;
  sheetPolicy?: TeamBuildSheetPolicy;
}

const statSpreadSchema = z.strictObject({
  hp: z.number(),
  atk: z.number(),
  def: z.number(),
  spa: z.number(),
  spd: z.number(),
  spe: z.number(),
});
const candidateSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  species: z.string(),
  forme: z.string().optional(),
  item: z.string().optional(),
  base: z.string(),
  types: z.array(z.string()),
});
const constraintBaseSchema = {
  id: z.string(),
  teamSize: z.number(),
  candidates: z.array(candidateSchema),
};
const constraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('draft-picks'), ...constraintBaseSchema }),
  z.strictObject({ kind: z.literal('frozen-candidate-pool'), ...constraintBaseSchema }),
]);
const objectiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('matchup'),
    stage: z.union([z.literal('roundrobin'), z.literal('playoff')]),
    opponent: z.strictObject({ model: z.string(), candidates: z.array(candidateSchema) }),
    priorContext: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal('general'), brief: z.string().optional() }),
]);
const provenanceSchema = z.strictObject({
  source: z.string(),
  seed: z.union([z.string(), z.number()]).optional(),
  parentRunId: z.string().optional(),
  seriesIndex: z.number().optional(),
  entrant: z.number().optional(),
  opponent: z.number().optional(),
  memoryDigest: z.string().optional(),
});
const taskSchema = z.strictObject({
  id: z.string(),
  model: z.string(),
  format: z.string(),
  sheetPolicy: z.union([z.literal('open'), z.literal('closed')]),
  executionPolicy: z.union([z.literal('league-resilient'), z.literal('strict')]),
  constraint: constraintSchema,
  objective: objectiveSchema,
  notebook: z.string(),
  provenance: provenanceSchema,
});
const actionSetSchema = z.strictObject({
  species: z.string(),
  spriteId: z.string(),
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: statSpreadSchema,
  note: z.string(),
  repaired: z.boolean(),
  repairs: z.array(z.string()),
});
const actionSchema = z.strictObject({
  selected: z.array(z.string()),
  packed: z.string(),
  sets: z.array(actionSetSchema),
});
const evidenceSchema = z.strictObject({
  rationale: z.string(),
  notebook: z.string(),
  supplied: z.strictObject({ rationale: z.boolean(), notebookUpdate: z.boolean() }),
});
const teamBuildArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('valid'),
  task: taskSchema,
  executionPolicy: z.union([z.literal('league-resilient'), z.literal('strict')]),
  scaffold: z.string(),
  showdownCommit: z.string(),
  action: actionSchema,
  evidence: evidenceSchema,
  validation: z.strictObject({
    showdown: z.literal(true),
    repaired: z.boolean(),
    repairs: z.array(z.string()),
    problems: z.array(z.string()),
  }),
  attempts: z.number(),
  fallback: z.boolean(),
  createdAt: z.string(),
});

const teamBuildJournalRowSchema = z.strictObject({ artifact: teamBuildArtifactSchema });

const historicalActionSetSchema = z.strictObject({
  species: z.string(),
  spriteId: z.string().optional(),
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: statSpreadSchema,
  note: z.string().optional(),
  repaired: z.boolean(),
  repairs: z.array(z.string()),
});
const historicalTeamBuildJournalRowSchema = z.strictObject({
  model: z.string(),
  team_name: z.string(),
  seriesIndex: z.number().int().nonnegative(),
  entrant: z.number().int().nonnegative(),
  opponent: z.number().int().nonnegative(),
  brought: z.array(z.string()),
  sets: z.array(historicalActionSetSchema),
  rationale: z.string(),
  attempts: z.number().int().positive(),
  packed: z.string().optional(),
  timestamp: z.string(),
});

export interface TeamBuildJournalEntry {
  artifact: TeamBuildArtifact;
  view: TeambuildView;
  notebook: string;
}

export function decodeTeamBuildJournalRow(value: unknown, label = 'team-build journal row'): TeamBuildJournalEntry {
  const parsed = teamBuildJournalRowSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${label} is not a current team-build journal row: ${z.prettifyError(parsed.error)}`);
  const artifact = parsed.data.artifact as TeamBuildArtifact;
  const provenance = artifact.task.provenance;
  if (
    provenance.source !== 'draft-league' ||
    !Number.isSafeInteger(provenance.seriesIndex) ||
    Number(provenance.seriesIndex) < 0 ||
    !Number.isSafeInteger(provenance.entrant) ||
    Number(provenance.entrant) < 0 ||
    !Number.isSafeInteger(provenance.opponent) ||
    Number(provenance.opponent) < 0 ||
    artifact.task.objective.kind !== 'matchup' ||
    !artifact.action
  ) {
    throw new Error(`${label} does not carry complete draft-league provenance and a valid action`);
  }
  return {
    artifact,
    notebook: artifact.evidence.notebook,
    view: {
      seriesIndex: provenance.seriesIndex!,
      entrant: provenance.entrant!,
      opponent: provenance.opponent!,
      brought: [...artifact.action.selected],
      sets: structuredClone(artifact.action.sets),
      rationale: artifact.evidence.rationale,
      attempts: artifact.attempts,
    },
  };
}

export interface ArchivedTeamBuildJournalEntry {
  view: TeambuildView;
  notebook: string;
}

/** Read-only compatibility for archives written before journal rows wrapped the canonical artifact. */
export function decodeArchivedTeamBuildJournalRow(
  value: unknown,
  label = 'archived team-build journal row',
): ArchivedTeamBuildJournalEntry {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'artifact')) {
    const { view, notebook } = decodeTeamBuildJournalRow(value, label);
    return { view, notebook };
  }
  const parsed = historicalTeamBuildJournalRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${label} is neither a current artifact row nor a historical flat archive row: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    notebook: '',
    view: {
      seriesIndex: parsed.data.seriesIndex,
      entrant: parsed.data.entrant,
      opponent: parsed.data.opponent,
      brought: [...parsed.data.brought],
      sets: parsed.data.sets.map(({ spriteId, note, ...set }) => ({
        ...set,
        spriteId: spriteId ?? spriteIdFor(set.species),
        ...(note === undefined ? {} : { note }),
      })),
      rationale: parsed.data.rationale,
      attempts: parsed.data.attempts,
    },
  };
}

function canonicalCandidate(candidate: TeamBuildCandidate): TeamBuildCandidate {
  return {
    id: candidate.id,
    name: candidate.name,
    species: candidate.species,
    ...(candidate.forme === undefined ? {} : { forme: candidate.forme }),
    ...(candidate.item === undefined ? {} : { item: candidate.item }),
    base: candidate.base,
    types: [...candidate.types],
  };
}

function canonicalTask(task: TeamBuildTask, executionPolicy: TeamBuildExecutionPolicy): TeamBuildTask {
  const constraint = {
    ...task.constraint,
    candidates: task.constraint.candidates.map(canonicalCandidate),
  } as TeamBuildConstraint;
  const objective: TeamBuildObjective =
    task.objective.kind === 'general'
      ? { kind: 'general', ...(task.objective.brief === undefined ? {} : { brief: task.objective.brief }) }
      : {
          kind: 'matchup',
          stage: task.objective.stage,
          opponent: {
            model: task.objective.opponent.model,
            candidates: task.objective.opponent.candidates.map(canonicalCandidate),
          },
          priorContext: [...task.objective.priorContext],
        };
  return {
    id: task.id,
    model: task.model,
    format: task.format,
    sheetPolicy: task.sheetPolicy,
    executionPolicy,
    constraint,
    objective,
    notebook: task.notebook,
    provenance: { ...task.provenance },
  };
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

function legalMoves(dex: DexLike, mon: TeamBuildCandidate): string[] {
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

function rosterBlock(dex: DexLike, roster: TeamBuildCandidate[], detailed: boolean): string[] {
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

function renderPromptTemplate(lines: readonly string[], values: Readonly<Record<string, string>>): string {
  return lines
    .map((line) =>
      Object.entries(values).reduce((rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value), line),
    )
    .join('\n');
}

function teamSheetRule(policy: TeamBuildSheetPolicy): string {
  return TEAMBUILD_RENDERER_PROTOCOL.sheetRules[policy];
}

function systemPrompt(
  task: TeamBuildTask,
  dex: DexLike,
  evLimit: number,
  evMax: number,
  mechanicsTools: MechanicsToolAvailability = 'available',
): string {
  const values: Record<string, string> = {
    model: task.model,
    format: task.format,
    picks: String(task.constraint.candidates.length),
    teamSize: String(task.constraint.teamSize),
    evLimit: String(evLimit),
    evMax: String(evMax),
    items: `  ${legalItems(dex).join(', ')}`,
    teamSheetRule: teamSheetRule(task.sheetPolicy),
  };
  const rendered = renderPromptTemplate(
    task.objective.kind === 'matchup'
      ? TEAMBUILD_PROMPT_POLICY.systemTemplate
      : GENERAL_TEAMBUILD_PROMPT_POLICY.systemTemplate,
    values,
  );
  const availableNotice =
    task.objective.kind === 'matchup' ? MATCHUP_AVAILABLE_MECHANICS_TOOLS : GENERAL_AVAILABLE_MECHANICS_TOOLS;
  return rendered.replace(availableNotice, mechanicsToolNotice(mechanicsTools, availableNotice));
}

function userPrompt(task: TeamBuildTask, dex: DexLike): string {
  if (task.objective.kind === 'general') {
    const lines: string[] = [GENERAL_TEAMBUILD_PROMPT_POLICY.candidateHeading];
    lines.push(...rosterBlock(dex, [...task.constraint.candidates], true));
    if (task.notebook) lines.push('', task.notebook);
    if (task.objective.brief) lines.push('', GENERAL_TEAMBUILD_PROMPT_POLICY.briefHeading, task.objective.brief);
    return lines.join('\n');
  }
  const lines: string[] = [TEAMBUILD_PROMPT_POLICY.rosterHeading];
  lines.push(...rosterBlock(dex, [...task.constraint.candidates], true));
  if (task.notebook) lines.push('', task.notebook);
  lines.push('', TEAMBUILD_PROMPT_POLICY.opponentHeading.replace('{{model}}', task.objective.opponent.model));
  lines.push(...rosterBlock(dex, [...task.objective.opponent.candidates], false));
  if (task.objective.priorContext.length) {
    lines.push(
      '',
      TEAMBUILD_PROMPT_POLICY.priorContextHeading,
      ...task.objective.priorContext.map((entry) => `- ${entry}`),
      TEAMBUILD_PROMPT_POLICY.priorContextNotice,
    );
  }
  return lines.join('\n');
}

export function connectedTeamBuildPromptRevision(
  objective: TeamBuildObjective,
  sheetPolicy: TeamBuildSheetPolicy,
  mechanicsTools: MechanicsToolAvailability = 'available',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        teamBuildScaffoldRevision(objective, sheetPolicy, 'strict'),
        'system-blank-line-user-v1',
        mechanicsTools,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
}

export function renderStrictTeamBuildPrompt(
  task: TeamBuildTask,
  options: Pick<TeamBuildRefereeOptions, 'psDir'> & {
    mechanicsTools?: MechanicsToolAvailability;
  } = {},
): string {
  const canonical = strictTask(task);
  validateTeamBuildTask(canonical);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonical.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const rules = Dex.formats.getRuleTable(format);
  return [
    systemPrompt(canonical, dex, rules.evLimit ?? 508, 32, options.mechanicsTools ?? 'available'),
    '',
    userPrompt(canonical, dex),
  ].join('\n');
}

interface ParsedTeamBuild {
  sets: RawSet[];
  evidence: StageEvidence;
}

function parseSets(response: string, task: TeamBuildTask): ParsedTeamBuild | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the reply must be one JSON object';
  }
  const record = parsed as Record<string, unknown>;
  if (record.team_plan !== undefined && typeof record.team_plan !== 'string') {
    return '"team_plan" must be a string when supplied';
  }
  if (record.notebook !== undefined && typeof record.notebook !== 'string') {
    return '"notebook" must be a string when supplied';
  }
  if (!Array.isArray(record.sets)) return '"sets" must be an array';
  const raw = record.sets;
  const teamSize = task.constraint.teamSize;
  if (raw.length !== teamSize) return `"sets" must hold exactly ${teamSize} entries, not ${raw.length}`;
  const owned = new Map(task.constraint.candidates.map((mon) => [mon.id, mon]));
  const sets: RawSet[] = [];
  const used = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `set ${index + 1} must be an object`;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string') return `set ${index + 1} "id" must be a string`;
    if (typeof item.item !== 'string') return `set ${index + 1} "item" must be a string`;
    if (typeof item.ability !== 'string') return `set ${index + 1} "ability" must be a string`;
    if (typeof item.nature !== 'string') return `set ${index + 1} "nature" must be a string`;
    if (!Array.isArray(item.moves)) return `set ${index + 1} "moves" must be an array`;
    if (item.moves.some((move) => typeof move !== 'string' || !move.trim())) {
      return `set ${index + 1} "moves" must contain only non-empty strings`;
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      return `set ${index + 1} "note" must be a string when supplied`;
    }
    for (const [field, value] of [
      ['id', item.id],
      ['item', item.item],
      ['ability', item.ability],
      ['nature', item.nature],
      ...item.moves.map((move, moveIndex) => [`moves[${moveIndex}]`, move]),
    ] as Array<[string, string]>) {
      if (value !== value.trim()) return `set ${index + 1} "${field}" must not have surrounding whitespace`;
    }
    if (typeof item.evs !== 'object' || item.evs === null || Array.isArray(item.evs)) {
      return `set ${index + 1} "evs" must be an object`;
    }
    const id = item.id;
    if (!owned.has(id)) {
      return task.constraint.kind === 'draft-picks'
        ? `"${id}" is not a board id on your roster`
        : `"${id}" is not an id in the frozen candidate pool`;
    }
    if (used.has(id)) {
      return teamSize === 6
        ? `"${id}" appears twice; bring six different Pokémon`
        : `"${id}" appears twice; choose ${teamSize} different Pokémon`;
    }
    used.add(id);
    const rawEvs = item.evs as Record<string, unknown>;
    const evs: Record<string, number> = {};
    for (const stat of STATS) {
      const value = rawEvs[stat];
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
        return `set ${index + 1} "evs.${stat}" must be a finite, safe, non-negative integer`;
      }
      evs[stat] = value;
    }
    sets.push({
      id,
      item: item.item,
      ability: item.ability,
      nature: item.nature,
      moves: item.moves as string[],
      evs,
      note: typeof item.note === 'string' ? item.note : '',
    });
  }
  const evidence = normalizeStageEvidence(record.team_plan, record.notebook, {
    currentNotebook: task.notebook,
    rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
    notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
  });
  return { sets, evidence };
}

function repairSet(
  dex: DexLike,
  mon: TeamBuildCandidate,
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
  if (itemName && itemName !== set.item && repairs.length === 0) {
    repairs.push(`item normalized from ${JSON.stringify(set.item)} to ${itemName}`);
  }
  if (itemName) taken.add(itemName);

  const abilities = Object.values(base.abilities ?? {}).filter(Boolean) as string[];
  let ability = abilities.find((name) => dex.abilities.get(name).name === dex.abilities.get(set.ability).name);
  if (!ability) {
    ability = abilities[0]!;
    repairs.push(`ability set to ${ability}, which ${base.name} can legally have`);
  } else if (ability !== set.ability) {
    repairs.push(`ability normalized from ${JSON.stringify(set.ability)} to ${ability}`);
  }

  let nature = dex.natures.get(set.nature);
  if (!nature?.exists) {
    nature = dex.natures.get('Serious');
    repairs.push(`unknown nature ${JSON.stringify(set.nature)} replaced with Serious`);
  } else if (nature.name !== set.nature) {
    repairs.push(`nature normalized from ${JSON.stringify(set.nature)} to ${nature.name}`);
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
    if (moves.includes(resolved)) {
      repairs.push(`duplicate move ${resolved} dropped`);
      continue;
    }
    if (resolved !== move) repairs.push(`move normalized from ${JSON.stringify(move)} to ${resolved}`);
    moves.push(resolved);
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

type ShowdownSet = NonNullable<ReturnType<ShowdownApi['Teams']['unpack']>>[number];

function packCandidateTeam(
  dex: DexLike,
  entries: readonly { mon: TeamBuildCandidate; set: RawSet }[],
  psDir: string,
): string {
  const { Teams } = loadShowdown(psDir);
  const sets: ShowdownSet[] = entries.map(({ mon, set }) => {
    const base = dex.species.get(mon.species);
    return {
      name: base.name,
      species: base.name,
      item: set.item,
      ability: set.ability,
      moves: set.moves,
      nature: set.nature,
      gender: '',
      evs: Object.fromEntries(STATS.map((stat) => [stat, set.evs[stat] ?? 0])) as ShowdownSet['evs'],
      ivs: Object.fromEntries(STATS.map((stat) => [stat, 31])) as ShowdownSet['ivs'],
      level: 50,
    };
  });
  const packed = Teams.pack(sets);
  if (!packed) throw new Error('Showdown produced an empty packed team');
  return packed;
}

function validateTeamBuildTask(task: TeamBuildTask): void {
  const { candidates, teamSize } = task.constraint;
  if (task.sheetPolicy !== 'open' && task.sheetPolicy !== 'closed') {
    throw new Error('team-build sheetPolicy must be open or closed');
  }
  if (
    task.executionPolicy !== undefined &&
    task.executionPolicy !== 'league-resilient' &&
    task.executionPolicy !== 'strict'
  ) {
    throw new Error('team-build executionPolicy must be league-resilient or strict');
  }
  if (!Number.isSafeInteger(teamSize) || teamSize < 1) {
    throw new Error('team-build constraint teamSize must be a positive integer');
  }
  const ids = candidates.map((candidate) => candidate.id);
  if (ids.some((id) => !id)) throw new Error('every team-build candidate needs a non-empty id');
  if (new Set(ids).size !== ids.length) throw new Error('team-build candidate ids must be unique');
  const distinct = new Set(candidates.map((candidate) => candidate.base)).size;
  if (distinct < teamSize) {
    throw new Error(
      `team-build constraint ${JSON.stringify(task.constraint.id)} has ${distinct} distinct species, fewer than teamSize ${teamSize}`,
    );
  }
}

function strictTask(task: TeamBuildTask): TeamBuildTask {
  validateTeamBuildTask(task);
  if (task.executionPolicy !== undefined && task.executionPolicy !== 'strict') {
    throw new Error('the team-build referee accepts only strict executionPolicy tasks');
  }
  return canonicalTask(task, 'strict');
}

function refereeArtifact(
  task: TeamBuildTask,
  psDir: string,
  action: TeamBuildAction | null,
  evidence: StageEvidence,
  problems: string[],
  options: TeamBuildRefereeOptions,
): TeamBuildArtifact {
  return {
    schemaVersion: 1,
    status: action ? 'valid' : 'invalid',
    task,
    executionPolicy: 'strict',
    scaffold: teamBuildScaffoldRevision(task.objective, task.sheetPolicy, 'strict'),
    showdownCommit: showdownCommit(psDir),
    action,
    evidence,
    validation: {
      showdown: Boolean(action),
      repaired: false,
      repairs: [],
      problems,
    },
    attempts: options.attempts ?? 0,
    fallback: false,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

function actionForCandidateTeam(
  dex: DexLike,
  task: TeamBuildTask,
  entries: readonly { mon: TeamBuildCandidate; set: RawSet }[],
  psDir: string,
): TeamBuildAction {
  const packed = normalizePackedTeam(packCandidateTeam(dex, entries, psDir), psDir, task.format);
  validateTeam(packed, task.format, psDir);
  return {
    selected: entries.map((entry) => entry.mon.id),
    packed,
    sets: entries.map(({ mon, set }) => ({
      species: mon.name,
      spriteId: dex.species.get(mon.forme ?? mon.species).spriteid,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: { ...set.evs },
      note: set.note,
      repaired: false,
      repairs: [],
    })),
  };
}

/** Replays a serialized valid construction through the current artifact schema and Showdown authority. */
export function replayTeamBuildArtifact(
  value: unknown,
  options: Pick<TeamBuildRefereeOptions, 'psDir'> = {},
): { artifact: TeamBuildArtifact; packed: string } {
  const parsed = teamBuildArtifactSchema.safeParse(value);
  if (!parsed.success) throw new Error(`construction artifact is malformed: ${z.prettifyError(parsed.error)}`);
  const artifact = parsed.data as TeamBuildArtifact;
  const task = artifact.task;
  const action = artifact.action!;
  const psDir = options.psDir ?? defaultPsDir();
  validateTeamBuildTask(task);
  if (
    artifact.executionPolicy !== task.executionPolicy ||
    artifact.scaffold !== teamBuildScaffoldRevision(task.objective, task.sheetPolicy, artifact.executionPolicy) ||
    artifact.showdownCommit !== showdownCommit(psDir)
  ) {
    throw new Error('construction artifact is not bound to its task, policies, scaffold, and Showdown revision');
  }
  if (!Number.isSafeInteger(artifact.attempts) || artifact.attempts < 0 || artifact.validation.problems.length) {
    throw new Error('construction artifact validation state is inconsistent');
  }
  const normalizedRationale = normalizeStageEvidence(artifact.evidence.rationale, undefined, {
    currentNotebook: task.notebook,
    rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
    notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
  }).rationale;
  const normalizedNotebook = normalizeStageEvidence(
    undefined,
    artifact.evidence.supplied.notebookUpdate ? artifact.evidence.notebook : undefined,
    {
      currentNotebook: task.notebook,
      rationaleLimit: TEAMBUILD_RATIONALE_LIMIT,
      notebookLimit: TEAMBUILD_NOTEBOOK_LIMIT,
    },
  ).notebook;
  if (
    artifact.evidence.rationale !== normalizedRationale ||
    (!artifact.evidence.supplied.rationale && !artifact.fallback && artifact.evidence.rationale !== '') ||
    artifact.evidence.notebook !== normalizedNotebook
  ) {
    throw new Error('construction artifact evidence is not normalized against its task notebook');
  }
  if (
    task.constraint.teamSize !== 6 ||
    action.selected.length !== 6 ||
    action.sets.length !== 6 ||
    new Set(action.selected).size !== 6
  ) {
    throw new Error('construction artifact must select exactly six unique roster ids and sets');
  }
  const candidates = new Map(task.constraint.candidates.map((candidate) => [candidate.id, candidate]));
  const { Dex, Teams } = loadShowdown(psDir);
  const format = Dex.formats.get(task.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const entries: Array<{ mon: TeamBuildCandidate; set: RawSet }> = [];
  for (const [index, id] of action.selected.entries()) {
    const mon = candidates.get(id);
    const view = action.sets[index]!;
    if (!mon) throw new Error(`construction selected roster id ${JSON.stringify(id)} that its task does not own`);
    const spriteId = dex.species.get(mon.forme ?? mon.species).spriteid;
    if (view.species !== mon.name || view.spriteId !== spriteId) {
      throw new Error(`construction set ${index + 1} is not bound to selected roster id ${JSON.stringify(id)}`);
    }
    entries.push({
      mon,
      set: {
        id,
        item: view.item,
        ability: view.ability,
        nature: view.nature,
        moves: [...view.moves],
        evs: { ...view.evs },
        note: view.note ?? '',
      },
    });
  }
  const expectedRepairs = action.selected.flatMap((id, index) =>
    action.sets[index]!.repairs.map((repair) => `${id}: ${repair}`),
  );
  if (
    artifact.validation.repaired !== expectedRepairs.length > 0 ||
    !isDeepStrictEqual(artifact.validation.repairs, expectedRepairs) ||
    action.sets.some((set) => set.repaired !== set.repairs.length > 0)
  ) {
    throw new Error('construction artifact repair metadata is inconsistent with its action');
  }
  if (
    artifact.executionPolicy === 'strict' &&
    (artifact.fallback || artifact.validation.repaired || action.sets.some((set) => set.repaired))
  ) {
    throw new Error('strict construction artifact cannot contain a fallback or repaired action');
  }
  const unpacked = Teams.unpack(action.packed);
  if (unpacked?.length !== 6) {
    throw new Error('construction packed team must unpack to exactly six sets');
  }
  if (Teams.pack(unpacked) !== action.packed) {
    throw new Error('construction packed team is not an exact Showdown pack/unpack normalization');
  }
  if (normalizePackedTeam(action.packed, psDir, task.format) !== action.packed) {
    throw new Error('construction packed team is not normalized for its format');
  }
  const reconstructed = packCandidateTeam(dex, entries, psDir);
  if (reconstructed !== action.packed) {
    throw new Error('construction packed species and sets do not exactly match action.selected and action.sets');
  }
  for (const [index, set] of unpacked.entries()) {
    const { mon, set: view } = entries[index]!;
    const species = dex.species.get(mon.species).name;
    const evs = Object.fromEntries(STATS.map((stat) => [stat, set.evs?.[stat] ?? 0]));
    const ivs = Object.fromEntries(STATS.map((stat) => [stat, set.ivs?.[stat] ?? 31]));
    if (
      set.name !== species ||
      set.species !== species ||
      set.item !== view.item ||
      set.ability !== view.ability ||
      set.nature !== view.nature ||
      !isDeepStrictEqual(set.moves, view.moves) ||
      !isDeepStrictEqual(evs, view.evs) ||
      Object.values(ivs).some((iv) => iv !== 31) ||
      (set.gender ?? '') !== '' ||
      set.level !== 50 ||
      set.shiny ||
      set.teraType
    ) {
      throw new Error(`construction packed set ${index + 1} is inconsistent with its exact registered set`);
    }
  }
  validateTeam(action.packed, task.format, psDir);
  return { artifact, packed: action.packed };
}

/**
 * Validates one submitted response at the strict construction boundary.
 * The result contains JSON-safe data only; no Dex object or provider state is
 * exposed. Canonical action bytes are deterministic; callers may supply
 * createdAt when the enclosing artifact also needs deterministic bytes.
 */
export function validateTeamBuildSubmission(
  task: TeamBuildTask,
  response: string,
  options: TeamBuildRefereeOptions = {},
): TeamBuildSubmissionValidation {
  let canonicalTask: TeamBuildTask;
  try {
    canonicalTask = strictTask(task);
  } catch (cause) {
    const problem = cause instanceof Error ? cause.message : String(cause);
    const rejectedTask = structuredClone(task);
    const evidence = noStageEvidence(task.notebook);
    const psDir = options.psDir ?? defaultPsDir();
    return {
      status: 'rejected',
      problems: [problem],
      evidence,
      artifact: refereeArtifact(rejectedTask, psDir, null, evidence, [problem], options),
    };
  }
  const psDir = options.psDir ?? defaultPsDir();
  const parsed = parseSets(response, canonicalTask);
  if (typeof parsed === 'string') {
    const evidence = noStageEvidence(canonicalTask.notebook);
    return {
      status: 'rejected',
      problems: [parsed],
      evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, evidence, [parsed], options),
    };
  }
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonicalTask.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const owned = new Map(canonicalTask.constraint.candidates.map((mon) => [mon.id, mon]));
  const problems = validateCandidate(dex, canonicalTask.format, parsed.sets, owned, psDir);
  if (problems.length) {
    return {
      status: 'rejected',
      problems,
      evidence: parsed.evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, parsed.evidence, problems, options),
    };
  }
  try {
    const entries = parsed.sets.map((set) => ({ mon: owned.get(set.id)!, set }));
    const action = actionForCandidateTeam(dex, canonicalTask, entries, psDir);
    const artifact = refereeArtifact(canonicalTask, psDir, action, parsed.evidence, [], options);
    return { status: 'accepted', packed: action.packed, artifact };
  } catch (cause) {
    const problems = [cause instanceof Error ? cause.message : String(cause)];
    return {
      status: 'rejected',
      problems,
      evidence: parsed.evidence,
      artifact: refereeArtifact(canonicalTask, psDir, null, parsed.evidence, problems, options),
    };
  }
}

export interface DeterministicTeamBuildFallback {
  response: string;
  validation: Extract<TeamBuildSubmissionValidation, { status: 'accepted' }>;
}

export function deterministicTeamBuildFallback(
  task: TeamBuildTask,
  seed: string | number,
  options: TeamBuildRefereeOptions = {},
): DeterministicTeamBuildFallback {
  const canonical = strictTask(task);
  validateTeamBuildTask(canonical);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonical.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const rules = Dex.formats.getRuleTable(format);
  const random = seededRng(seed);
  const selected = fallbackSets(
    canonical.constraint.candidates,
    canonical.constraint.teamSize,
    random,
    rules.evLimit ?? 508,
    32,
  );
  const owned = new Map(canonical.constraint.candidates.map((candidate) => [candidate.id, candidate]));
  const taken = new Set<string>();
  const repaired = selected.map((raw) => {
    const mon = owned.get(raw.id);
    if (!mon) throw new Error(`fallback selected unknown candidate ${JSON.stringify(raw.id)}`);
    const moves = legalMoves(dex, mon)
      .sort((left, right) => {
        const leftStatus = dex.moves.get(left).category === 'Status' ? 1 : 0;
        const rightStatus = dex.moves.get(right).category === 'Status' ? 1 : 0;
        return leftStatus - rightStatus || left.localeCompare(right);
      })
      .slice(0, 4);
    return repairSet(dex, mon, { ...raw, moves }, rules.evLimit ?? 508, 32, taken, random).set;
  });
  const response = JSON.stringify({
    team_plan: 'deterministic legal fallback supplied by the connected referee',
    sets: repaired.map((set) => ({
      id: set.id,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: { ...set.evs },
      note: set.note,
    })),
  });
  const validation = validateTeamBuildSubmission(canonical, response, options);
  if (validation.status !== 'accepted') {
    throw new Error(`deterministic strict fallback was rejected: ${validation.problems.join('; ')}`);
  }
  return { response, validation };
}

function attemptLogFile(task: TeamBuildTask, logDir: string): string {
  if (task.provenance.seriesIndex !== undefined && task.provenance.entrant !== undefined) {
    return path.join(
      logDir,
      `series-${task.provenance.seriesIndex + 1}-e${task.provenance.entrant}-${slug(task.model)}.jsonl`,
    );
  }
  return path.join(logDir, `${slug(task.id)}-${slug(task.model)}.jsonl`);
}

function fallbackEvidence(rationale: string, notebook: string): StageEvidence {
  return { ...noStageEvidence(notebook), rationale };
}

async function runLeagueTeamBuild(task: TeamBuildTask, options: TeamBuildOptions): Promise<TeamBuildResult> {
  validateTeamBuildTask(task);
  if (task.executionPolicy !== 'league-resilient') {
    throw new Error('provider orchestration is reserved for league-resilient team building');
  }
  const executionPolicy = 'league-resilient' as const;
  const normalizedTask = canonicalTask(task, executionPolicy);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(task.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const ruleTable = Dex.formats.getRuleTable(format);
  const evLimit = ruleTable.evLimit ?? 508;
  const evMax = 32;
  const reference = new ShowdownReference(task.format, psDir);
  fs.mkdirSync(options.logDir, { recursive: true });
  const logFile = attemptLogFile(task, options.logDir);

  const system = systemPrompt(normalizedTask, dex, evLimit, evMax);
  const messages: ProviderMessage[] = [{ role: 'user', content: userPrompt(normalizedTask, dex) }];
  const reasoning = reasoningForModel(task.model, options);
  const provider =
    task.model === 'random'
      ? undefined
      : (options.makeTeambuildProvider?.(task.model, options.apiKeys?.[task.model], reasoning) ??
        makeProvider(parseSpec(task.model), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(options.apiKeys?.[task.model] === undefined ? {} : { apiKey: options.apiKeys[task.model] }),
        }));

  const owned = new Map(task.constraint.candidates.map((mon) => [mon.id, mon]));
  const runCreatedAt = options.createdAt ?? new Date().toISOString();
  let accepted: ParsedTeamBuild | undefined;
  let lastParsed: ParsedTeamBuild | undefined;
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
        spec: task.model,
        reference,
        ...(options.memory ? { extraTools: [memoryPageTool(() => options.memory!)] } : {}),
        policy: TEAMBUILD_PROMPT_POLICY,
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onLookup: (call) => lookups.push(call),
      });
      response = completion.text;
      usage = completion.usage;
      const truncated = completion.finishReason === 'length';
      if (!response.trim() && !truncated && completion.reasoning) {
        const salvaged = parseSets(completion.reasoning, task);
        if (typeof salvaged !== 'string') response = completion.reasoning;
      }
      const parsed = parseSets(response, normalizedTask);
      if (typeof parsed === 'string') {
        error = truncated ? 'the reply used its whole token budget before finishing the team' : parsed;
        lastError = error;
      } else {
        const problems = validateCandidate(dex, normalizedTask.format, parsed.sets, owned, psDir);
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
      const failure = classifyProviderFailure(cause, task.model);
      error = failure.summary;
      lastError = error;
      if (failure.pausable && options.recovery) pauseFailure = failure;
      else terminalError = new Error(`${failure.summary} The teambuild cannot continue.`, { cause });
    }
    const traceContext =
      task.objective.kind === 'matchup' &&
      task.provenance.seriesIndex !== undefined &&
      task.provenance.entrant !== undefined
        ? {
            series: task.provenance.seriesIndex + 1,
            entrant: task.provenance.entrant,
            opponent: task.objective.opponent.model,
          }
        : { task_id: task.id, objective: task.objective.kind, constraint: task.constraint.id };
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({
        ...traceContext,
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
      await options.recovery?.pause(task.model, pauseFailure, options.signal);
      attempt -= 1;
    }
  }

  const noParseRationale = provider
    ? `no parseable team after ${TEAMBUILD_PROMPT_POLICY.attempts} attempts (${lastError})`
    : task.objective.kind === 'matchup' && task.constraint.teamSize === 6
      ? 'random baseline: six of the roster with repaired legal sets'
      : `random baseline: ${task.constraint.teamSize} candidates with repaired legal sets`;
  const chosen =
    accepted ??
    lastParsed ??
    ({
      sets: fallbackSets(task.constraint.candidates, task.constraint.teamSize, options.rng, evLimit, evMax),
      evidence: fallbackEvidence(noParseRationale, task.notebook),
    } satisfies ParsedTeamBuild);
  const taken = new Set<string>();
  const views: TeambuildSetView[] = [];
  let repaired: Array<{ mon: TeamBuildCandidate; set: RawSet; repairs: string[] }> = chosen.sets.map((raw) => {
    const mon = owned.get(raw.id)!;
    return accepted
      ? { mon, set: raw, repairs: [] }
      : { mon, ...repairSet(dex, mon, raw, evLimit, evMax, taken, options.rng) };
  });

  const problems = validateCandidate(
    dex,
    task.format,
    repaired.map((entry) => entry.set),
    owned,
    psDir,
  );
  if (problems.length) {
    const fallbackTaken = new Set<string>();
    repaired = fallbackSets(task.constraint.candidates, task.constraint.teamSize, options.rng, evLimit, evMax).map(
      (raw) => {
        const mon = owned.get(raw.id)!;
        const rebuilt = repairSet(dex, mon, raw, evLimit, evMax, fallbackTaken, options.rng);
        return { mon, set: rebuilt.set, repairs: [`rebuilt from scratch: ${problems.join('; ')}`, ...rebuilt.repairs] };
      },
    );
    const fallbackProblems = validateCandidate(
      dex,
      task.format,
      repaired.map((entry) => entry.set),
      owned,
      psDir,
    );
    if (fallbackProblems.length) {
      throw new Error(`could not create a legal fallback team: ${fallbackProblems.join('; ')}`);
    }
  }

  for (const { mon, set, repairs } of repaired) {
    views.push({
      species: mon.name,
      spriteId: dex.species.get(mon.forme ?? mon.species).spriteid,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs: set.evs,
      note: set.note,
      repaired: repairs.length > 0,
      repairs,
    });
  }

  const packed = normalizePackedTeam(packCandidateTeam(dex, repaired, psDir), psDir, task.format);
  validateTeam(packed, task.format, psDir);
  const scaffold = teamBuildScaffoldRevision(task.objective, task.sheetPolicy, executionPolicy);
  const createdAt = runCreatedAt;
  const allRepairs = repaired.flatMap((entry) => entry.repairs.map((repair) => `${entry.mon.id}: ${repair}`));
  const artifact: TeamBuildArtifact = {
    schemaVersion: 1,
    status: 'valid',
    task: normalizedTask,
    executionPolicy,
    scaffold,
    showdownCommit: showdownCommit(psDir),
    action: {
      selected: repaired.map((entry) => entry.mon.id),
      packed,
      sets: views,
    },
    evidence: chosen.evidence,
    validation: {
      showdown: true,
      repaired: allRepairs.length > 0,
      repairs: allRepairs,
      problems: [],
    },
    attempts: attemptsUsed,
    fallback: accepted === undefined,
    createdAt,
  };
  return { packed, artifact };
}

export async function runTeambuild(request: TeambuildRequest, options: TeambuildOptions): Promise<TeambuildResult> {
  const task: TeamBuildTask = {
    id: `draft-series-${request.seriesIndex + 1}-entrant-${request.entrant}`,
    model: request.model,
    format: request.format,
    sheetPolicy: request.sheetPolicy ?? 'open',
    executionPolicy: 'league-resilient',
    constraint: {
      kind: 'draft-picks',
      id: `series-${request.seriesIndex + 1}-entrant-${request.entrant}-roster`,
      teamSize: 6,
      candidates: request.roster,
    },
    objective: {
      kind: 'matchup',
      stage: request.stage,
      opponent: { model: request.opponentModel, candidates: request.opponentRoster },
      priorContext: request.playoffContext,
    },
    notebook: [...renderMemory(request.memory), '', MEMORY_TOOL_NOTICE].join('\n'),
    provenance: {
      source: 'draft-league',
      seriesIndex: request.seriesIndex,
      entrant: request.entrant,
      opponent: request.opponent,
      memoryDigest: memoryDigest(request.memory),
    },
  };
  const result = await runLeagueTeamBuild(task, { ...options, memory: request.memory });
  const action = result.artifact.action;
  if (!result.packed || !action || result.artifact.status !== 'valid') {
    throw new Error('league-resilient team building ended without a valid team');
  }
  const view: TeambuildView = {
    seriesIndex: request.seriesIndex,
    entrant: request.entrant,
    opponent: request.opponent,
    brought: action.selected,
    sets: action.sets,
    rationale: result.artifact.evidence.rationale,
    attempts: result.artifact.attempts,
  };
  const journalRow = { artifact: result.artifact };
  decodeTeamBuildJournalRow(journalRow);
  fs.appendFileSync(path.join(options.logDir, 'teambuild.jsonl'), `${JSON.stringify(journalRow)}\n`, 'utf8');
  return { packed: result.packed, artifact: result.artifact, view };
}

function validateCandidate(
  dex: DexLike,
  format: string,
  sets: RawSet[],
  owned: Map<string, TeamBuildCandidate>,
  psDir: string,
): string[] {
  const problems: string[] = [];
  const entries: Array<{ mon: TeamBuildCandidate; set: RawSet }> = [];
  for (const set of sets) {
    const mon = owned.get(set.id);
    if (!mon) {
      problems.push(`${set.id}: not present in the task constraint`);
      continue;
    }
    entries.push({ mon, set });
    const label = `${mon.name}:`;
    const item = dex.items.get(set.item);
    if (set.item && (!item?.exists || item.name !== set.item)) {
      problems.push(`${label} item must use its canonical Showdown name`);
    }
    if (mon.item) {
      if (!item?.exists || item.name !== dex.items.get(mon.item).name) {
        problems.push(`${label} drafted as a Mega, so it must hold ${dex.items.get(mon.item).name}`);
      }
    } else if (item?.exists && item.megaStone) {
      problems.push(`${label} drafted as the base forme, so it can never hold ${item.name}`);
    }
    const ability = dex.abilities.get(set.ability);
    if (!ability?.exists || ability.name !== set.ability) {
      problems.push(`${label} ability must use its canonical Showdown name`);
    }
    const nature = dex.natures.get(set.nature);
    if (!nature?.exists || nature.name !== set.nature) {
      problems.push(`${label} nature must use its canonical Showdown name`);
    }
    for (const moveName of set.moves) {
      const move = dex.moves.get(moveName);
      if (!move?.exists || move.name !== moveName) {
        problems.push(`${label} move ${JSON.stringify(moveName)} must use its canonical Showdown name`);
      }
    }
  }

  if (entries.length !== sets.length) return problems;
  const packed = packCandidateTeam(dex, entries, psDir);
  try {
    validateTeam(packed, format, psDir);
  } catch (cause) {
    problems.push(...(cause instanceof Error ? cause.message : String(cause)).split('\n'));
  }
  return problems;
}

function minimalSet(mon: TeamBuildCandidate, evLimit: number, evMax: number): RawSet {
  const evs = Object.fromEntries(STATS.map((stat) => [stat, 0])) as Record<Stat, number>;
  let spent = 0;
  for (const stat of STATS) {
    const share = Math.min(evMax, Math.floor(evLimit / STATS.length), evLimit - spent);
    evs[stat] = share;
    spent += share;
  }
  return { id: mon.id, item: mon.item ?? '', ability: '', nature: 'Hardy', moves: [], evs, note: '' };
}

function fallbackSets(
  candidates: readonly TeamBuildCandidate[],
  teamSize: number,
  rng: Rng,
  evLimit: number,
  evMax: number,
): RawSet[] {
  const chosen: TeamBuildCandidate[] = [];
  const bases = new Set<string>();
  for (const mon of shuffle(candidates, rng)) {
    if (chosen.length >= teamSize || bases.has(mon.base)) continue;
    bases.add(mon.base);
    chosen.push(mon);
  }
  return chosen.map((mon) => minimalSet(mon, evLimit, evMax));
}
