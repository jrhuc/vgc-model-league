import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { counterfactualProtocol, EXHAUSTIVE_PANEL_PROTOCOL } from '../src/eval/counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION } from '../src/eval/eligibility.js';
import { ACTION_PROTOCOL } from '../src/eval/fork.js';
import { POSITION_PANEL_ARTIFACT_SCHEMA_VERSION, type PublicPositionTask } from '../src/eval/panel-artifact.js';
import {
  CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
  CANDIDATE_POSITION_SELECTION_RULES,
} from '../src/eval/position-artifact-manifest.js';
import { readPublicPositionCandidateRoot } from '../src/eval/public-position-artifact.js';
import { CANONICAL_JSON_PROTOCOL, canonicalJson } from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL } from '../src/eval/task.js';

const TASK_A = 'a'.repeat(64);
const TASK_B = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);

function task(taskId = TASK_A): PublicPositionTask {
  const actions = [
    { number: 0, canonical_action: 'move 1', label: 'Protect' },
    { number: 1, canonical_action: 'move 2', label: 'Tailwind' },
  ];
  return {
    schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
    task_id: taskId,
    format: 'gen9championsvgc2026regmb',
    phase: 'turn',
    turn: 1,
    prompt: [
      'Choose one listed joint action for this controlled Pokemon VGC position.',
      'Select the number for the complete joint action, not one part of it.',
      '',
      'Turn 1 visible state',
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
}

function jsonl(rows: readonly unknown[]): Buffer {
  return Buffer.from(`${rows.map(canonicalJson).join('\n')}\n`, 'utf8');
}

function manifest(rows: readonly PublicPositionTask[], tasksBytes: Buffer): Record<string, unknown> {
  return {
    schema_version: CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
    evaluator_digest: DIGEST,
    runtime: { node: 'v24', platform: 'darwin', arch: 'arm64' },
    showdown_commit: 'd'.repeat(40),
    seed_namespace: 'candidate-panels',
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: counterfactualProtocol(),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    eligibility_metrics_version: POSITION_ELIGIBILITY_METRICS_VERSION,
    inputs: { graded: DIGEST, graded_manifest: DIGEST },
    selection: {
      count: rows.length,
      seed: 'position-set',
      per_game: 3,
      formats: ['gen9championsvgc2026regmb'],
      rules: CANDIDATE_POSITION_SELECTION_RULES,
    },
    outputs: {
      tasks: {
        file: 'tasks.jsonl',
        sha256: createHash('sha256').update(tasksBytes).digest('hex'),
        rows: rows.length,
      },
      scores: { sha256: DIGEST, rows: rows.length },
      sealed_panels: { sha256: DIGEST, rows: rows.length },
    },
    ordered_task_ids: rows.map((row) => row.task_id),
  };
}

interface Fixture {
  workspace: string;
  root: string;
  rows: PublicPositionTask[];
  manifest: Record<string, unknown>;
  tasksBytes: Buffer;
}

function fixture(rows: PublicPositionTask[] = [task()], tasksBytes = jsonl(rows)): Fixture {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'public-position-artifact-'));
  const root = path.join(workspace, 'public');
  fs.mkdirSync(root);
  const value = manifest(rows, tasksBytes);
  fs.writeFileSync(path.join(root, 'manifest.json'), `${canonicalJson(value)}\n`);
  fs.writeFileSync(path.join(root, 'tasks.jsonl'), tasksBytes);
  return { workspace, root, rows, manifest: value, tasksBytes };
}

function cleanup(value: Fixture): void {
  fs.rmSync(value.workspace, { recursive: true, force: true });
}

function writeManifest(value: Fixture, manifestValue = value.manifest): void {
  fs.writeFileSync(path.join(value.root, 'manifest.json'), `${canonicalJson(manifestValue)}\n`);
}

function bindTaskBytes(value: Fixture, bytes: Buffer): void {
  fs.writeFileSync(path.join(value.root, 'tasks.jsonl'), bytes);
  const outputs = value.manifest.outputs as { tasks: { sha256: string } };
  outputs.tasks.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeManifest(value);
}

test('public candidate reader returns only the validated ordered public rows', () => {
  const value = fixture();
  try {
    const rows = readPublicPositionCandidateRoot(value.root);
    assert.deepEqual(rows, value.rows);
    assert.equal('generating_models' in rows[0]!, false);
    assert.deepEqual(Object.keys(rows[0]!).sort(), [
      'actions',
      'format',
      'phase',
      'prompt',
      'response_schema',
      'schema_version',
      'task_id',
      'turn',
    ]);
  } finally {
    cleanup(value);
  }
});

test('manifest parsing is fatal, canonical, duplicate-free, and current-protocol only', () => {
  const attacks: Array<{ name: string; mutate(value: Fixture): void; error: RegExp }> = [
    {
      name: 'whitespace',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'manifest.json'), ` ${canonicalJson(value.manifest)}\n`);
      },
      error: /canonical JSON line/u,
    },
    {
      name: 'protocol',
      mutate(value) {
        value.manifest.action_protocol = { version: 999 };
        writeManifest(value);
      },
      error: /action_protocol is not the current protocol/u,
    },
    {
      name: 'malformed JSON',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'manifest.json'), '{');
      },
      error: /malformed JSON/u,
    },
    {
      name: 'duplicate key',
      mutate(value) {
        const raw = canonicalJson(value.manifest);
        fs.writeFileSync(
          path.join(value.root, 'manifest.json'),
          `{"action_protocol":${canonicalJson(value.manifest.action_protocol)},${raw.slice(1)}\n`,
        );
      },
      error: /canonical JSON line/u,
    },
    {
      name: 'missing newline',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'manifest.json'), canonicalJson(value.manifest));
      },
      error: /canonical JSON line/u,
    },
    {
      name: 'fatal UTF-8',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'manifest.json'), Buffer.from([0xff]));
      },
      error: /not valid UTF-8/u,
    },
    {
      name: 'spelling drift',
      mutate(value) {
        value.manifest.taskProtocol = value.manifest.task_protocol;
        delete value.manifest.task_protocol;
        writeManifest(value);
      },
      error: /malformed/u,
    },
  ];
  for (const attack of attacks) {
    const value = fixture();
    try {
      attack.mutate(value);
      assert.throws(() => readPublicPositionCandidateRoot(value.root), attack.error, attack.name);
    } finally {
      cleanup(value);
    }
  }
});

test('tasks binding and JSONL parsing reject digest, byte, line, and public-schema attacks', () => {
  const invalidSchema = { ...task(), extra: true };
  const attacks: Array<{
    name: string;
    bytes(value: Fixture): Buffer;
    bind: boolean;
    error: RegExp;
  }> = [
    {
      name: 'digest mismatch',
      bytes: (value) => Buffer.concat([value.tasksBytes, Buffer.from(' ')]),
      bind: false,
      error: /SHA-256/u,
    },
    {
      name: 'noncanonical row',
      bytes: () => Buffer.from(`${JSON.stringify(task())}\n`),
      bind: true,
      error: /not canonical/u,
    },
    { name: 'fatal UTF-8', bytes: () => Buffer.from([0xff, 0x0a]), bind: true, error: /not valid UTF-8/u },
    {
      name: 'CRLF',
      bytes: (value) => Buffer.concat([value.tasksBytes.subarray(0, -1), Buffer.from('\r\n')]),
      bind: true,
      error: /LF line endings/u,
    },
    {
      name: 'blank row',
      bytes: (value) => Buffer.concat([value.tasksBytes, Buffer.from('\n')]),
      bind: true,
      error: /is blank/u,
    },
    {
      name: 'missing newline',
      bytes: (value) => value.tasksBytes.subarray(0, -1),
      bind: true,
      error: /end with a newline/u,
    },
    { name: 'empty file', bytes: () => Buffer.alloc(0), bind: true, error: /nonempty/u },
    { name: 'malformed JSON', bytes: () => Buffer.from('{]\n'), bind: true, error: /malformed JSON/u },
    { name: 'schema failure', bytes: () => jsonl([invalidSchema]), bind: true, error: /keys differ/u },
  ];
  for (const attack of attacks) {
    const value = fixture();
    try {
      const bytes = attack.bytes(value);
      if (attack.bind) bindTaskBytes(value, bytes);
      else fs.writeFileSync(path.join(value.root, 'tasks.jsonl'), bytes);
      assert.throws(() => readPublicPositionCandidateRoot(value.root), attack.error, attack.name);
    } finally {
      cleanup(value);
    }
  }
});

test('task row count and exact ordered id sequence reject omissions, reordering, and duplicate ids', () => {
  const attacks: Array<{ name: string; prepare(): Fixture; error: RegExp }> = [
    {
      name: 'omitted row',
      prepare() {
        const value = fixture();
        const selection = value.manifest.selection as { count: number };
        const outputs = value.manifest.outputs as {
          tasks: { rows: number };
          scores: { rows: number };
          sealed_panels: { rows: number };
        };
        selection.count = 2;
        outputs.tasks.rows = 2;
        outputs.scores.rows = 2;
        outputs.sealed_panels.rows = 2;
        value.manifest.ordered_task_ids = [TASK_A, TASK_B];
        writeManifest(value);
        return value;
      },
      error: /row count/u,
    },
    {
      name: 'reordered rows',
      prepare() {
        const rows = [task(TASK_A), task(TASK_B)];
        return fixture(rows, jsonl([...rows].reverse()));
      },
      error: /task_id sequence/u,
    },
    {
      name: 'duplicate task ids',
      prepare() {
        const rows = [task(TASK_A), task(TASK_B)];
        return fixture(rows, jsonl([rows[0], rows[0]]));
      },
      error: /task_id sequence/u,
    },
  ];
  for (const attack of attacks) {
    const value = attack.prepare();
    try {
      assert.throws(() => readPublicPositionCandidateRoot(value.root), attack.error, attack.name);
    } finally {
      cleanup(value);
    }
  }
});

test('manifest task filename is fixed and cannot select an alternate or escaping path', () => {
  for (const file of ['alternate.jsonl', '../tasks.jsonl', '/tmp/tasks.jsonl']) {
    const value = fixture();
    try {
      const outputs = value.manifest.outputs as { tasks: { file: string } };
      outputs.tasks.file = file;
      writeManifest(value);
      assert.throws(() => readPublicPositionCandidateRoot(value.root), /must be exactly tasks\.jsonl/u, file);
    } finally {
      cleanup(value);
    }
  }
});

test('candidate root and direct members must be physical directory and regular files', () => {
  const missingWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'public-position-missing-'));
  try {
    assert.throws(() => readPublicPositionCandidateRoot(path.join(missingWorkspace, 'missing')));
    const fileRoot = path.join(missingWorkspace, 'file');
    fs.writeFileSync(fileRoot, 'not a root');
    assert.throws(() => readPublicPositionCandidateRoot(fileRoot), /non-symlink directory/u);
  } finally {
    fs.rmSync(missingWorkspace, { recursive: true, force: true });
  }

  const rootLinkFixture = fixture();
  try {
    const link = path.join(rootLinkFixture.workspace, 'root-link');
    fs.symlinkSync(rootLinkFixture.root, link, 'dir');
    assert.throws(() => readPublicPositionCandidateRoot(link), /non-symlink directory/u);
  } finally {
    cleanup(rootLinkFixture);
  }

  for (const name of ['manifest.json', 'tasks.jsonl']) {
    const value = fixture();
    try {
      const member = path.join(value.root, name);
      const target = path.join(value.workspace, `${name}.target`);
      fs.renameSync(member, target);
      fs.symlinkSync(target, member, 'file');
      assert.throws(() => readPublicPositionCandidateRoot(value.root), /regular non-symlink file/u, name);
    } finally {
      cleanup(value);
    }
  }
});

test('exact direct membership rejects private-only, mixed, extra, and nested layouts', () => {
  const layouts: Array<{ name: string; mutate(value: Fixture): void }> = [
    {
      name: 'private-only',
      mutate(value) {
        fs.rmSync(value.root, { recursive: true });
        fs.mkdirSync(value.root);
        fs.writeFileSync(path.join(value.root, 'scores.jsonl'), '{}\n');
        fs.writeFileSync(path.join(value.root, 'sealed-panels.jsonl'), '{}\n');
      },
    },
    {
      name: 'mixed public and private',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'scores.jsonl'), '{}\n');
      },
    },
    {
      name: 'extra file',
      mutate(value) {
        fs.writeFileSync(path.join(value.root, 'notes.txt'), 'extra');
      },
    },
    {
      name: 'nested tasks',
      mutate(value) {
        fs.rmSync(path.join(value.root, 'tasks.jsonl'));
        fs.mkdirSync(path.join(value.root, 'nested'));
        fs.writeFileSync(path.join(value.root, 'nested', 'tasks.jsonl'), value.tasksBytes);
      },
    },
    {
      name: 'directory named as task file',
      mutate(value) {
        fs.rmSync(path.join(value.root, 'tasks.jsonl'));
        fs.mkdirSync(path.join(value.root, 'tasks.jsonl'));
        fs.writeFileSync(path.join(value.root, 'tasks.jsonl', 'row.json'), '{}\n');
      },
    },
  ];
  for (const layout of layouts) {
    const value = fixture();
    try {
      layout.mutate(value);
      assert.throws(() => readPublicPositionCandidateRoot(value.root), layout.name);
    } finally {
      cleanup(value);
    }
  }
});
