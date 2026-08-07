#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { clusterNearDuplicatePositions, NEAR_DUPLICATE_PROTOCOL } from '../src/eval/duplicates.js';
import {
  assessPositionEligibility,
  type PositionEligibilityMetrics,
  type PositionEligibilityPolicy,
  validatePositionEligibilityPolicy,
} from '../src/eval/eligibility.js';
import { validatePositionPanelArtifacts } from '../src/eval/panel-artifact.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { assignPositionSplits, positionSplitDigest } from '../src/eval/splits.js';
import type { JsonObject } from '../src/types.js';

interface SplitFreezePolicy {
  schema_version: 1;
  status: 'frozen';
  policy_id: string;
  seed: string;
  eval_fraction: number;
  near_duplicate_threshold: number;
  eligibility: PositionEligibilityPolicy;
}

interface Settings {
  tasks: string;
  scores: string;
  sealed: string;
  policy: string;
  out: string;
  privateOut: string;
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    tasks: path.resolve('records/position-panels/tasks.pilot.jsonl'),
    scores: path.resolve('records/private/position-panels/scores.pilot.jsonl'),
    sealed: path.resolve('records/private/position-panels/sealed-panels.pilot.jsonl'),
    policy: '',
    out: path.resolve('records/position-panels/frozen'),
    privateOut: path.resolve('records/private/position-panels/frozen'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--tasks' && value) settings.tasks = path.resolve(value);
    else if (flag === '--scores' && value) settings.scores = path.resolve(value);
    else if (flag === '--sealed' && value) settings.sealed = path.resolve(value);
    else if (flag === '--policy' && value) settings.policy = path.resolve(value);
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else if (flag === '--private-out' && value) settings.privateOut = path.resolve(value);
  }
  if (!settings.policy) throw new Error('--policy <frozen-policy.json> is required');
  if (settings.out === settings.privateOut) throw new Error('public and private output roots must differ');
  return settings;
}

function fileDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rows(file: string): JsonObject[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${file} row ${index + 1} is invalid`);
      if (canonicalJson(value) !== line) throw new Error(`${file} row ${index + 1} is not canonical JSON`);
      return value as JsonObject;
    });
}

function policy(file: string): SplitFreezePolicy {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('split policy must be an object');
  const result = value as unknown as SplitFreezePolicy;
  const keys = Object.keys(result).sort();
  const expected = [
    'eligibility',
    'eval_fraction',
    'near_duplicate_threshold',
    'policy_id',
    'schema_version',
    'seed',
    'status',
  ];
  if (canonicalJson(keys) !== canonicalJson(expected)) throw new Error('split policy has unexpected or missing keys');
  if (result.schema_version !== 1 || result.status !== 'frozen' || !result.policy_id || !result.seed)
    throw new Error('split policy must be named and frozen at schema version 1');
  if (!(result.eval_fraction > 0 && result.eval_fraction < 1))
    throw new Error('eval_fraction must be between zero and one');
  if (!(result.near_duplicate_threshold >= 0 && result.near_duplicate_threshold <= 1))
    throw new Error('near_duplicate_threshold must be in [0, 1]');
  validatePositionEligibilityPolicy(result.eligibility);
  return result;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

const settings = parse(process.argv.slice(2));
const splitPolicy = policy(settings.policy);
const taskRows = rows(settings.tasks);
const scoreRows = rows(settings.scores);
const sealedRows = rows(settings.sealed);
validatePositionPanelArtifacts(taskRows, scoreRows, sealedRows);
const tasksById = new Map(taskRows.map((row) => [String(row.task_id), row]));
const scoresById = new Map(scoreRows.map((row) => [String(row.task_id), row]));
const sealedById = new Map(sealedRows.map((row) => [String(row.task_id), row]));
const exclusions: JsonObject[] = [];
const eligibleIds: string[] = [];
for (const task of taskRows) {
  const id = String(task.task_id);
  const score = scoresById.get(id) as JsonObject;
  const assessment = assessPositionEligibility(
    score.eligibility_metrics as unknown as PositionEligibilityMetrics,
    splitPolicy.eligibility,
  );
  const structural = (score.structural_reasons as unknown[]).map(String);
  const reasons = [...structural, ...assessment.reasons];
  if (reasons.length) exclusions.push({ schema_version: 1, task_id: id, reasons });
  else eligibleIds.push(id);
}
if (eligibleIds.length < 2) throw new Error('fewer than two positions pass the frozen eligibility policy');
const duplicate = clusterNearDuplicatePositions(
  eligibleIds.map((id) => ({ id, prompt: String((tasksById.get(id) as JsonObject).prompt) })),
  splitPolicy.near_duplicate_threshold,
);
const assignments = assignPositionSplits(
  eligibleIds.map((id) => ({
    taskId: id,
    sourceGroup: String((sealedById.get(id) as JsonObject).source_group),
    duplicateCluster: duplicate.clusters.get(id) as string,
  })),
  splitPolicy.seed,
  splitPolicy.eval_fraction,
);
const splitById = new Map(assignments.map((entry) => [entry.taskId, entry.split]));
if (!assignments.some((entry) => entry.split === 'train') || !assignments.some((entry) => entry.split === 'eval'))
  throw new Error(
    'frozen assignment produced an empty train or eval split; review the policy seed or corpus components',
  );
const orderedIds = assignments.map((entry) => entry.taskId);
const selectedTasks = orderedIds.map((id) => ({
  ...(tasksById.get(id) as JsonObject),
  split: splitById.get(id) as string,
}));
const selectedScores = orderedIds.map((id) => ({
  ...(scoresById.get(id) as JsonObject),
  eligibility_status: 'eligible-under-frozen-policy',
}));
const selectedSealed = orderedIds.map((id) => sealedById.get(id) as JsonObject);
validatePositionPanelArtifacts(selectedTasks, selectedScores, selectedSealed);
const publicFiles = {
  train: path.join(settings.out, 'tasks.train.jsonl'),
  eval: path.join(settings.out, 'tasks.eval.jsonl'),
};
const privateFiles = {
  trainScores: path.join(settings.privateOut, 'scores.train.jsonl'),
  evalScores: path.join(settings.privateOut, 'scores.eval.jsonl'),
  trainSealed: path.join(settings.privateOut, 'sealed-panels.train.jsonl'),
  evalSealed: path.join(settings.privateOut, 'sealed-panels.eval.jsonl'),
  assignments: path.join(settings.privateOut, 'split-assignments.jsonl'),
  duplicatePairs: path.join(settings.privateOut, 'near-duplicate-pairs.jsonl'),
  exclusions: path.join(settings.privateOut, 'exclusions.jsonl'),
};
const forSplit = (rows: JsonObject[], split: 'train' | 'eval') =>
  rows.filter((row) => splitById.get(String(row.task_id)) === split);
write(publicFiles.train, canonicalJsonl(forSplit(selectedTasks, 'train')));
write(publicFiles.eval, canonicalJsonl(forSplit(selectedTasks, 'eval')));
write(privateFiles.trainScores, canonicalJsonl(forSplit(selectedScores, 'train')));
write(privateFiles.evalScores, canonicalJsonl(forSplit(selectedScores, 'eval')));
write(privateFiles.trainSealed, canonicalJsonl(forSplit(selectedSealed, 'train')));
write(privateFiles.evalSealed, canonicalJsonl(forSplit(selectedSealed, 'eval')));
write(privateFiles.assignments, canonicalJsonl(assignments));
write(privateFiles.duplicatePairs, canonicalJsonl(duplicate.pairs));
write(privateFiles.exclusions, canonicalJsonl(exclusions));
const artifact = (file: string) => ({ sha256: fileDigest(file), rows: rows(file).length });
const manifest = {
  schema_version: 1,
  release_ready: false,
  status: 'candidate-splits-frozen-not-release-approved',
  remaining_release_gates: [
    'horizon-sensitivity',
    'hidden-information-treatment',
    'criterion-validation',
    'package-smoke-tests',
  ],
  policy: splitPolicy,
  policy_canonical_digest: canonicalJsonDigest(splitPolicy),
  canonical_json: CANONICAL_JSON_PROTOCOL,
  near_duplicate_protocol: NEAR_DUPLICATE_PROTOCOL,
  split_digest: positionSplitDigest(assignments),
  inputs: {
    tasks: fileDigest(settings.tasks),
    scores: fileDigest(settings.scores),
    sealed: fileDigest(settings.sealed),
    policy_file: fileDigest(settings.policy),
  },
  counts: {
    input: taskRows.length,
    eligible: eligibleIds.length,
    excluded: exclusions.length,
    train: assignments.filter((entry) => entry.split === 'train').length,
    eval: assignments.filter((entry) => entry.split === 'eval').length,
    source_groups: new Set(assignments.map((entry) => entry.sourceGroup)).size,
    duplicate_clusters: new Set(assignments.map((entry) => entry.duplicateCluster)).size,
    near_duplicate_pairs: duplicate.pairs.length,
  },
  outputs: {
    tasks_train: artifact(publicFiles.train),
    tasks_eval: artifact(publicFiles.eval),
    scores_train: artifact(privateFiles.trainScores),
    scores_eval: artifact(privateFiles.evalScores),
    sealed_train: artifact(privateFiles.trainSealed),
    sealed_eval: artifact(privateFiles.evalSealed),
    assignments: artifact(privateFiles.assignments),
    near_duplicate_pairs: artifact(privateFiles.duplicatePairs),
    exclusions: artifact(privateFiles.exclusions),
  },
  ordered_train_task_ids: assignments.filter((entry) => entry.split === 'train').map((entry) => entry.taskId),
  ordered_eval_task_ids: assignments.filter((entry) => entry.split === 'eval').map((entry) => entry.taskId),
};
write(path.join(settings.out, 'manifest.json'), `${canonicalJson(manifest)}\n`);
