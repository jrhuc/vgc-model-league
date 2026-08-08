import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AuthService } from '../src/auth.js';

import { COUNTERFACTUAL_PROTOCOL_VERSION, EXHAUSTIVE_PANEL_PROTOCOL, REFERENCE } from '../src/eval/counterfactual.js';
import { NEAR_DUPLICATE_PROTOCOL } from '../src/eval/duplicates.js';
import { ACTION_PROTOCOL } from '../src/eval/fork.js';
import { POSITION_SOURCE_GROUP_PROTOCOL } from '../src/eval/panel-artifact.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL } from '../src/eval/task.js';
import type { ResearchResponse } from '../src/gui/api.js';
import { buildResearchIndex } from '../src/gui/research.js';
import { GuiServer } from '../src/gui/server.js';
import type { JsonObject } from '../src/types.js';

const COUNTERFACTUAL_PROTOCOL = {
  version: COUNTERFACTUAL_PROTOCOL_VERSION,
  reference: REFERENCE,
  horizon: 2,
  luckSamples: 8,
  opponentSamples: 4,
  shortlist: 8,
  screenSamples: 2,
  rolloutLimit: 60,
} as const;

function digest(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeObject(file: string, value: unknown): Buffer {
  const content = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return content;
}

function task(
  taskId: string,
  split: 'pilot' | 'train' | 'eval',
  turn: number,
  phase: 'team_preview' | 'forced_switch' | 'turn' = 'turn',
): JsonObject {
  const actions = [
    { number: 0, canonical_action: 'move 1 1, move 1 1', label: 'Thunderbolt → opposing slot 1; Protect' },
    { number: 1, canonical_action: 'switch 3, move 1 1', label: 'Switch slot 1 → reserve slot 3; Protect' },
  ];
  const prefix =
    'Choose one legal joint action for this controlled Pokemon VGC position.\nThe action list is exhaustive. Select the number for the complete joint action, not one part of it.\n\n';
  const response =
    'Return exactly one JSON object {"choice":N}, where N is a zero-based action number above. Include no other keys or prose.';
  const prompt = `${prefix}Turn ${turn}\nPublic battlefield only\n\nLEGAL JOINT ACTIONS:\n${actions
    .map((action) => `${action.number}. ${action.label}`)
    .join('\n')}\n\n${response}`;
  return {
    schema_version: 2,
    task_id: taskId,
    split,
    format: 'gen9championsvgc2026regmbbo3',
    phase,
    turn,
    prompt,
    actions,
    response_schema: {
      type: 'object',
      required: ['choice'],
      properties: { choice: { type: 'integer', minimum: 0, maximum: actions.length - 1 } },
      additionalProperties: false,
    },
  };
}

interface PilotFixture {
  manifest: JsonObject;
  manifestBytes: Buffer;
  rows: JsonObject[];
}

function writePilot(records: string, rows: JsonObject[] = [task('pilot-task', 'pilot', 3)]): PilotFixture {
  const root = path.join(records, 'position-panels');
  const taskContent = canonicalJsonl(rows);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks.pilot.jsonl'), taskContent, 'utf8');
  const manifest: JsonObject = {
    schema_version: 2,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics_version: 2,
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: 'candidate-source-set-v1',
    evaluator_digest: '1'.repeat(64),
    runtime: { node: 'upstream-node', platform: 'upstream-platform', arch: 'upstream-arch' },
    showdown_commit: '7'.repeat(40),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: COUNTERFACTUAL_PROTOCOL,
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: 'candidate-seed-v1',
    inputs: { public_set: '3'.repeat(64), private_set: '4'.repeat(64) },
    outputs: {
      tasks: { file: 'tasks.pilot.jsonl', sha256: digest(taskContent), rows: rows.length },
      scores: { sha256: '5'.repeat(64), rows: rows.length },
      sealed_panels: { sha256: '6'.repeat(64), rows: rows.length },
    },
    ordered_task_ids: rows.map((row) => row.task_id),
  };
  const manifestBytes = writeObject(path.join(root, 'manifest.pilot.json'), manifest);
  return { manifest, manifestBytes, rows };
}

function upstream(sha: string, sourceSetId: string, evaluatorDigest: string, seedNamespace: string): JsonObject {
  return {
    sha256: sha,
    source_set_id: sourceSetId,
    evaluator_digest: evaluatorDigest,
    runtime: { node: 'upstream-node', platform: 'upstream-platform', arch: 'upstream-arch' },
    showdown_commit: '7'.repeat(40),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    counterfactual: COUNTERFACTUAL_PROTOCOL,
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: seedNamespace,
  };
}

function writeFrozen(records: string, pilot: PilotFixture): void {
  assert.ok(pilot.rows.length >= 2 && pilot.rows.length % 2 === 0, 'frozen fixture needs equal nonempty splits');
  const root = path.join(records, 'position-panels', 'frozen');
  const midpoint = pilot.rows.length / 2;
  const trainRows: JsonObject[] = pilot.rows.slice(0, midpoint).map((row) => ({ ...row, split: 'train' }));
  const evalRows: JsonObject[] = pilot.rows.slice(midpoint).map((row) => ({ ...row, split: 'eval' }));
  const trainContent = canonicalJsonl(trainRows);
  const evalContent = canonicalJsonl(evalRows);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks.train.jsonl'), trainContent, 'utf8');
  fs.writeFileSync(path.join(root, 'tasks.eval.jsonl'), evalContent, 'utf8');
  const calibrationSha = '8'.repeat(64);
  const pilotManifestSha = digest(pilot.manifestBytes);
  const outputs = pilot.manifest.outputs as JsonObject;
  const taskBinding = outputs.tasks as JsonObject;
  const scoreBinding = outputs.scores as JsonObject;
  const sealedBinding = outputs.sealed_panels as JsonObject;
  const policy: JsonObject = {
    schema_version: 2,
    status: 'frozen',
    policy_id: 'reviewed-policy-v1',
    calibration_manifest_sha256: calibrationSha,
    seed: 'split-seed-v1',
    eval_fraction: 0.5,
    near_duplicate_threshold: 0.9,
    max_eval_fraction_deviation: 0,
    max_stratum_eval_fraction_deviation: 0,
    eligibility: {
      schema_version: 2,
      status: 'frozen',
      min_luck_replications: 2,
      min_sampled_opponent_slots: 2,
      min_held_out_span_value: 0.5,
      max_held_out_span_standard_error: 0,
      min_stability_rank_correlation: 1,
      max_normalized_reward_drift: 0,
      max_qualification_normalized_standard_error: 0,
      require_best_anchor_agreement: true,
      require_extrema_set_agreement: true,
    },
  };
  writeObject(path.join(root, 'manifest.json'), {
    schema_version: 2,
    release_ready: false,
    status: 'candidate-splits-frozen-not-release-approved',
    remaining_release_gates: [
      'horizon-sensitivity',
      'hidden-information-treatment',
      'criterion-validation',
      'calibration-candidate-semantic-near-duplicate-separation-audit',
      'package-smoke-tests',
    ],
    policy,
    splitter_digest: '9'.repeat(64),
    runtime: { node: 'split-node', platform: 'split-platform', arch: 'split-arch' },
    upstream_pilot_manifest: {
      sha256: pilotManifestSha,
      source_set_id: pilot.manifest.source_set_id,
      evaluator_digest: pilot.manifest.evaluator_digest,
      runtime: pilot.manifest.runtime,
      showdown_commit: pilot.manifest.showdown_commit,
      action_protocol: pilot.manifest.action_protocol,
      task_protocol: pilot.manifest.task_protocol,
      counterfactual: pilot.manifest.counterfactual,
      exhaustive_panels: pilot.manifest.exhaustive_panels,
      source_group_protocol: pilot.manifest.source_group_protocol,
      seed_namespace: pilot.manifest.seed_namespace,
    },
    upstream_calibration_manifest: upstream(
      calibrationSha,
      'calibration-source-set-v1',
      pilot.manifest.evaluator_digest as string,
      'calibration-seed-v1',
    ),
    calibration_candidate_separation: {
      exact_checks: [
        'manifest-sha256-non-identical',
        'source-set-id-non-identical',
        'whole-input-digest-tuple-non-identical',
        'ordered-task-id-sets-non-overlapping',
      ],
      semantic_near_duplicate_separation: 'not-auditable-from-pilot-manifests-release-gate-required',
    },
    policy_canonical_digest: canonicalJsonDigest(policy),
    canonical_json: CANONICAL_JSON_PROTOCOL,
    near_duplicate_protocol: NEAR_DUPLICATE_PROTOCOL,
    exclusion_row_protocol: {
      version: 2,
      rowSchemaVersion: 2,
      keys: ['reasons', 'schema_version', 'task_id'],
      taskId: 'nonempty-trimmed-string',
      reasons: 'nonempty-array-of-nonempty-trimmed-strings-preserve-order',
    },
    split_digest: 'b'.repeat(64),
    split_balance: {
      evalFraction: 0.5,
      evalFractionDeviation: 0,
      strata: {
        'fixture/all': { total: pilot.rows.length, eval: evalRows.length, evalFraction: 0.5, deviation: 0 },
      },
      maxStratumDeviation: 0,
    },
    inputs: {
      tasks: taskBinding.sha256,
      scores: scoreBinding.sha256,
      sealed: sealedBinding.sha256,
      pilot_manifest: pilotManifestSha,
      calibration_manifest: calibrationSha,
      policy_file: 'f'.repeat(64),
    },
    counts: {
      input: pilot.rows.length,
      eligible: pilot.rows.length,
      excluded: 0,
      train: trainRows.length,
      eval: evalRows.length,
      source_groups: pilot.rows.length,
      duplicate_clusters: pilot.rows.length,
      near_duplicate_pairs: 0,
    },
    outputs: {
      tasks_train: { sha256: digest(trainContent), rows: trainRows.length },
      tasks_eval: { sha256: digest(evalContent), rows: evalRows.length },
      scores_train: { sha256: '1'.repeat(64), rows: trainRows.length },
      scores_eval: { sha256: '2'.repeat(64), rows: evalRows.length },
      sealed_train: { sha256: '3'.repeat(64), rows: trainRows.length },
      sealed_eval: { sha256: '4'.repeat(64), rows: evalRows.length },
      assignments: { sha256: '5'.repeat(64), rows: pilot.rows.length },
      near_duplicate_pairs: { sha256: '6'.repeat(64), rows: 0 },
      exclusions: { sha256: '7'.repeat(64), rows: 0 },
    },
    ordered_train_task_ids: trainRows.map((row) => row.task_id),
    ordered_eval_task_ids: evalRows.map((row) => row.task_id),
  });
}

function writePilotForFrozen(records: string): PilotFixture {
  return writePilot(records, [task('train-task', 'pilot', 4), task('eval-task', 'pilot', 5)]);
}

function fixture(t: { after(callback: () => void): void }): string {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-research-'));
  t.after(() => fs.rmSync(records, { recursive: true, force: true }));
  return records;
}

function serverJson(port: number, host = '127.0.0.1', cookie?: string): Promise<ResearchResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<ResearchResponse>();
  const headers = cookie ? { host, cookie } : { host };
  const request = http.request({ host: '127.0.0.1', port, path: '/api/research', headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      assert.equal(response.statusCode, 200);
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResearchResponse);
    });
  });
  request.on('error', reject);
  request.end();
  return promise;
}

test('research index is honest when schema-v2 artifacts have not been generated', (t) => {
  const records = fixture(t);
  fs.writeFileSync(path.join(records, 'positions.jsonl'), '{legacy:true}\n{legacy:true}\n', 'utf8');
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.program, {
    positions: { target: 'vgc-positions-v1', stage: 'not-generated' },
    draftCircuit: { target: 'vgc-draft-circuit-v1', stage: 'design' },
  });
  assert.deepEqual(result.legacyPositions, {
    present: true,
    rows: 2,
    manifestBound: false,
    displayPolicy: 'inventory-only',
  });
});

test('research index validates pilot and frozen public artifacts and returns bounded safe previews', async (t) => {
  const records = fixture(t);
  const pilot = writePilotForFrozen(records);
  writeFrozen(records, pilot);
  const gui = new GuiServer({ recordsPath: path.join(records, 'results.jsonl') });
  const base = await gui.listen(0);
  t.after(() => gui.close());
  const address = gui.server.address();
  assert.ok(address && typeof address === 'object');
  const result = await serverJson(address.port);
  assert.equal(new URL(base).hostname, '127.0.0.1');
  assert.equal(result.status, 'ready');
  assert.equal(result.program.positions.stage, 'candidate');
  assert.equal(result.artifacts.length, 2);
  const pilotView = result.artifacts.find((artifact) => artifact.kind === 'pilot');
  const frozenView = result.artifacts.find((artifact) => artifact.kind === 'frozen');
  assert.equal(pilotView?.validation.status, 'valid');
  assert.equal(pilotView?.taskPreviewAvailability, 'available');
  assert.equal(pilotView?.taskTotal, 2);
  assert.deepEqual(pilotView?.tasks[0]?.actions, [
    {
      number: 0,
      canonicalAction: 'move 1 1, move 1 1',
      label: 'Thunderbolt → opposing slot 1; Protect',
    },
    {
      number: 1,
      canonicalAction: 'switch 3, move 1 1',
      label: 'Switch slot 1 → reserve slot 3; Protect',
    },
  ]);
  assert.equal(frozenView?.validation.status, 'valid');
  assert.deepEqual(frozenView?.releaseGates, [
    'horizon-sensitivity',
    'hidden-information-treatment',
    'criterion-validation',
    'calibration-candidate-semantic-near-duplicate-separation-audit',
    'package-smoke-tests',
  ]);
  assert.equal(frozenView?.taskPreviewAvailability, 'available');
  assert.equal(frozenView?.taskTotal, 2);
  assert.deepEqual(frozenView?.counts, {
    input: 2,
    eligible: 2,
    excluded: 0,
    train: 1,
    eval: 1,
    sourceGroups: 2,
    duplicateClusters: 2,
    nearDuplicatePairs: 0,
  });
  assert.equal(frozenView?.splitBalance?.evalFraction, 0.5);
  assert.deepEqual(
    frozenView?.tasks.map((entry) => entry.split),
    ['train', 'eval'],
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /scores_train|sealed_train|snapshot|opponent_request|played_by/iu);
});

test('research index fails closed on malformed and noncanonical manifests without hiding valid siblings', (t) => {
  const records = fixture(t);
  const pilot = writePilotForFrozen(records);
  writeFrozen(records, pilot);
  fs.writeFileSync(
    path.join(records, 'position-panels', 'manifest.pilot.json'),
    JSON.stringify(pilot.manifest, null, 2),
    'utf8',
  );
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(result.status, 'degraded');
  assert.equal(result.program.positions.stage, 'invalid');
  const invalid = result.artifacts.find((artifact) => artifact.kind === 'pilot');
  const valid = result.artifacts.find((artifact) => artifact.kind === 'frozen');
  assert.equal(invalid?.validation.status, 'invalid');
  assert.equal(invalid?.releaseReady, null);
  assert.equal(invalid?.validation.errors[0], 'pilot public artifact is malformed, noncanonical, or unsupported');
  assert.equal(invalid?.protocols, null);
  assert.equal(invalid?.provenance, null);
  assert.equal(invalid?.taskTotal, 0);
  assert.deepEqual(invalid?.tasks, []);
  assert.equal(valid?.validation.status, 'invalid');
  assert.equal(valid?.releaseReady, null);

  pilot.manifest['attacker-controlled-private-key'] = 'ATTACKER_ERROR_MARKER';
  writeObject(path.join(records, 'position-panels', 'manifest.pilot.json'), pilot.manifest);
  const attackerControlled = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(
    attackerControlled.artifacts.find((artifact) => artifact.kind === 'pilot')?.validation.errors[0],
    'pilot public artifact failed integrity validation',
  );
  assert.doesNotMatch(JSON.stringify(attackerControlled), /attacker-controlled-private-key|ATTACKER_ERROR_MARKER/);
});

test('research index never follows public links or scans records/private', (t) => {
  const records = fixture(t);
  const publicRoot = path.join(records, 'position-panels');
  const privateRoot = path.join(records, 'private', 'position-panels');
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.mkdirSync(privateRoot, { recursive: true });
  const privateMarker = 'PRIVATE_SOURCE_IDENTITY_DO_NOT_LEAK';
  fs.writeFileSync(path.join(privateRoot, 'manifest.pilot.json'), `{"secret":"${privateMarker}"}\n`, 'utf8');
  fs.writeFileSync(path.join(privateRoot, 'scores.pilot.jsonl'), `{"score":"${privateMarker}"}\n`, 'utf8');
  const empty = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(empty.status, 'empty');
  assert.doesNotMatch(JSON.stringify(empty), new RegExp(privateMarker));

  fs.symlinkSync(path.join(privateRoot, 'manifest.pilot.json'), path.join(publicRoot, 'manifest.pilot.json'));
  fs.writeFileSync(path.join(publicRoot, 'tasks.pilot.jsonl'), '{}\n', 'utf8');
  const linked = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(linked.status, 'degraded');
  assert.equal(linked.artifacts[0]?.validation.status, 'invalid');
  assert.equal(linked.artifacts[0]?.validation.errors[0], 'pilot public artifact path or file identity is unsafe');
  assert.doesNotMatch(JSON.stringify(linked), new RegExp(privateMarker));
});

test('canonical zero-row pilot remains a valid empty pilot artifact', (t) => {
  const records = fixture(t);
  writePilot(records, []);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.program.positions.stage, 'pilot');
  const pilot = result.artifacts[0];
  assert.equal(pilot?.validation.status, 'valid');
  assert.equal(pilot?.releaseReady, false);
  assert.equal(pilot?.counts?.input, 0);
  assert.equal(pilot?.taskTotal, 0);
  assert.equal(pilot?.taskPreviewCount, 0);
  assert.deepEqual(pilot?.tasks, []);
});

test('research cache invalidates when a bound public task file identity changes', (t) => {
  const records = fixture(t);
  writePilot(records);
  const first = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(first.artifacts[0]?.validation.status, 'valid');
  fs.writeFileSync(
    path.join(records, 'position-panels', 'tasks.pilot.jsonl'),
    canonicalJsonl([task('changed-task', 'pilot', 6)]),
    'utf8',
  );
  const second = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(second.status, 'degraded');
  assert.equal(second.artifacts[0]?.validation.status, 'invalid');
  assert.equal(second.artifacts[0]?.taskTotal, 0);
});

test('research root ancestor links are rejected without traversing their targets', (t) => {
  const records = fixture(t);
  const outside = path.join(records, 'private', 'position-panels');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'manifest.pilot.json'), '{"marker":"ANCESTOR_PRIVATE_MARKER"}\n', 'utf8');
  fs.symlinkSync(outside, path.join(records, 'position-panels'));
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(result.status, 'degraded');
  assert.equal(result.program.positions.stage, 'invalid');
  assert.deepEqual(result.artifacts, []);
  assert.doesNotMatch(JSON.stringify(result), /ANCESTOR_PRIVATE_MARKER/);
});

test('frozen writer shape enforces calibration-candidate scaffold equality', (t) => {
  const records = fixture(t);
  const pilot = writePilotForFrozen(records);
  writeFrozen(records, pilot);
  const manifestFile = path.join(records, 'position-panels', 'frozen', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as JsonObject;
  const calibration = manifest.upstream_calibration_manifest as JsonObject;
  calibration.evaluator_digest = 'a'.repeat(64);
  writeObject(manifestFile, manifest);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  const frozen = result.artifacts.find((artifact) => artifact.kind === 'frozen');
  assert.equal(frozen?.validation.status, 'invalid');
  assert.equal(frozen?.releaseReady, null);
});

test('frozen lineage must join the actual validated sibling pilot manifest', (t) => {
  const records = fixture(t);
  const pilot = writePilotForFrozen(records);
  writeFrozen(records, pilot);
  pilot.manifest.evaluator_digest = 'a'.repeat(64);
  writeObject(path.join(records, 'position-panels', 'manifest.pilot.json'), pilot.manifest);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  const pilotView = result.artifacts.find((artifact) => artifact.kind === 'pilot');
  const frozenView = result.artifacts.find((artifact) => artifact.kind === 'frozen');
  assert.equal(pilotView?.validation.status, 'valid');
  assert.equal(frozenView?.validation.status, 'invalid');
  assert.equal(frozenView?.releaseReady, null);

  fs.writeFileSync(path.join(records, 'position-panels', 'manifest.pilot.json'), pilot.manifestBytes);
  const frozenManifestFile = path.join(records, 'position-panels', 'frozen', 'manifest.json');
  const frozenManifest = JSON.parse(fs.readFileSync(frozenManifestFile, 'utf8')) as JsonObject;
  (frozenManifest.inputs as JsonObject).scores = 'a'.repeat(64);
  writeObject(frozenManifestFile, frozenManifest);
  const bindingTamper = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(bindingTamper.artifacts.find((artifact) => artifact.kind === 'pilot')?.validation.status, 'valid');
  assert.equal(bindingTamper.artifacts.find((artifact) => artifact.kind === 'frozen')?.validation.status, 'invalid');
});

test('frozen split balance rejects prototype magic stratum names', (t) => {
  const records = fixture(t);
  const pilot = writePilotForFrozen(records);
  writeFrozen(records, pilot);
  const manifestFile = path.join(records, 'position-panels', 'frozen', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as JsonObject;
  const balance = manifest.split_balance as JsonObject;
  balance.strata = JSON.parse('{"__proto__":{"deviation":0,"eval":1,"evalFraction":0.5,"total":2}}') as JsonObject;
  writeObject(manifestFile, manifest);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  assert.equal(result.artifacts.find((artifact) => artifact.kind === 'frozen')?.validation.status, 'invalid');
  assert.equal(Object.hasOwn(Object.prototype, 'deviation'), false);
});

test('frozen previews round-robin across available split and phase buckets', (t) => {
  const records = fixture(t);
  const phases = ['team_preview', 'forced_switch', 'turn'] as const;
  const rows = Array.from({ length: 48 }, (_, index) =>
    task(`balanced-${index}`, 'pilot', index, phases[index % phases.length]),
  );
  const pilot = writePilot(records, rows);
  writeFrozen(records, pilot);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  const frozen = result.artifacts.find((artifact) => artifact.kind === 'frozen');
  assert.equal(frozen?.validation.status, 'valid');
  assert.equal(frozen?.taskTotal, 48);
  assert.equal(frozen?.taskPreviewCount, 24);
  assert.deepEqual(new Set(frozen?.tasks.map((entry) => entry.split)), new Set(['train', 'eval']));
  assert.deepEqual(
    new Set(frozen?.tasks.map((entry) => entry.phase)),
    new Set(['team_preview', 'forced_switch', 'turn']),
  );
});

test('canonical horizon-zero diagnostic pilot is valid but remains unreleased', (t) => {
  const records = fixture(t);
  const pilot = writePilot(records);
  pilot.manifest.counterfactual = { ...COUNTERFACTUAL_PROTOCOL, horizon: 0 };
  writeObject(path.join(records, 'position-panels', 'manifest.pilot.json'), pilot.manifest);
  const result = buildResearchIndex(records, { allowCandidateTasks: true });
  const artifact = result.artifacts[0];
  assert.equal(artifact?.validation.status, 'valid');
  assert.equal(artifact?.releaseReady, false);
  assert.equal(artifact?.protocols?.counterfactual.horizon, 0);
});

test('GUI startup requires HTTPS for every configured non-loopback public origin', () => {
  const deploymentControls = {
    host: '127.0.0.1',
    mutationsEnabled: true,
    importToken: 'deployment-import-token',
    auth: {} as AuthService,
  };
  assert.throws(
    () => new GuiServer({ ...deploymentControls, publicOrigin: 'http://league.example' }),
    /must use HTTPS for non-loopback hosts/,
  );
  assert.doesNotThrow(() => new GuiServer({ ...deploymentControls, publicOrigin: 'http://localhost' }));
  assert.doesNotThrow(() => new GuiServer({ ...deploymentControls, publicOrigin: 'http://127.0.0.1:8080' }));
});

test('hosted research route exposes unreleased candidate tasks only to operators', async (t) => {
  const records = fixture(t);
  writePilot(records);
  const auth = {
    session(token: string | undefined) {
      if (token !== 'contributor' && token !== 'operator') return undefined;
      return {
        user: {
          id: token === 'operator' ? 2 : 1,
          providerSubject: token,
          login: token,
          avatarUrl: '',
          role: token,
        },
        csrfToken: `${token}-csrf`,
        expiresAt: Date.now() + 60_000,
      };
    },
  } as unknown as AuthService;
  const gui = new GuiServer({
    recordsPath: path.join(records, 'results.jsonl'),
    host: '127.0.0.1',
    publicOrigin: 'https://league.example',
    auth,
  });
  await gui.listen(0);
  t.after(() => gui.close());
  const address = gui.server.address();
  assert.ok(address && typeof address === 'object');

  const contributorResult = await serverJson(address.port, 'league.example', 'vgc_session=contributor');
  const contributorPilot = contributorResult.artifacts[0];
  assert.equal(contributorPilot?.validation.status, 'valid');
  assert.equal(contributorPilot?.releaseReady, false);
  assert.equal(contributorPilot?.taskPreviewAvailability, 'withheld');
  assert.equal(contributorPilot?.taskPreviewReason, 'candidate-artifact-not-released-for-hosted-viewers');
  assert.equal(contributorPilot?.taskTotal, 1);
  assert.equal(contributorPilot?.taskPreviewCount, 0);
  assert.deepEqual(contributorPilot?.tasks, []);
  assert.deepEqual(contributorPilot?.releaseGates, []);
  assert.doesNotMatch(JSON.stringify(contributorResult), /Public battlefield only|Thunderbolt|canonicalAction/);

  const operatorResult = await serverJson(address.port, 'league.example', 'vgc_session=operator');
  const operatorPilot = operatorResult.artifacts[0];
  assert.equal(operatorPilot?.taskPreviewAvailability, 'available');
  assert.equal(operatorPilot?.taskTotal, 1);
  assert.equal(operatorPilot?.taskPreviewCount, 1);
  assert.match(operatorPilot?.tasks[0]?.prompt ?? '', /Public battlefield only/);
  assert.equal(operatorPilot?.tasks[0]?.actions[0]?.canonicalAction, 'move 1 1, move 1 1');
});
