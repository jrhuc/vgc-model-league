#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CounterfactualOptions,
  counterfactualProtocol,
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
} from '../src/eval/counterfactual.js';
import { ACTION_PROTOCOL, type Position } from '../src/eval/fork.js';
import { POSITION_TASK_PROTOCOL, renderPositionTask, validateTaskScoreJoin } from '../src/eval/task.js';
import { DATA_DIR, defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import type { BattleRequest, JsonObject, Pid } from '../src/types.js';

interface Settings extends CounterfactualOptions {
  set: string;
  privateSet: string;
  out: string;
  privateOut: string;
}

function parse(argv: string[]): Settings {
  const out = path.join(DATA_DIR, 'records', 'position-panels');
  const settings: Settings = {
    set: path.join(DATA_DIR, 'records', 'position-set.json'),
    privateSet: path.join(DATA_DIR, 'records', 'private', 'position-set.json'),
    out,
    privateOut: path.join(DATA_DIR, 'records', 'private', 'position-panels'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--set' && value) settings.set = path.resolve(value);
    else if (flag === '--private-set' && value) settings.privateSet = path.resolve(value);
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else if (flag === '--private-out' && value) settings.privateOut = path.resolve(value);
    else if (flag === '--horizon' && value)
      settings.horizon = value === 'end' ? Number.POSITIVE_INFINITY : Number(value);
    else if (flag === '--luck' && value) settings.luckSamples = Number(value);
    else if (flag === '--opponents' && value) settings.opponentSamples = Number(value);
    else if (flag === '--seed' && value) settings.seed = value;
    else if (flag === '--ps-dir' && value) settings.psDir = path.resolve(value);
    else throw new Error(`unknown option or missing value: ${flag}`);
    index += 1;
  }
  for (const [name, value] of [
    ['luck', settings.luckSamples],
    ['opponents', settings.opponentSamples],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  if (
    settings.horizon !== undefined &&
    settings.horizon !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(settings.horizon) || settings.horizon < 0)
  ) {
    throw new Error('--horizon must be a non-negative integer or end');
  }
  if (path.resolve(settings.out) === path.resolve(settings.privateOut)) {
    throw new Error('public and private output roots must differ');
  }
  return settings;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digestParts(parts: Iterable<string>): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`, 'utf8').update(part, 'utf8');
  return hash.digest('hex');
}

function evaluatorDigest(): string {
  const tool = fileURLToPath(import.meta.url);
  const files = [
    tool,
    path.resolve(path.dirname(tool), '../src/eval/counterfactual.js'),
    path.resolve(path.dirname(tool), '../src/eval/fork.js'),
    path.resolve(path.dirname(tool), '../src/eval/task.js'),
    path.resolve(path.dirname(tool), '../src/choices.js'),
    path.resolve(path.dirname(tool), '../src/state.js'),
    path.resolve(path.dirname(tool), '../src/reference.js'),
    path.resolve(path.dirname(tool), '../src/random.js'),
    path.resolve(path.dirname(tool), '../src/sim.js'),
  ];
  return digestParts(
    files.map(
      (file) => `${path.basename(file)}
${fs.readFileSync(file, 'utf8')}`,
    ),
  );
}

function readObject(file: string): JsonObject {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must hold one JSON object`);
  return value as JsonObject;
}

function rows(value: JsonObject, file: string): JsonObject[] {
  if (!Array.isArray(value.positions)) throw new Error(`${file} has no positions array`);
  return value.positions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`${file} has a malformed position`);
    return entry as JsonObject;
  });
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function jsonl(values: JsonObject[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');
}

function taskPosition(publicRow: JsonObject, privateRow: JsonObject): { position: Position; pid: Pid } {
  const source = privateRow.source as JsonObject | undefined;
  const pid = source?.pid;
  if (pid !== 'p1' && pid !== 'p2') throw new Error(`position ${String(publicRow.id)} has no private pid`);
  const foe: Pid = pid === 'p1' ? 'p2' : 'p1';
  const request = publicRow.request as BattleRequest | undefined;
  if (!request) throw new Error(`position ${String(publicRow.id)} has no public request`);
  const opponent = privateRow.opponent_request as BattleRequest | null | undefined;
  const requests = { [pid]: request } as Record<Pid, BattleRequest>;
  if (opponent) requests[foe] = opponent;
  return {
    pid,
    position: {
      index: Number(source?.position_index ?? 0),
      turn: Number(publicRow.turn ?? 0),
      pending: opponent ? [pid, foe] : [pid],
      requests,
      actual: {},
      choiceIndex: {},
      seen: { p1: 0, p2: 0 },
      snapshot: String(privateRow.snapshot ?? ''),
    },
  };
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const publicSet = readObject(settings.set);
  const privateSet = readObject(settings.privateSet);
  if (typeof publicSet.id !== 'string' || publicSet.id !== privateSet.id) {
    throw new Error('public and private position sets do not share one id');
  }
  if (privateSet.public_checksum !== digest(publicSet)) throw new Error('private set does not bind the public set');
  const publicRows = rows(publicSet, settings.set);
  const privateRows = rows(privateSet, settings.privateSet);
  const privateById = new Map(privateRows.map((row) => [String(row.id), row]));
  if (privateById.size !== privateRows.length || publicRows.length !== privateRows.length) {
    throw new Error('public and private position sets are not a bijection');
  }

  const taskRows: JsonObject[] = [];
  const scoreRows: JsonObject[] = [];
  const sealedRows: JsonObject[] = [];
  for (const [index, publicRow] of publicRows.entries()) {
    const sourceId = String(publicRow.id ?? '');
    const privateRow = privateById.get(sourceId);
    if (!sourceId || !privateRow) throw new Error(`public position ${sourceId || index} has no private row`);
    const { position, pid } = taskPosition(publicRow, privateRow);
    const seed = `${String(settings.seed ?? 'position-panels')}:${sourceId}`;
    const table = evaluateActionTable(position, pid, { ...settings, seed });
    if (!table) throw new Error(`position ${sourceId} did not produce three complete exhaustive panels`);
    const rendered = renderPositionTask({
      id: sourceId,
      format: String(publicRow.format ?? ''),
      pid,
      request: position.requests[pid],
      seen: Array.isArray(publicRow.seen) ? publicRow.seen.map(String) : [],
      ...(settings.psDir ? { psDir: settings.psDir } : {}),
    });
    const measuredByAction = new Map(table.measurement.actions.map((entry) => [entry.action, entry]));
    if (
      rendered.actions.length !== table.legal ||
      rendered.actions.some((entry) => !measuredByAction.has(entry.canonicalAction))
    ) {
      throw new Error(`position ${sourceId} prompt action map does not match its exhaustive panel`);
    }
    const taskId = digest([publicSet.id, sourceId, POSITION_TASK_PROTOCOL, rendered.prompt, rendered.actions]);
    const scoredActions = rendered.actions.map((entry) => {
      const measured = measuredByAction.get(entry.canonicalAction);
      if (!measured) throw new Error(`position ${sourceId} is missing ${entry.canonicalAction}`);
      return {
        number: entry.number,
        canonicalAction: entry.canonicalAction,
        meanValue: measured.value,
        standardError: measured.standardError,
        samples: measured.samples,
        normalizedReward: measured.reward,
      };
    });
    validateTaskScoreJoin(rendered.actions, scoredActions);
    const structuralReasons = [
      ...(table.stability.some((panel) => panel.span <= 0) ? ['zero_stability_span'] : []),
      ...(table.heldOutSpan.lower95 <= 0 ? ['span_uncertain'] : []),
      ...(!table.rankingStable ? ['best_anchor_unstable'] : []),
      ...(!table.anchorAgreement ? ['extrema_sets_unstable'] : []),
      ...(table.valueSpan <= 0 ? ['zero_measurement_span'] : []),
    ];
    taskRows.push({
      schema_version: 1,
      task_id: taskId,
      split: 'pilot',
      format: rendered.format,
      phase: rendered.phase,
      turn: rendered.turn,
      prompt: rendered.prompt,
      response_schema: {
        type: 'object',
        required: ['choice'],
        properties: { choice: { type: 'integer', minimum: 0, maximum: rendered.actions.length - 1 } },
        additionalProperties: false,
      },
      actions: rendered.actions.map((entry) => ({
        number: entry.number,
        canonical_action: entry.canonicalAction,
        label: entry.label,
      })),
    });
    scoreRows.push({
      schema_version: 1,
      task_id: taskId,
      structural_pass: structuralReasons.length === 0,
      structural_reasons: structuralReasons,
      eligibility_status: 'pilot-thresholds-not-frozen',
      measurement_panel: {
        id: table.measurement.id,
        n: table.measurement.draws.length,
        matrix_digest: table.measurement.matrixDigest,
      },
      min_value: Math.min(...table.measurement.actions.map((entry) => entry.value)),
      max_value: Math.max(...table.measurement.actions.map((entry) => entry.value)),
      span: table.valueSpan,
      actions: scoredActions.map((entry) => ({
        number: entry.number,
        canonical_action: entry.canonicalAction,
        mean_value: entry.meanValue,
        standard_error: entry.standardError,
        n: entry.samples,
        normalized_reward: entry.normalizedReward,
      })),
      stability: {
        matrix_digests: table.stability.map((panel) => panel.matrixDigest),
        spans: table.stability.map((panel) => panel.span),
        best_anchor_agreement: table.rankingStable,
        extrema_set_agreement: table.anchorAgreement,
        max_normalized_reward_drift: table.maxNormalizedRewardDrift,
        held_out_span: table.heldOutSpan,
      },
    });
    const source = privateRow.source as JsonObject;
    const sourceGroup = `${String(source.run_id)}:${String(source.series_id)}:${String(source.game_number)}`;
    const exactPublicFingerprint = digest([
      'exact-public-task-v1',
      rendered.format,
      rendered.phase,
      rendered.prompt,
      rendered.actions,
    ]);
    sealedRows.push({
      schema_version: 1,
      task_id: taskId,
      source_id: sourceId,
      source_group: sourceGroup,
      exact_public_fingerprint: exactPublicFingerprint,
      source: privateRow.source,
      snapshot: privateRow.snapshot,
      opponent_request: privateRow.opponent_request,
      panel_seed: seed,
      table,
    });
    process.stdout.write(`exported ${index + 1}/${publicRows.length} ${taskId}\n`);
  }
  if (privateById.size !== taskRows.length) throw new Error('private position set contains an unmatched row');

  const taskFile = path.join(settings.out, 'tasks.pilot.jsonl');
  const scoreFile = path.join(settings.privateOut, 'scores.pilot.jsonl');
  const sealedFile = path.join(settings.privateOut, 'sealed-panels.pilot.jsonl');
  writeAtomic(taskFile, jsonl(taskRows));
  writeAtomic(scoreFile, jsonl(scoreRows));
  writeAtomic(sealedFile, jsonl(sealedRows));
  const manifest = {
    schema_version: 1,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: publicSet.id,
    evaluator_digest: evaluatorDigest(),
    showdown_commit: showdownCommit(settings.psDir ?? defaultPsDir()),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    counterfactual: counterfactualProtocol(settings),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    seed_namespace: String(settings.seed ?? 'position-panels'),
    inputs: {
      public_set: fileDigest(settings.set),
      private_set: fileDigest(settings.privateSet),
    },
    outputs: {
      tasks: { file: path.basename(taskFile), sha256: fileDigest(taskFile), rows: taskRows.length },
      scores: { sha256: fileDigest(scoreFile), rows: scoreRows.length },
      sealed_panels: { sha256: fileDigest(sealedFile), rows: sealedRows.length },
    },
    ordered_task_ids: taskRows.map((row) => row.task_id),
  };
  writeAtomic(path.join(settings.out, 'manifest.pilot.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
