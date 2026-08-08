import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COUNTERFACTUAL_PROTOCOL_VERSION,
  EXHAUSTIVE_PANEL_PROTOCOL,
  exhaustivePanelDrawPlan,
  exhaustivePanelMatrixDigest,
  REFERENCE,
} from '../src/eval/counterfactual.js';
import { ACTION_PROTOCOL } from '../src/eval/fork.js';
import {
  exactPublicPositionFingerprint,
  POSITION_SOURCE_GROUP_PROTOCOL,
  positionSourceGroup,
} from '../src/eval/panel-artifact.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL } from '../src/eval/task.js';
import type { JsonObject } from '../src/types.js';
import { minimalPanelBattle } from './fixtures/position-panel.js';

const TOOL = fileURLToPath(new URL('../tools/freeze-position-splits.js', import.meta.url));
const TASK_KEYS = [
  'actions',
  'format',
  'phase',
  'prompt',
  'response_schema',
  'schema_version',
  'split',
  'task_id',
  'turn',
].sort();
const COUNTERFACTUAL_PROTOCOL = {
  version: COUNTERFACTUAL_PROTOCOL_VERSION,
  reference: REFERENCE,
  horizon: 'end',
  luckSamples: 2,
  opponentSamples: 1,
  shortlist: 2,
  screenSamples: 2,
  rolloutLimit: 60,
};

interface Fixture {
  root: string;
  tasks: string;
  scores: string;
  sealed: string;
  calibrationManifest: string;
  manifest: string;
  policy: string;
  publicOut: string;
  privateOut: string;
  splitPolicy: JsonObject;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeObject(file: string, value: unknown): void {
  fs.writeFileSync(file, `${canonicalJson(value)}\n`, 'utf8');
}

function readObject(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
}

function readRows(file: string): JsonObject[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

function panel(taskId: string, id: 'stability-a' | 'stability-b' | 'measurement', ready: boolean): JsonObject {
  const drawPlan = exhaustivePanelDrawPlan({
    panelSeed: `private-panel-root-${taskId}`,
    id,
    opponentLegalActions: ['move 1'],
    opponentSlots: 1,
    luckReplications: 2,
  });
  const actionNames = ['move 1', 'move 2'];
  const matrix = ready
    ? [
        [0, 1],
        [0, 1],
      ]
    : [
        [0, 0],
        [0, 0],
      ];
  const span = matrix[0]![1]! - matrix[0]![0]!;
  return {
    id,
    ...drawPlan,
    actions: actionNames.map((action, index) => ({
      action,
      value: matrix[0]![index],
      standardError: 0,
      samples: drawPlan.draws.length,
      reward: span > 0 ? index : null,
    })),
    matrix,
    matrixDigest: exhaustivePanelMatrixDigest({
      id,
      ...drawPlan,
      actions: actionNames,
      matrix,
    }),
    span,
  };
}

function artifact(
  taskId: string,
  index: number,
  measurementReady: boolean,
  qualificationReady = true,
): {
  task: JsonObject;
  score: JsonObject;
  sealed: JsonObject;
} {
  const position = minimalPanelBattle();
  assert.deepEqual(position.actions.p1, ['move 1', 'move 2']);
  assert.deepEqual(position.actions.p2, ['move 1']);
  const actions = [
    { number: 0, canonical_action: 'move 1', label: 'Protect' },
    { number: 1, canonical_action: 'move 2', label: 'Tailwind' },
  ];
  const visible =
    index === 0 ? 'Alpha terrain favors a careful electric pivot.' : 'Beta rain favors an immediate water attack.';
  const task: JsonObject = {
    schema_version: 3,
    task_id: taskId,
    split: 'pilot',
    format: position.format,
    phase: 'turn',
    turn: 1,
    prompt: [
      'Choose one listed joint action for this controlled Pokemon VGC position.',
      'Select the number for the complete joint action, not one part of it.',
      '',
      visible,
      '',
      'LEGAL JOINT ACTIONS:',
      '0. Protect',
      '1. Tailwind',
      '',
      'Return exactly one JSON object {"choice":N}, where N is a zero-based action number above. Include no other keys or prose.',
    ].join('\n'),
    response_schema: {
      type: 'object',
      required: ['choice'],
      properties: { choice: { type: 'integer', minimum: 0, maximum: 1 } },
      additionalProperties: false,
    },
    actions,
  };
  const stabilityA = panel(taskId, 'stability-a', qualificationReady);
  const stabilityB = panel(taskId, 'stability-b', qualificationReady);
  const measurement = panel(taskId, 'measurement', measurementReady);
  const heldOutSpan = qualificationReady
    ? {
        selectedAction: 'move 2',
        alternativeAction: 'move 1',
        value: 1,
        standardError: 0,
        normalApproxLower95: 1,
      }
    : {
        selectedAction: 'move 1',
        alternativeAction: 'move 2',
        value: 0,
        standardError: 0,
        normalApproxLower95: 0,
      };
  const source: JsonObject = {
    run_id: `private-run-${index}`,
    series_id: `private-series-${index}`,
    game_number: 1,
    position_index: index,
    pid: 'p1',
    scaffold: 'private-scaffold-revision',
    played_by: 'private-model',
    played: 'move 2',
  };
  const table: JsonObject = {
    pid: 'p1',
    turn: 1,
    legal: 2,
    horizon: 'end',
    stateValue: 0,
    selectionBest: qualificationReady ? 'move 2' : 'move 1',
    measurementBest: measurementReady ? 'move 2' : 'move 1',
    rankingStable: true,
    valueSpan: measurementReady ? 1 : 0,
    heldOutGap: heldOutSpan,
    heldOutSpan,
    stability: [stabilityA, stabilityB],
    measurement,
    anchorAgreement: true,
    maxNormalizedRewardDrift: qualificationReady ? 0 : null,
  };
  const score: JsonObject = {
    schema_version: 3,
    task_id: taskId,
    structural_pass: qualificationReady,
    structural_reasons: qualificationReady ? [] : ['zero_qualification_span'],
    measurement_ready: measurementReady,
    diagnostic_flags: [
      ...(!qualificationReady ? ['normal_approx_span_crosses_zero'] : []),
      ...(!measurementReady ? ['measurement_zero_span'] : []),
    ],
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics: {
      version: 2,
      legalActions: 2,
      qualificationDrawsPerPanel: [2, 2],
      qualificationOpponentPopulation: [1, 1],
      qualificationOpponentSlots: [1, 1],
      qualificationLuckReplications: [2, 2],
      heldOutSpanValue: qualificationReady ? 1 : 0,
      heldOutSpanStandardError: 0,
      heldOutSpanNormalApproxLower95: qualificationReady ? 1 : 0,
      bestAnchorAgreement: true,
      extremaSetAgreement: true,
      stabilityRankCorrelation: qualificationReady ? 1 : null,
      maxNormalizedRewardDrift: qualificationReady ? 0 : null,
      maxQualificationNormalizedStandardError: qualificationReady ? 0 : null,
    },
    measurement_panel: {
      id: 'measurement',
      n: 2,
      matrix_digest: measurement.matrixDigest,
    },
    min_value: 0,
    max_value: measurementReady ? 1 : 0,
    span: measurementReady ? 1 : 0,
    actions: actions.map((action, actionIndex) => ({
      number: action.number,
      canonical_action: action.canonical_action,
      mean_value: measurementReady ? actionIndex : 0,
      standard_error: 0,
      n: 2,
      normalized_reward: measurementReady ? actionIndex : null,
    })),
    stability: {
      matrix_digests: [stabilityA.matrixDigest, stabilityB.matrixDigest],
      spans: qualificationReady ? [1, 1] : [0, 0],
      best_anchor_agreement: true,
      extrema_set_agreement: true,
      max_normalized_reward_drift: qualificationReady ? 0 : null,
      held_out_span: heldOutSpan,
    },
  };
  const sealed: JsonObject = {
    schema_version: 3,
    task_id: taskId,
    source_id: `private-source-${index}`,
    source_group: positionSourceGroup(source),
    selection_stratum: 'turn/early/level',
    exact_public_fingerprint: exactPublicPositionFingerprint(task),
    source,
    snapshot: position.snapshot,
    opponent_request: position.requests.p2 as unknown as JsonObject,
    panel_seed: `private-panel-root-${taskId}`,
    table,
  };
  return { task, score, sealed };
}

function makeFixture(options: { unreadyIndex?: number } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-position-splits-'));
  const tasks = path.join(root, 'tasks.jsonl');
  const scores = path.join(root, 'scores.jsonl');
  const sealed = path.join(root, 'sealed.jsonl');
  const calibrationManifest = path.join(root, 'calibration-manifest.json');
  const manifest = path.join(root, 'pilot-manifest.json');
  const policy = path.join(root, 'policy.json');
  const rows = [
    artifact('task-alpha', 0, options.unreadyIndex !== 0),
    artifact('task-beta', 1, options.unreadyIndex !== 1),
    artifact('task-excluded', 2, true, false),
  ];
  fs.writeFileSync(tasks, canonicalJsonl(rows.map((entry) => entry.task)), 'utf8');
  fs.writeFileSync(scores, canonicalJsonl(rows.map((entry) => entry.score)), 'utf8');
  fs.writeFileSync(sealed, canonicalJsonl(rows.map((entry) => entry.sealed)), 'utf8');
  writeObject(calibrationManifest, {
    schema_version: 2,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics_version: 2,
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: 'calibration-source-set-v1',
    evaluator_digest: '7'.repeat(64),
    runtime: { node: 'fixture-node', platform: 'fixture-platform', arch: 'fixture-arch' },
    showdown_commit: '8'.repeat(40),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: COUNTERFACTUAL_PROTOCOL,
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: 'calibration-seed-namespace-v1',
    inputs: { public_set: '2'.repeat(64), private_set: '3'.repeat(64) },
    outputs: {
      tasks: { file: 'tasks.calibration.jsonl', sha256: '4'.repeat(64), rows: 2 },
      scores: { sha256: '5'.repeat(64), rows: 2 },
      sealed_panels: { sha256: '6'.repeat(64), rows: 2 },
    },
    ordered_task_ids: ['calibration-alpha', 'calibration-beta'],
  });
  writeObject(manifest, {
    schema_version: 2,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics_version: 2,
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: 'candidate-source-set-v1',
    evaluator_digest: '7'.repeat(64),
    runtime: { node: 'fixture-node', platform: 'fixture-platform', arch: 'fixture-arch' },
    showdown_commit: '8'.repeat(40),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: COUNTERFACTUAL_PROTOCOL,
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: 'candidate-seed-namespace-v1',
    inputs: { public_set: '9'.repeat(64), private_set: 'a'.repeat(64) },
    outputs: {
      tasks: { file: path.basename(tasks), sha256: sha256(tasks), rows: rows.length },
      scores: { sha256: sha256(scores), rows: rows.length },
      sealed_panels: { sha256: sha256(sealed), rows: rows.length },
    },
    ordered_task_ids: rows.map((entry) => entry.task.task_id),
  });
  const splitPolicy: JsonObject = {
    schema_version: 2,
    status: 'frozen',
    policy_id: 'fixture-split-policy-v1',
    calibration_manifest_sha256: sha256(calibrationManifest),
    seed: 'fixture-split-seed-v1',
    eval_fraction: 0.5,
    near_duplicate_threshold: 1,
    max_eval_fraction_deviation: 1,
    max_stratum_eval_fraction_deviation: 1,
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
  writeObject(policy, splitPolicy);
  return {
    root,
    tasks,
    scores,
    sealed,
    calibrationManifest,
    manifest,
    policy,
    publicOut: path.join(root, 'public'),
    privateOut: path.join(root, 'private'),
    splitPolicy,
  };
}

function args(fixture: Fixture, publicOut = fixture.publicOut, privateOut = fixture.privateOut): string[] {
  return [
    '--tasks',
    fixture.tasks,
    '--scores',
    fixture.scores,
    '--sealed',
    fixture.sealed,
    '--manifest',
    fixture.manifest,
    '--calibration-manifest',
    fixture.calibrationManifest,
    '--policy',
    fixture.policy,
    '--out',
    publicOut,
    '--private-out',
    privateOut,
  ];
}

function run(argv: string[]) {
  return spawnSync(process.execPath, [TOOL, ...argv], { encoding: 'utf8' });
}

function succeeds(result: ReturnType<typeof run>): void {
  assert.equal(
    result.status,
    0,
    `freezer failed\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`,
  );
  assert.equal(result.signal, null);
}

function fails(result: ReturnType<typeof run>, message: RegExp): void {
  assert.notEqual(result.status, 0, `freezer unexpectedly succeeded\nstdout:\n${String(result.stdout)}`);
  assert.match(String(result.stderr), message);
}

function tree(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[path.relative(directory, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  visit(directory);
  return result;
}

function dispose(...fixtures: Fixture[]): void {
  for (const fixture of fixtures) fs.rmSync(fixture.root, { recursive: true, force: true });
}

function rebindPilotOutput(fixture: Fixture, key: 'tasks' | 'scores' | 'sealed_panels', file: string): void {
  const manifest = readObject(fixture.manifest);
  const outputs = manifest.outputs as JsonObject;
  const artifact = outputs[key] as JsonObject;
  artifact.sha256 = sha256(file);
  writeObject(fixture.manifest, manifest);
}

test('the CLI freezes deterministic immutable output and refuses a non-identical overwrite', () => {
  const first = makeFixture();
  const second = makeFixture();
  try {
    succeeds(run(args(first)));
    const firstPublic = tree(first.publicOut);
    const firstPrivate = tree(first.privateOut);
    succeeds(run(args(first)));
    assert.deepEqual(tree(first.publicOut), firstPublic);
    assert.deepEqual(tree(first.privateOut), firstPrivate);

    succeeds(run(args(second)));
    assert.deepEqual(tree(second.publicOut), firstPublic);
    assert.deepEqual(tree(second.privateOut), firstPrivate);

    fs.appendFileSync(path.join(first.publicOut, 'manifest.json'), ' ', 'utf8');
    fails(run(args(first)), /refusing to overwrite immutable artifact .*manifest\.json/);
  } finally {
    dispose(first, second);
  }
});

test('byte-identical crash-like partial artifact sets resume to deterministic complete output', () => {
  const complete = makeFixture();
  const oneArtifact = makeFixture();
  const severalArtifacts = makeFixture();
  try {
    succeeds(run(args(complete)));
    const expectedPublic = tree(complete.publicOut);
    const expectedPrivate = tree(complete.privateOut);
    const cases: Array<{
      fixture: Fixture;
      artifacts: Array<{ root: 'public' | 'private'; file: string }>;
    }> = [
      {
        fixture: oneArtifact,
        artifacts: [{ root: 'public', file: 'tasks.train.jsonl' }],
      },
      {
        fixture: severalArtifacts,
        artifacts: [
          { root: 'public', file: 'tasks.eval.jsonl' },
          { root: 'private', file: 'scores.train.jsonl' },
          { root: 'private', file: 'sealed-panels.eval.jsonl' },
          { root: 'private', file: 'split-assignments.jsonl' },
        ],
      },
    ];
    for (const entry of cases) {
      fs.mkdirSync(entry.fixture.publicOut, { recursive: true });
      fs.mkdirSync(entry.fixture.privateOut, { recursive: true });
      for (const artifact of entry.artifacts) {
        const sourceRoot = artifact.root === 'public' ? complete.publicOut : complete.privateOut;
        const targetRoot = artifact.root === 'public' ? entry.fixture.publicOut : entry.fixture.privateOut;
        fs.copyFileSync(path.join(sourceRoot, artifact.file), path.join(targetRoot, artifact.file));
      }
      assert.equal(fs.existsSync(path.join(entry.fixture.publicOut, 'manifest.json')), false);
      succeeds(run(args(entry.fixture)));
      assert.deepEqual(tree(entry.fixture.publicOut), expectedPublic);
      assert.deepEqual(tree(entry.fixture.privateOut), expectedPrivate);
    }
  } finally {
    dispose(complete, oneArtifact, severalArtifacts);
  }
});

test('a differing crash-like partial artifact refuses rather than mixing output generations', () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(fixture.publicOut, { recursive: true });
    fs.mkdirSync(fixture.privateOut, { recursive: true });
    const partial = path.join(fixture.publicOut, 'tasks.train.jsonl');
    const bytes = canonicalJsonl([{ schema_version: 2, task_id: 'different-generation' }]);
    fs.writeFileSync(partial, bytes, 'utf8');
    fails(run(args(fixture)), /refusing to overwrite immutable artifact .*tasks\.train\.jsonl/);
    assert.equal(fs.readFileSync(partial, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(fixture.publicOut, 'manifest.json')), false);
  } finally {
    dispose(fixture);
  }
});

test('a static symlink alias between output roots is refused where symlinks are available', (context) => {
  const fixture = makeFixture();
  try {
    const realRoot = path.join(fixture.root, 'aliased-output');
    const linkedRoot = path.join(fixture.root, 'linked-output');
    fs.mkdirSync(realRoot);
    try {
      fs.symlinkSync(realRoot, linkedRoot, 'dir');
    } catch (error) {
      if (['EACCES', 'ENOSYS', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) {
        context.skip('directory symlinks are unavailable');
        return;
      }
      throw error;
    }
    fails(run(args(fixture, linkedRoot, realRoot)), /output root.*(?:symlink|alias|overlap)/i);
  } finally {
    dispose(fixture);
  }
});

test('a preexisting symlink artifact leaf is refused where symlinks are available', (context) => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(fixture.publicOut, { recursive: true });
    fs.mkdirSync(fixture.privateOut, { recursive: true });
    const target = path.join(fixture.root, 'symlink-target');
    fs.writeFileSync(target, 'target', 'utf8');
    try {
      fs.symlinkSync(target, path.join(fixture.publicOut, 'tasks.train.jsonl'));
    } catch (error) {
      if (['EACCES', 'ENOSYS', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) {
        context.skip('file symlinks are unavailable');
        return;
      }
      throw error;
    }
    fails(run(args(fixture)), /immutable artifact.*(?:non-symlink|symlink)/i);
  } finally {
    dispose(fixture);
  }
});

test('a preexisting hard-linked artifact leaf is refused where hard links are available', (context) => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(fixture.publicOut, { recursive: true });
    fs.mkdirSync(fixture.privateOut, { recursive: true });
    const target = path.join(fixture.root, 'hard-link-target');
    fs.writeFileSync(target, 'target', 'utf8');
    try {
      fs.linkSync(target, path.join(fixture.publicOut, 'tasks.train.jsonl'));
    } catch (error) {
      if (['EACCES', 'EMLINK', 'ENOSYS', 'EPERM', 'EXDEV'].includes(String((error as NodeJS.ErrnoException).code))) {
        context.skip('hard links are unavailable');
        return;
      }
      throw error;
    }
    fails(run(args(fixture)), /immutable artifact.*hard-link alias/i);
  } finally {
    dispose(fixture);
  }
});

test('all structured inputs reject non-canonical bytes', () => {
  const cases: Array<{
    field: keyof Pick<Fixture, 'tasks' | 'scores' | 'sealed' | 'calibrationManifest' | 'manifest' | 'policy'>;
    binding?: 'tasks' | 'scores' | 'sealed_panels';
  }> = [
    { field: 'tasks', binding: 'tasks' },
    { field: 'scores', binding: 'scores' },
    { field: 'sealed', binding: 'sealed_panels' },
    { field: 'calibrationManifest' },
    { field: 'manifest' },
    { field: 'policy' },
  ];
  for (const entry of cases) {
    const fixture = makeFixture();
    try {
      fs.appendFileSync(fixture[entry.field], '\n', 'utf8');
      if (entry.binding) rebindPilotOutput(fixture, entry.binding, fixture[entry.field]);
      if (entry.field === 'calibrationManifest') {
        const policy = readObject(fixture.policy);
        policy.calibration_manifest_sha256 = sha256(fixture.calibrationManifest);
        writeObject(fixture.policy, policy);
      }
      fails(run(args(fixture)), /canonical JSON/i);
    } finally {
      dispose(fixture);
    }
  }
});

test('candidate and calibration manifest digest tampering and calibration reuse are rejected', () => {
  const candidateTampered = makeFixture();
  const calibrationTampered = makeFixture();
  const reused = makeFixture();
  try {
    const manifest = readObject(candidateTampered.manifest);
    const outputs = manifest.outputs as JsonObject;
    (outputs.tasks as JsonObject).sha256 = '0'.repeat(64);
    writeObject(candidateTampered.manifest, manifest);
    fails(run(args(candidateTampered)), /candidate pilot manifest does not bind .*file hashes/);

    const calibration = readObject(calibrationTampered.calibrationManifest);
    calibration.source_set_id = 'tampered-calibration-source-set';
    writeObject(calibrationTampered.calibrationManifest, calibration);
    fails(run(args(calibrationTampered)), /calibration.*(?:digest|SHA-256|manifest)/i);

    reused.calibrationManifest = reused.manifest;
    const policy = readObject(reused.policy);
    policy.calibration_manifest_sha256 = sha256(reused.manifest);
    writeObject(reused.policy, policy);
    fails(run(args(reused)), /calibration.*(?:candidate|differ|overlap|separate)/i);
  } finally {
    dispose(candidateTampered, calibrationTampered, reused);
  }
});

test('public and private output roots cannot equal or contain one another', () => {
  const fixture = makeFixture();
  try {
    const shared = path.join(fixture.root, 'shared');
    fails(run(args(fixture, shared, shared)), /public and private output roots must not overlap/);
    fails(run(args(fixture, shared, path.join(shared, 'private'))), /public and private output roots must not overlap/);
    fails(run(args(fixture, path.join(shared, 'public'), shared)), /public and private output roots must not overlap/);
  } finally {
    dispose(fixture);
  }
});

test('unknown flags, missing flag values, and required inputs fail closed', () => {
  const fixture = makeFixture();
  const omit = (flag: string): string[] => {
    const argv = args(fixture);
    const index = argv.indexOf(flag);
    return [...argv.slice(0, index), ...argv.slice(index + 2)];
  };
  try {
    fails(run(['--unknown', 'value']), /unknown flag --unknown/);
    fails(run(['--policy']), /--policy requires a path/);
    fails(run(omit('--policy')), /--policy <frozen-policy\.json> is required/);
    fails(run(omit('--calibration-manifest')), /--calibration-manifest .*required/i);
  } finally {
    dispose(fixture);
  }
});

test('an eligible position with an unusable measurement panel fails the complete freeze', () => {
  const fixture = makeFixture({ unreadyIndex: 0 });
  try {
    fails(run(args(fixture)), /admitted 1 positions with unusable measurement panels/);
    assert.equal(fs.existsSync(fixture.publicOut), false);
    assert.equal(fs.existsSync(fixture.privateOut), false);
  } finally {
    dispose(fixture);
  }
});

test('outputs preserve provenance while keeping public tasks separate from scores and sealed material', () => {
  const fixture = makeFixture();
  try {
    succeeds(run(args(fixture)));
    assert.deepEqual(fs.readdirSync(fixture.publicOut).sort(), [
      'manifest.json',
      'tasks.eval.jsonl',
      'tasks.train.jsonl',
    ]);
    assert.deepEqual(fs.readdirSync(fixture.privateOut).sort(), [
      'exclusions.jsonl',
      'near-duplicate-pairs.jsonl',
      'scores.eval.jsonl',
      'scores.train.jsonl',
      'sealed-panels.eval.jsonl',
      'sealed-panels.train.jsonl',
      'split-assignments.jsonl',
    ]);

    const publicRows = [
      ...readRows(path.join(fixture.publicOut, 'tasks.train.jsonl')),
      ...readRows(path.join(fixture.publicOut, 'tasks.eval.jsonl')),
    ];
    assert.equal(publicRows.length, 2);
    assert.deepEqual(publicRows.map((row) => row.task_id).sort(), ['task-alpha', 'task-beta']);
    for (const row of publicRows) {
      assert.deepEqual(Object.keys(row).sort(), TASK_KEYS);
      assert.ok(row.split === 'train' || row.split === 'eval');
    }
    const publicBytes = Object.values(tree(fixture.publicOut)).join('\n');
    assert.doesNotMatch(publicBytes, /private-(?:run|series|source|model|panel|continuation|scaffold)/);
    assert.equal(fs.existsSync(path.join(fixture.publicOut, 'scores.train.jsonl')), false);
    assert.equal(fs.existsSync(path.join(fixture.publicOut, 'sealed-panels.train.jsonl')), false);
    assert.equal(fs.existsSync(path.join(fixture.privateOut, 'tasks.train.jsonl')), false);
    assert.equal(fs.existsSync(path.join(fixture.privateOut, 'manifest.json')), false);

    const privateScores = [
      ...readRows(path.join(fixture.privateOut, 'scores.train.jsonl')),
      ...readRows(path.join(fixture.privateOut, 'scores.eval.jsonl')),
    ];
    for (const row of privateScores) {
      assert.equal(row.eligibility_status, 'eligible-under-frozen-policy');
      assert.equal('source' in row, false);
      assert.equal('snapshot' in row, false);
      assert.equal('table' in row, false);
    }
    assert.deepEqual(readRows(path.join(fixture.privateOut, 'exclusions.jsonl')), [
      {
        schema_version: 2,
        task_id: 'task-excluded',
        reasons: [
          'zero_qualification_span',
          'held_out_span_below_threshold',
          'rank_stability_below_threshold',
          'normalized_reward_drift_above_threshold',
          'qualification_uncertainty_above_threshold',
        ],
      },
    ]);
    const sealedRows = [
      ...readRows(path.join(fixture.privateOut, 'sealed-panels.train.jsonl')),
      ...readRows(path.join(fixture.privateOut, 'sealed-panels.eval.jsonl')),
    ];
    assert.ok(sealedRows.every((row) => String(row.snapshot).includes('"formatid":"gen9customgame"')));
    assert.ok(sealedRows.every((row) => row.opponent_request && typeof row.opponent_request === 'object'));
    const sealedBytes = sealedRows.map((row) => canonicalJson(row)).join('\n');
    assert.match(sealedBytes, /private-panel-root-.*:continuation:/);

    const manifest = readObject(path.join(fixture.publicOut, 'manifest.json'));
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.release_ready, false);
    assert.equal(manifest.status, 'candidate-splits-frozen-not-release-approved');
    assert.deepEqual(manifest.remaining_release_gates, [
      'horizon-sensitivity',
      'hidden-information-treatment',
      'criterion-validation',
      'calibration-candidate-semantic-near-duplicate-separation-audit',
      'package-smoke-tests',
    ]);
    assert.deepEqual(manifest.calibration_candidate_separation, {
      exact_checks: [
        'manifest-sha256-non-identical',
        'source-set-id-non-identical',
        'whole-input-digest-tuple-non-identical',
        'ordered-task-id-sets-non-overlapping',
      ],
      semantic_near_duplicate_separation: 'not-auditable-from-pilot-manifests-release-gate-required',
    });
    assert.deepEqual(manifest.exclusion_row_protocol, {
      version: 2,
      rowSchemaVersion: 2,
      keys: ['reasons', 'schema_version', 'task_id'],
      taskId: 'nonempty-trimmed-string',
      reasons: 'nonempty-array-of-nonempty-trimmed-strings-preserve-order',
    });
    assert.match(String(manifest.splitter_digest), /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.runtime, { node: process.version, platform: process.platform, arch: process.arch });
    assert.deepEqual(manifest.policy, fixture.splitPolicy);
    assert.equal(manifest.policy_canonical_digest, canonicalJsonDigest(fixture.splitPolicy));
    assert.equal((manifest.policy as JsonObject).calibration_manifest_sha256, sha256(fixture.calibrationManifest));
    assert.deepEqual(manifest.upstream_pilot_manifest, {
      sha256: sha256(fixture.manifest),
      source_set_id: 'candidate-source-set-v1',
      evaluator_digest: '7'.repeat(64),
      runtime: { node: 'fixture-node', platform: 'fixture-platform', arch: 'fixture-arch' },
      showdown_commit: '8'.repeat(40),
      action_protocol: ACTION_PROTOCOL,
      task_protocol: POSITION_TASK_PROTOCOL,
      counterfactual: COUNTERFACTUAL_PROTOCOL,
      exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
      source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
      seed_namespace: 'candidate-seed-namespace-v1',
    });
    assert.deepEqual(manifest.upstream_calibration_manifest, {
      sha256: sha256(fixture.calibrationManifest),
      source_set_id: 'calibration-source-set-v1',
      evaluator_digest: '7'.repeat(64),
      runtime: { node: 'fixture-node', platform: 'fixture-platform', arch: 'fixture-arch' },
      showdown_commit: '8'.repeat(40),
      action_protocol: ACTION_PROTOCOL,
      task_protocol: POSITION_TASK_PROTOCOL,
      counterfactual: COUNTERFACTUAL_PROTOCOL,
      exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
      source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
      seed_namespace: 'calibration-seed-namespace-v1',
    });
    assert.deepEqual(manifest.inputs, {
      tasks: sha256(fixture.tasks),
      scores: sha256(fixture.scores),
      sealed: sha256(fixture.sealed),
      pilot_manifest: sha256(fixture.manifest),
      calibration_manifest: sha256(fixture.calibrationManifest),
      policy_file: sha256(fixture.policy),
    });
    assert.deepEqual(manifest.counts, {
      input: 3,
      eligible: 2,
      excluded: 1,
      train: 1,
      eval: 1,
      source_groups: 2,
      duplicate_clusters: 2,
      near_duplicate_pairs: 0,
    });
    assert.equal(
      fs.readFileSync(path.join(fixture.publicOut, 'manifest.json'), 'utf8'),
      `${canonicalJson(manifest)}\n`,
    );

    const outputs = manifest.outputs as JsonObject;
    const expectedArtifacts: Array<[string, string]> = [
      ['tasks_train', path.join(fixture.publicOut, 'tasks.train.jsonl')],
      ['tasks_eval', path.join(fixture.publicOut, 'tasks.eval.jsonl')],
      ['scores_train', path.join(fixture.privateOut, 'scores.train.jsonl')],
      ['scores_eval', path.join(fixture.privateOut, 'scores.eval.jsonl')],
      ['sealed_train', path.join(fixture.privateOut, 'sealed-panels.train.jsonl')],
      ['sealed_eval', path.join(fixture.privateOut, 'sealed-panels.eval.jsonl')],
      ['assignments', path.join(fixture.privateOut, 'split-assignments.jsonl')],
      ['near_duplicate_pairs', path.join(fixture.privateOut, 'near-duplicate-pairs.jsonl')],
      ['exclusions', path.join(fixture.privateOut, 'exclusions.jsonl')],
    ];
    for (const [key, file] of expectedArtifacts) {
      assert.deepEqual(outputs[key], { sha256: sha256(file), rows: readRows(file).length });
    }
  } finally {
    dispose(fixture);
  }
});
