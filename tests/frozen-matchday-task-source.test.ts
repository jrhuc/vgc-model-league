import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL,
  FROZEN_MATCHDAY_EPISODE_ID_PLACEHOLDER,
  FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
  FROZEN_MATCHDAY_TASK_SOURCE_FILES,
  FROZEN_MATCHDAY_TASK_SOURCE_INPUT_SCHEMA_VERSION,
  FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
  FROZEN_MATCHDAY_TASK_SOURCE_MANIFEST_SCHEMA_VERSION,
  FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
  FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY,
  FROZEN_MATCHDAY_TASK_SOURCE_STATUS,
  FROZEN_REFEREE_REQUEST_LINE_BYTES,
  freezeFrozenMatchdayTaskSource,
  frozenMatchdayStartRequestLine,
} from '../src/eval/frozen-matchday-task-source.js';
import {
  assertPinnedShowdownRuntime,
  PRODUCER_DIGEST_PROTOCOL,
  runtimeProducerAuthority,
  showdownRuntimeAuthorityFiles,
} from '../src/eval/producer.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION } from '../src/frozen-battle-referee.js';
import {
  FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
  type FrozenMatchdayProtocolResponse,
  FrozenMatchdayProtocolSession,
} from '../src/frozen-matchday-protocol.js';
import {
  FROZEN_MATCHDAY_FORMAT,
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  FrozenMatchdayReferee,
  type FrozenMatchdayRefereeOptions,
} from '../src/frozen-matchday-referee.js';
import { SHOWDOWN_LOCK } from '../src/showdown.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

const TOOL = path.resolve('dist/tools/freeze-frozen-matchday-task-source.js');

interface Fixture {
  root: string;
  input: string;
  out: string;
}

interface SourceCase {
  case_id: string;
  condition_id: string;
  options: FrozenMatchdayRefereeOptions;
  provenance: { source: string; seed_source: string };
}

interface ManifestCaseView extends Record<string, unknown> {
  idx: unknown;
  provenance_digest: unknown;
  construction_tasks: Array<{ pid: unknown; task_id: unknown; provenance_digest: unknown }>;
}

interface ManifestView extends Record<string, unknown> {
  schema_version: unknown;
  status: unknown;
  release_ready: unknown;
  canonical_json: unknown;
  condition_digest_protocol: unknown;
  source_id: unknown;
  authority: Record<string, unknown>;
  publication: Record<string, unknown>;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  producer: Record<string, unknown> & { digest: string; showdown_runtime_digest: string };
  conditions: Array<Record<string, unknown>>;
  ordered_cases: ManifestCaseView[];
}

function sourceCase(caseId: string, conditionId: string, options = frozenMatchdayOptions()): SourceCase {
  return {
    case_id: caseId,
    condition_id: conditionId,
    options,
    provenance: { source: `private-${caseId}`, seed_source: `seed-ledger-${caseId}` },
  };
}

function sourceObject(
  conditions: unknown[] = [{ condition_id: 'baseline', definition: { opponent_policy: 'fixed' } }],
  cases: unknown[] = [sourceCase('case-one', 'baseline')],
): Record<string, unknown> {
  return {
    schema_version: FROZEN_MATCHDAY_TASK_SOURCE_INPUT_SCHEMA_VERSION,
    source_id: 'private-matchday-pilot',
    conditions,
    cases,
  };
}

function fixture(value: unknown = sourceObject()): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-matchday-task-source-'));
  fs.chmodSync(root, 0o700);
  const input = path.join(root, 'source.json');
  fs.writeFileSync(
    input,
    `${canonicalJson(value)}
`,
    { mode: 0o600 },
  );
  fs.chmodSync(input, 0o600);
  return { root, input, out: path.join(root, 'frozen') };
}

function alternateReviewedRuntime(): { root: string; psDir: string } {
  const repository = path.resolve('.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alternate-reviewed-showdown-'));
  for (const relative of showdownRuntimeAuthorityFiles(repository)) {
    const source = path.join(repository, relative);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { root, psDir: path.join(root, 'pokemon-showdown') };
}

function pathWithFakeGit(root: string, revision: string): string {
  const directory = path.join(root, 'fake-bin');
  fs.mkdirSync(directory);
  const git = path.join(directory, 'git');
  fs.writeFileSync(
    git,
    `#!/bin/sh
printf '%s\n' ${JSON.stringify(revision)}
`,
    'utf8',
  );
  fs.chmodSync(git, 0o755);
  return `${directory}${path.delimiter}${process.env.PATH ?? ''}`;
}

function run(current: Fixture, extra: string[] = [], env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TOOL, '--input', current.input, '--out', current.out, ...extra], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function succeeds(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function fails(result: ReturnType<typeof spawnSync>, pattern: RegExp): void {
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function rows(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function digest(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function protocolResult<T>(response: FrozenMatchdayProtocolResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as T;
}

function mutableObject(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  return value as unknown[];
}

function firstCase(value: Record<string, unknown>): Record<string, unknown> {
  return mutableObject(mutableArray(value.cases)[0]);
}

function firstOptions(value: Record<string, unknown>): Record<string, unknown> {
  return mutableObject(firstCase(value).options);
}

function firstInputConstruction(value: Record<string, unknown>): Record<string, unknown> {
  const seat = mutableObject(mutableArray(firstOptions(value).seats)[0]);
  return mutableObject(seat.construction);
}

function firstInputConstructionTask(value: Record<string, unknown>): Record<string, unknown> {
  return mutableObject(mutableObject(firstInputConstruction(value).artifact).task);
}

function construction(options: FrozenMatchdayRefereeOptions, index = 0): Record<string, unknown> {
  return mutableObject(options.seats[index]!.construction);
}

function constructionTask(options: FrozenMatchdayRefereeOptions, index = 0): Record<string, unknown> {
  return mutableObject(mutableObject(construction(options, index).artifact).task);
}

function constructionProvenance(options: FrozenMatchdayRefereeOptions, index = 0): Record<string, unknown> {
  return mutableObject(constructionTask(options, index).provenance);
}

function startRow(options: FrozenMatchdayRefereeOptions): Record<string, unknown> {
  const referee = new FrozenMatchdayReferee(options);
  return {
    condition_digest: 'd'.repeat(64),
    showdown_revision: referee.showdownRevision,
    options,
  };
}

function optionsAtStartRequestBytes(target: number): FrozenMatchdayRefereeOptions {
  const options = frozenMatchdayOptions();
  constructionTask(options).provenance = { source: '' };
  const base = frozenMatchdayStartRequestLine(startRow(options)).length - 1;
  const additional = target - base;
  if (additional < 1) throw new Error(`target ${target} is below the fixture envelope overhead ${base}`);
  const provenance = constructionProvenance(options);
  provenance.source = `${'é'.repeat(Math.floor(additional / 2))}${additional % 2 ? 'a' : ''}`;
  assert.equal(frozenMatchdayStartRequestLine(startRow(options)).length - 1, target);
  return options;
}

test('CLI freezes canonical ordered nine-key task rows and an exact sealed manifest schema', () => {
  const options = frozenMatchdayOptions();
  const current = fixture(
    sourceObject(
      [
        { condition_id: 'control', definition: { opponent_policy: 'fixed', prompting: 'control' } },
        { condition_id: 'treatment', definition: { opponent_policy: 'fixed', prompting: 'treatment' } },
      ],
      [sourceCase('case-z', 'treatment', options), sourceCase('case-a', 'control', options)],
    ),
  );
  const completed = run(current);
  succeeds(completed);
  const result = JSON.parse(String(completed.stdout)) as Record<string, unknown>;
  assert.equal(
    FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
    'trusted-single-producer-repository-build-runtime-tree-immutable-from-process-start-through-publication',
  );
  assert.equal(
    FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
    'loaded-js-module-bytes-not-independently-attested',
  );
  assert.equal(
    FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
    'authority-snapshot-detects-mutations-only-after-capture',
  );
  assert.equal(result.publicationPrecondition, FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION);
  assert.equal(result.runtimeBytePortability, FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY);
  assert.equal(result.loadedJsModuleByteAttestation, FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION);
  assert.equal(result.authoritySnapshotScope, FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE);

  assert.deepEqual(fs.readdirSync(current.out).sort(), [...FROZEN_MATCHDAY_TASK_SOURCE_FILES].sort());
  assert.equal(fs.statSync(current.out).mode & 0o7777, 0o700);
  for (const name of FROZEN_MATCHDAY_TASK_SOURCE_FILES) {
    const stat = fs.lstatSync(path.join(current.out, name));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o7777, 0o600);
  }

  const taskFile = path.join(current.out, 'task-source.jsonl');
  const taskBytes = fs.readFileSync(taskFile);
  const taskRows = rows(taskFile);
  assert.equal(taskBytes.toString('utf8'), canonicalJsonl(taskRows));
  assert.deepEqual(
    taskRows.map((row) => row.case_id),
    ['case-z', 'case-a'],
  );
  for (const row of taskRows) {
    assert.deepEqual(Object.keys(row).sort(), [
      'battle_protocol_version',
      'case_id',
      'condition_digest',
      'expected_config_digest',
      'format',
      'jsonl_protocol_version',
      'matchday_protocol_version',
      'options',
      'showdown_revision',
    ]);
    assert.equal(row.format, FROZEN_MATCHDAY_FORMAT);
    assert.equal(row.jsonl_protocol_version, FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION);
    assert.equal(row.matchday_protocol_version, FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION);
    assert.equal(row.battle_protocol_version, FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION);
    assert.equal(row.showdown_revision, SHOWDOWN_LOCK.commit);
    assert.deepEqual(row.options, new FrozenMatchdayReferee(options).snapshot().options);
    assert.ok(frozenMatchdayStartRequestLine(row).length <= FROZEN_REFEREE_REQUEST_LINE_BYTES + 1);
  }
  assert.equal(taskRows[0]?.expected_config_digest, taskRows[1]?.expected_config_digest);
  assert.notEqual(taskRows[0]?.condition_digest, taskRows[1]?.condition_digest);

  const manifestFile = path.join(current.out, 'manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ManifestView;
  assert.equal(manifestBytes.toString('utf8'), `${canonicalJson(manifest)}\n`);
  assert.deepEqual(Object.keys(manifest).sort(), [
    'authority',
    'canonical_json',
    'condition_digest_protocol',
    'conditions',
    'input',
    'ordered_cases',
    'output',
    'producer',
    'publication',
    'release_ready',
    'schema_version',
    'source_id',
    'status',
  ]);
  assert.equal(manifest.schema_version, FROZEN_MATCHDAY_TASK_SOURCE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.status, FROZEN_MATCHDAY_TASK_SOURCE_STATUS);
  assert.equal(manifest.release_ready, false);
  assert.deepEqual(manifest.canonical_json, CANONICAL_JSON_PROTOCOL);
  assert.equal(manifest.condition_digest_protocol, FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL);
  assert.equal(manifest.source_id, 'private-matchday-pilot');
  assert.deepEqual(Object.keys(manifest.authority).sort(), [
    'battle_protocol_version',
    'config_digest',
    'format',
    'implementation',
    'jsonl_protocol_version',
    'matchday_protocol_version',
    'referee',
    'request_line_bytes',
    'showdown_revision',
    'validated_options',
  ]);
  assert.equal(manifest.authority.request_line_bytes, FROZEN_REFEREE_REQUEST_LINE_BYTES);
  assert.equal(manifest.authority.showdown_revision, SHOWDOWN_LOCK.commit);
  assert.deepEqual(manifest.publication, {
    authority_snapshot_scope: FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
    loaded_js_module_byte_attestation: FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
    portable_atomic_directory_noreplace: false,
    precondition: FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
  });
  assert.deepEqual(manifest.input, {
    bytes: fs.statSync(current.input).size,
    sha256: digest(fs.readFileSync(current.input)),
  });
  assert.deepEqual(Object.keys(manifest.output).sort(), ['bytes', 'file', 'rows', 'sha256']);
  assert.equal(manifest.output.file, 'task-source.jsonl');
  assert.equal(manifest.output.sha256, digest(taskBytes));
  assert.equal(manifest.output.bytes, taskBytes.length);
  assert.equal(manifest.output.rows, 2);
  assert.deepEqual(Object.keys(manifest.producer).sort(), [
    'byte_portability',
    'digest',
    'digest_protocol',
    'runtime',
    'showdown_runtime_digest',
  ]);
  const producer = runtimeProducerAuthority(pathToFileURL(TOOL).href);
  assert.equal(manifest.producer.digest_protocol, PRODUCER_DIGEST_PROTOCOL);
  assert.equal(manifest.producer.digest, producer.producerDigest);
  assert.equal(manifest.producer.showdown_runtime_digest, producer.showdownRuntimeDigest);
  assert.equal(manifest.producer.byte_portability, FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY);
  assert.match(manifest.producer.digest, /^[0-9a-f]{64}$/u);
  assert.match(manifest.producer.showdown_runtime_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(manifest.producer.runtime, {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  assert.deepEqual(
    manifest.conditions.map((condition) => Object.keys(condition).sort()),
    [
      ['condition_digest', 'condition_id', 'definition'],
      ['condition_digest', 'condition_id', 'definition'],
    ],
  );
  assert.deepEqual(
    manifest.conditions.map((condition) => condition.condition_digest),
    [
      canonicalJsonDigest({
        protocol: FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL,
        condition: {
          condition_id: 'control',
          definition: { opponent_policy: 'fixed', prompting: 'control' },
        },
      }),
      canonicalJsonDigest({
        protocol: FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL,
        condition: {
          condition_id: 'treatment',
          definition: { opponent_policy: 'fixed', prompting: 'treatment' },
        },
      }),
    ],
  );
  assert.deepEqual(
    manifest.ordered_cases.map((entry) => entry.idx),
    [0, 1],
  );
  for (const ordered of manifest.ordered_cases) {
    assert.deepEqual(Object.keys(ordered).sort(), [
      'case_id',
      'condition_digest',
      'condition_id',
      'construction_tasks',
      'expected_config_digest',
      'idx',
      'provenance_digest',
    ]);
  }
  const firstManifestCase = manifest.ordered_cases[0];
  assert.ok(firstManifestCase);
  assert.equal(
    firstManifestCase.provenance_digest,
    canonicalJsonDigest({ source: 'private-case-z', seed_source: 'seed-ledger-case-z' }),
  );
  assert.deepEqual(
    firstManifestCase.construction_tasks.map((entry) => Object.keys(entry).sort()),
    [
      ['pid', 'provenance_digest', 'task_id'],
      ['pid', 'provenance_digest', 'task_id'],
    ],
  );
  assert.deepEqual(
    firstManifestCase.construction_tasks.map((entry) => entry.pid),
    ['p1', 'p2'],
  );
  assert.deepEqual(
    firstManifestCase.construction_tasks.map((entry) => entry.task_id),
    ['alpha-construction', 'beta-construction'],
  );
  assert.deepEqual(
    firstManifestCase.construction_tasks.map((entry) => entry.provenance_digest),
    [canonicalJsonDigest({ source: 'frozen-matchday-test' }), canonicalJsonDigest({ source: 'frozen-matchday-test' })],
  );
  const manifestText = manifestBytes.toString('utf8');
  assert.doesNotMatch(manifestText, /gameSeeds|initial notebook|"options":\{|"construction":/u);
});

test('manifest stores only canonical provenance digests and cannot disclose secret markers or game seeds', () => {
  const secret = 'SECRET-MARKER-private-game-seed-65535';
  const options = frozenMatchdayOptions();
  constructionTask(options).provenance = {
    source: 'private-construction-ledger',
    seed: 65535,
    secret,
  };
  const item = sourceCase('case-secret', 'baseline', options);
  item.provenance = { source: secret, seed_source: `ledger-${secret}` };
  const current = fixture(sourceObject(undefined, [item]));
  succeeds(run(current));
  const manifestText = fs.readFileSync(path.join(current.out, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as ManifestView;
  assert.doesNotMatch(manifestText, /SECRET-MARKER|gameSeeds|65535/u);
  assert.equal(
    manifest.ordered_cases[0]?.provenance_digest,
    canonicalJsonDigest({ source: secret, seed_source: `ledger-${secret}` }),
  );
  assert.equal(
    manifest.ordered_cases[0]?.construction_tasks[0]?.provenance_digest,
    canonicalJsonDigest({ source: 'private-construction-ledger', seed: 65535, secret }),
  );
});

test('an emitted row starts the real protocol with the frozen config binding', () => {
  const current = fixture();
  succeeds(run(current));
  const row = rows(path.join(current.out, 'task-source.jsonl'))[0] as Record<string, unknown>;
  const session = new FrozenMatchdayProtocolSession();
  const response = session.handle({
    protocolVersion: row.jsonl_protocol_version,
    id: 1,
    method: 'start',
    params: {
      episodeId: 'frozen-task-row-start',
      conditionDigest: row.condition_digest,
      showdownRevision: row.showdown_revision,
      options: row.options,
    },
  });
  const started = protocolResult<{ binding: Record<string, unknown>; value: { started: boolean } }>(response);
  assert.equal(started.value.started, true);
  assert.equal(started.binding.conditionDigest, row.condition_digest);
  assert.equal(started.binding.configDigest, row.expected_config_digest);
});

test('exact compact Python start bytes accept the multibyte limit, reject N+1, and start the compiled referee', (context) => {
  const options = optionsAtStartRequestBytes(FROZEN_REFEREE_REQUEST_LINE_BYTES);
  const current = fixture(sourceObject(undefined, [sourceCase('case-limit', 'baseline', options)]));
  succeeds(run(current));
  const taskFile = path.join(current.out, 'task-source.jsonl');
  const row = rows(taskFile)[0]!;
  const requestFile = path.join(current.root, 'start-request.jsonl');
  const requestLine = frozenMatchdayStartRequestLine(row, FROZEN_MATCHDAY_EPISODE_ID_PLACEHOLDER);
  assert.equal(requestLine.length, FROZEN_REFEREE_REQUEST_LINE_BYTES + 1);
  fs.writeFileSync(requestFile, requestLine, { mode: 0o600 });

  const python = path.resolve('environments/vgc_frozen_matchday_v0/.venv/bin/python');
  const compiledReferee = path.resolve('dist-matchday/tools/frozen-matchday-referee.js');
  if (!fs.existsSync(python) || !fs.existsSync(compiledReferee)) {
    context.skip('compiled referee/Python smoke inputs are absent');
    return;
  }
  const script = String.raw`
import json
import subprocess
import sys

node, referee, task_file, request_file, expected_limit = sys.argv[1:]
with open(task_file, "r", encoding="utf-8") as handle:
    row = json.loads(handle.readline())
request = {
    "protocolVersion": row["jsonl_protocol_version"],
    "id": 1,
    "method": "start",
    "params": {
        "episodeId": "0" * 32,
        "conditionDigest": row["condition_digest"],
        "showdownRevision": row["showdown_revision"],
        "options": row["options"],
    },
}
payload = json.dumps(request, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
assert len(payload) == int(expected_limit)
with open(request_file, "rb") as handle:
    assert payload + b"\n" == handle.read()
process = subprocess.Popen(
    [node, referee],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
assert process.stdin is not None and process.stdout is not None
ready = json.loads(process.stdout.readline())
assert ready["kind"] == "ready"
process.stdin.write(payload + b"\n")
process.stdin.flush()
response = json.loads(process.stdout.readline())
assert response["id"] == 1 and response["ok"] is True
assert response["result"]["value"]["started"] is True
process.terminate()
assert process.wait(timeout=10) is not None
`;
  const smoke = spawnSync(
    python,
    ['-c', script, process.execPath, compiledReferee, taskFile, requestFile, String(FROZEN_REFEREE_REQUEST_LINE_BYTES)],
    { cwd: path.resolve('.'), encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);

  const tooLargeOptions = structuredClone(options);
  const source = constructionProvenance(tooLargeOptions).source;
  assert.equal(typeof source, 'string');
  constructionProvenance(tooLargeOptions).source = `${source}a`;
  const tooLarge = fixture(sourceObject(undefined, [sourceCase('case-too-large', 'baseline', tooLargeOptions)]));
  fails(run(tooLarge), /start request line exceeds 33554432 encoded bytes \(33554433\)/u);
  assert.equal(fs.existsSync(tooLarge.out), false);
});

test('a 33 MiB construction provenance value is rejected before publication', () => {
  const options = frozenMatchdayOptions();
  constructionTask(options).provenance = { source: 's'.repeat(33 * 1024 * 1024) };
  const current = fixture(sourceObject(undefined, [sourceCase('case-provenance-bound', 'baseline', options)]));
  fails(run(current), /construction task provenance exceeds 33554432 canonical bytes/u);
  assert.equal(fs.existsSync(current.out), false);
});

test('a byte-identical complete rerun is a no-op', () => {
  const current = fixture();
  succeeds(run(current));
  const before = Object.fromEntries(
    ['manifest.json', 'task-source.jsonl'].map((name) => {
      const file = path.join(current.out, name);
      const stat = fs.statSync(file);
      return [name, { bytes: fs.readFileSync(file), ino: stat.ino, mtimeMs: stat.mtimeMs }];
    }),
  );
  succeeds(run(current));
  for (const name of ['manifest.json', 'task-source.jsonl']) {
    const file = path.join(current.out, name);
    const stat = fs.statSync(file);
    const prior = before[name] as { bytes: Buffer; ino: number; mtimeMs: number };
    assert.equal(stat.ino, prior.ino);
    assert.equal(stat.mtimeMs, prior.mtimeMs);
    assert.deepEqual(fs.readFileSync(file), prior.bytes);
  }
});

test('canonical object framing, UTF-8, duplicate keys, and finite JSON fail closed', () => {
  const values: Array<{ text: Buffer | string; pattern: RegExp }> = [
    { text: `${JSON.stringify(sourceObject(), null, 2)}\n`, pattern: /canonical JSON object/u },
    { text: `${canonicalJson(sourceObject())}\n\n`, pattern: /canonical JSON object/u },
    {
      text: '{"cases":[],"conditions":[],"schema_version":1,"schema_version":1,"source_id":"pilot"}\n',
      pattern: /canonical JSON object/u,
    },
    {
      text: '{"cases":[],"conditions":[],"schema_version":1,"source_id":"pilot","x":1e400}\n',
      pattern: /non-finite|canonical/u,
    },
    { text: Buffer.from([0xff, 0x0a]), pattern: /UTF-8/u },
  ];
  for (const [index, entry] of values.entries()) {
    const current = fixture();
    fs.writeFileSync(current.input, entry.text);
    fs.chmodSync(current.input, 0o600);
    fails(run(current), entry.pattern);
    assert.equal(fs.existsSync(current.out), false, `case ${index}`);
  }
});

test('exact source, condition, case, provenance, option, and seat structures fail closed', () => {
  const mutations: Array<{ mutate(value: Record<string, unknown>): void; pattern: RegExp }> = [
    { mutate: (value) => (value.extra = true), pattern: /unexpected or missing keys/u },
    { mutate: (value) => (value.schema_version = 2), pattern: /schema_version/u },
    { mutate: (value) => (value.source_id = 'Not-Lowercase'), pattern: /lowercase slug/u },
    { mutate: (value) => (value.source_id = 'a'.repeat(129)), pattern: /bounded trimmed/u },
    { mutate: (value) => (value.conditions = []), pattern: /conditions must contain/u },
    { mutate: (value) => (value.cases = []), pattern: /cases must contain/u },
    {
      mutate: (value) => (mutableObject(mutableArray(value.conditions)[0]).extra = true),
      pattern: /unexpected or missing keys/u,
    },
    { mutate: (value) => (firstCase(value).case_id = 'bad_case'), pattern: /lowercase slug/u },
    {
      mutate: (value) => delete mutableObject(firstCase(value).provenance).seed_source,
      pattern: /unexpected or missing keys/u,
    },
    {
      mutate: (value) => (mutableObject(firstCase(value).provenance).source = ' padded '),
      pattern: /bounded trimmed/u,
    },
    { mutate: (value) => (firstOptions(value).extra = true), pattern: /unexpected or missing keys/u },
    { mutate: (value) => (firstOptions(value).gameSeeds = {}), pattern: /gameSeeds must be an array/u },
    {
      mutate: (value) => mutableArray(firstOptions(value).seats).reverse(),
      pattern: /seats must contain p1 then p2/u,
    },
    {
      mutate: (value) => (mutableObject(mutableArray(firstOptions(value).seats)[0]).extra = true),
      pattern: /unexpected or missing keys/u,
    },
    {
      mutate: (value) => (firstInputConstruction(value).ignored_secret_root = 'must-not-pass'),
      pattern: /construction has unexpected or missing keys/u,
    },
    {
      mutate: (value) => (firstInputConstructionTask(value).id = ' padded-task-id '),
      pattern: /construction task id must be a bounded trimmed nonempty string/u,
    },
    {
      mutate: (value) => (firstInputConstructionTask(value).id = 't'.repeat(129)),
      pattern: /construction task id must be a bounded trimmed nonempty string/u,
    },
    {
      mutate: (value) => (firstInputConstructionTask(value).provenance = []),
      pattern: /construction task provenance must be an object/u,
    },
    {
      mutate: (value) => (firstInputConstructionTask(value).provenance = null),
      pattern: /construction task provenance must be an object/u,
    },
  ];
  for (const [index, entry] of mutations.entries()) {
    const value = sourceObject();
    entry.mutate(value);
    const current = fixture(value);
    fails(run(current), entry.pattern);
    assert.equal(fs.existsSync(current.out), false, `case ${index}`);
  }
});

test('condition and case uniqueness, use, reference, semantics, and binding uniqueness fail closed', () => {
  const options = frozenMatchdayOptions();
  const duplicateCondition = fixture(
    sourceObject(
      [
        { condition_id: 'baseline', definition: { policy: 'a' } },
        { condition_id: 'baseline', definition: { policy: 'b' } },
      ],
      [sourceCase('case-one', 'baseline', options)],
    ),
  );
  fails(run(duplicateCondition), /duplicate condition_id/u);

  const duplicateDefinition = fixture(
    sourceObject(
      [
        { condition_id: 'first', definition: { policy: 'same' } },
        { condition_id: 'second', definition: { policy: 'same' } },
      ],
      [sourceCase('case-one', 'first', options), sourceCase('case-two', 'second', options)],
    ),
  );
  fails(run(duplicateDefinition), /semantically duplicates/u);

  const duplicateCase = fixture(
    sourceObject(undefined, [sourceCase('case-one', 'baseline', options), sourceCase('case-one', 'baseline', options)]),
  );
  fails(run(duplicateCase), /duplicate case_id/u);

  const unknown = fixture(sourceObject(undefined, [sourceCase('case-one', 'unknown', options)]));
  fails(run(unknown), /unknown condition_id/u);

  const unused = fixture(
    sourceObject(
      [
        { condition_id: 'used', definition: { policy: 'used' } },
        { condition_id: 'unused', definition: { policy: 'unused' } },
      ],
      [sourceCase('case-one', 'used', options)],
    ),
  );
  fails(run(unused), /unused conditions: unused/u);

  const duplicateBinding = fixture(
    sourceObject(undefined, [sourceCase('case-one', 'baseline', options), sourceCase('case-two', 'baseline', options)]),
  );
  fails(run(duplicateBinding), /duplicates a condition_digest and expected_config_digest binding/u);
});

test('the FrozenMatchdayReferee rejects mutated construction authority', () => {
  const options = frozenMatchdayOptions();
  const construction = options.seats[0]?.construction;
  assert.ok(construction && construction.status === 'accepted');
  construction.artifact.task.constraint.candidates[0]!.id = 'forged-candidate';
  const current = fixture(sourceObject(undefined, [sourceCase('case-one', 'baseline', options)]));
  fails(run(current), /construction does not reproduce through the strict referee/u);
  assert.equal(fs.existsSync(current.out), false);
});

test('private input mode, symlink, and hard-link aliases fail closed', (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX private modes and links are unavailable');
    return;
  }
  const mode = fixture();
  fs.chmodSync(mode.input, 0o644);
  fails(run(mode), /mode 0600/u);

  const symlink = fixture();
  const symlinkTarget = path.join(symlink.root, 'target.json');
  fs.renameSync(symlink.input, symlinkTarget);
  try {
    fs.symlinkSync(symlinkTarget, symlink.input);
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('file symlinks are unavailable');
      return;
    }
    throw error;
  }
  fails(run(symlink), /regular non-symlink/u);

  const hardlink = fixture();
  fs.linkSync(hardlink.input, path.join(hardlink.root, 'input-alias.json'));
  fails(run(hardlink), /hard-link aliases/u);
});

test('symlink and containment output roots fail closed', (context) => {
  const symlink = fixture();
  const target = path.join(symlink.root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    fs.symlinkSync(target, symlink.out, 'dir');
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('directory symlinks are unavailable');
      return;
    }
    throw error;
  }
  fails(run(symlink), /non-symlink directory/u);

  const contained = fixture();
  fs.mkdirSync(contained.out, { mode: 0o700 });
  const movedInput = path.join(contained.out, 'source.json');
  fs.renameSync(contained.input, movedInput);
  contained.input = movedInput;
  fails(run(contained), /must not contain or alias/u);
});

test('partial, extra, different, wrong-mode, symlink, and hard-linked output sets are never repaired', (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX private modes and links are unavailable');
    return;
  }
  const rootMode = fixture();
  fs.mkdirSync(rootMode.out, { mode: 0o755 });
  fs.chmodSync(rootMode.out, 0o755);
  fails(run(rootMode), /mode 0700/u);

  const partial = fixture();
  fs.mkdirSync(partial.out, { mode: 0o700 });
  fs.writeFileSync(path.join(partial.out, 'task-source.jsonl'), '', { mode: 0o600 });
  fails(run(partial), /partial or contains unexpected entries/u);
  assert.deepEqual(fs.readdirSync(partial.out), ['task-source.jsonl']);

  const extra = fixture();
  succeeds(run(extra));
  fs.writeFileSync(path.join(extra.out, 'extra'), 'private', { mode: 0o600 });
  fails(run(extra), /partial or contains unexpected entries/u);
  assert.equal(fs.existsSync(path.join(extra.out, 'extra')), true);

  const different = fixture();
  succeeds(run(different));
  fs.writeFileSync(path.join(different.out, 'task-source.jsonl'), '{}\n');
  fs.chmodSync(path.join(different.out, 'task-source.jsonl'), 0o600);
  fails(run(different), /non-identical frozen output rerun/u);
  assert.equal(fs.readFileSync(path.join(different.out, 'task-source.jsonl'), 'utf8'), '{}\n');

  const wrongMode = fixture();
  succeeds(run(wrongMode));
  fs.chmodSync(path.join(wrongMode.out, 'manifest.json'), 0o644);
  fails(run(wrongMode), /mode 0600/u);

  const symlink = fixture();
  succeeds(run(symlink));
  const manifestFile = path.join(symlink.out, 'manifest.json');
  const manifestTarget = path.join(symlink.root, 'manifest-target');
  fs.renameSync(manifestFile, manifestTarget);
  fs.symlinkSync(manifestTarget, manifestFile);
  fails(run(symlink), /regular non-symlink/u);

  const hardlink = fixture();
  succeeds(run(hardlink));
  fs.linkSync(path.join(hardlink.out, 'manifest.json'), path.join(hardlink.root, 'manifest-alias'));
  fails(run(hardlink), /hard-link aliases/u);
});

test('exact private modes reject special bits on inputs, roots, and files', (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX special mode bits are unavailable');
    return;
  }
  const input = fixture();
  fs.chmodSync(input.input, 0o4600);
  fails(run(input), /mode 0600/u);

  const root = fixture();
  succeeds(run(root));
  fs.chmodSync(root.out, 0o1700);
  fails(run(root), /mode 0700/u);

  const file = fixture();
  succeeds(run(file));
  fs.chmodSync(path.join(file.out, 'manifest.json'), 0o4600);
  fails(run(file), /mode 0600/u);
});

test('createStage removes private stages when chmod or lstat setup fails', () => {
  const mutableFs = fs as unknown as {
    chmodSync: typeof fs.chmodSync;
    lstatSync: typeof fs.lstatSync;
  };
  for (const operation of ['chmod', 'lstat'] as const) {
    const current = fixture();
    const originalChmod = fs.chmodSync;
    const originalLstat = fs.lstatSync;
    try {
      if (operation === 'chmod') {
        mutableFs.chmodSync = ((file: fs.PathLike, mode: fs.Mode) => {
          if (String(file).endsWith('.stage')) throw new Error('simulated stage chmod failure');
          return originalChmod(file, mode);
        }) as typeof fs.chmodSync;
      } else {
        let failed = false;
        mutableFs.lstatSync = ((file: fs.PathLike, options?: unknown) => {
          if (String(file).endsWith('.stage') && !failed) {
            failed = true;
            throw new Error('simulated stage lstat failure');
          }
          return originalLstat(file, options as never);
        }) as typeof fs.lstatSync;
      }
      assert.throws(
        () => freezeFrozenMatchdayTaskSource(current.input, current.out, pathToFileURL(TOOL).href),
        new RegExp(`simulated stage ${operation} failure`, 'u'),
      );
    } finally {
      mutableFs.chmodSync = originalChmod;
      mutableFs.lstatSync = originalLstat;
    }
    assert.equal(fs.existsSync(current.out), false);
    assert.equal(
      fs.readdirSync(current.root).some((name) => name.endsWith('.stage')),
      false,
    );
  }
});

test('ordinary rename EEXIST never overwrites the root and preserves stage cleanup', () => {
  const current = fixture();
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (String(oldPath).endsWith('.stage')) {
        fs.mkdirSync(newPath, { mode: 0o700 });
        const error = new Error('simulated ordinary EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;
    assert.throws(
      () => freezeFrozenMatchdayTaskSource(current.input, current.out, pathToFileURL(TOOL).href),
      new RegExp(`${FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION}.*simulated ordinary EEXIST`, 'u'),
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readdirSync(current.out), []);
  assert.equal(
    fs.readdirSync(current.root).some((name) => name.endsWith('.stage')),
    false,
  );
});

test('post-referee authority membership recheck rejects derivation across a changed file set', () => {
  const current = fixture();
  const originalSnapshot = FrozenMatchdayReferee.prototype.snapshot;
  const originalReaddir = fs.readdirSync;
  let attack = false;
  try {
    FrozenMatchdayReferee.prototype.snapshot = function () {
      const snapshot = originalSnapshot.call(this);
      attack = true;
      return snapshot;
    };
    fs.readdirSync = ((directory: fs.PathLike, options?: unknown) => {
      const entries = originalReaddir(directory, options as never);
      if (attack && Array.isArray(entries)) return [];
      return entries;
    }) as typeof fs.readdirSync;
    assert.throws(
      () => freezeFrozenMatchdayTaskSource(current.input, current.out, pathToFileURL(TOOL).href),
      /membership changed after its stable snapshot/u,
    );
  } finally {
    FrozenMatchdayReferee.prototype.snapshot = originalSnapshot;
    fs.readdirSync = originalReaddir;
  }
  assert.equal(fs.existsSync(current.out), false);
});

test('post-referee VGC runtime realpath recheck rejects a changed authority binding', () => {
  const current = fixture();
  const alternate = fs.mkdtempSync(path.join(os.tmpdir(), 'post-referee-vgc-runtime-'));
  const originalSnapshot = FrozenMatchdayReferee.prototype.snapshot;
  const previous = process.env.VGC_LEAGUE_PS;
  try {
    delete process.env.VGC_LEAGUE_PS;
    FrozenMatchdayReferee.prototype.snapshot = function () {
      const snapshot = originalSnapshot.call(this);
      process.env.VGC_LEAGUE_PS = alternate;
      return snapshot;
    };
    assert.throws(
      () => freezeFrozenMatchdayTaskSource(current.input, current.out, pathToFileURL(TOOL).href),
      /reviewed runtime path or digest binding changed|physical identity changed/u,
    );
  } finally {
    FrozenMatchdayReferee.prototype.snapshot = originalSnapshot;
    if (previous === undefined) delete process.env.VGC_LEAGUE_PS;
    else process.env.VGC_LEAGUE_PS = previous;
  }
  assert.equal(fs.existsSync(current.out), false);
});

test('freezer rejects clean and tampered alternate VGC_LEAGUE_PS roots without a false manifest', () => {
  const clean = alternateReviewedRuntime();
  assert.match(assertPinnedShowdownRuntime(clean.root), /^[0-9a-f]{64}$/u);
  const cleanFixture = fixture();
  fails(
    run(cleanFixture, [], { VGC_LEAGUE_PS: clean.psDir }),
    /exact physical bundled reviewed Pokémon Showdown runtime/u,
  );
  assert.equal(fs.existsSync(cleanFixture.out), false);

  const tampered = alternateReviewedRuntime();
  fs.appendFileSync(path.join(tampered.psDir, 'dist', 'sim', 'index.js'), '\n/* alternate tamper */\n');
  assert.throws(() => assertPinnedShowdownRuntime(tampered.root), /does not match reviewed/u);
  const tamperedFixture = fixture();
  fails(
    run(tamperedFixture, [], { VGC_LEAGUE_PS: tampered.psDir }),
    /exact physical bundled reviewed Pokémon Showdown runtime/u,
  );
  assert.equal(fs.existsSync(tamperedFixture.out), false);
});

test('physical pinned alias ignores fake PATH git, emits the lock, and rejects forged construction SHAs', (context) => {
  const current = fixture();
  const link = path.join(current.root, 'bundled-showdown-link');
  try {
    fs.symlinkSync(path.resolve('pokemon-showdown'), link, 'dir');
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('directory symlinks are unavailable');
      return;
    }
    throw error;
  }
  const forgedRevision = 'f'.repeat(40);
  const environment = {
    PATH: pathWithFakeGit(current.root, forgedRevision),
    VGC_LEAGUE_PS: path.relative(path.resolve('.'), link),
  };
  succeeds(run(current, [], environment));
  const emitted = rows(path.join(current.out, 'task-source.jsonl'))[0]!;
  assert.equal(emitted.showdown_revision, SHOWDOWN_LOCK.commit);
  assert.notEqual(emitted.showdown_revision, forgedRevision);
  const manifest = JSON.parse(fs.readFileSync(path.join(current.out, 'manifest.json'), 'utf8')) as ManifestView;
  assert.equal(manifest.authority.showdown_revision, SHOWDOWN_LOCK.commit);
  const referee = new FrozenMatchdayReferee(emitted.options as unknown as FrozenMatchdayRefereeOptions);
  assert.equal(referee.showdownRevision, SHOWDOWN_LOCK.commit);
  assert.equal(referee.snapshot().revision, 0);

  const forgedOptions = frozenMatchdayOptions();
  for (const seat of forgedOptions.seats) {
    mutableObject(mutableObject(seat.construction).artifact).showdownCommit = forgedRevision;
  }
  const forged = fixture(
    sourceObject(
      [{ condition_id: 'baseline', definition: { opponent_policy: 'fixed' } }],
      [sourceCase('forged-case', 'baseline', forgedOptions)],
    ),
  );
  fails(run(forged, [], environment), /construction artifact is not strict and valid/u);
  assert.equal(fs.existsSync(forged.out), false);
});

test('tool help states the exact authority scope and portable publication precondition', () => {
  const help = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
  succeeds(help);
  assert.match(help.stdout, new RegExp(FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION, 'u'));
  assert.match(help.stdout, new RegExp(FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION, 'u'));
  assert.match(help.stdout, new RegExp(FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE, 'u'));
  assert.match(help.stdout, /repository, build, and runtime tree immutable from process start through\s+publication/u);
  assert.match(help.stdout, /Loaded JS module bytes are not independently attested/u);
  assert.match(help.stdout, /authority snapshot detects mutations only\s+after capture/u);
  assert.doesNotMatch(help.stdout, /Ordinary concurrent authority\/build changes fail/u);
  assert.match(help.stdout, /no portable atomic directory NOREPLACE/u);
  assert.match(help.stdout, /never knowingly overwritten/u);
  assert.match(help.stdout, /supported POSIX\/LF build/u);
  assert.match(help.stdout, /not newline-normalized/u);
  assert.match(help.stdout, /not claimed to have equal digests across platforms/u);
});

test('CLI flags and required private paths fail closed', () => {
  const current = fixture();
  fails(spawnSync(process.execPath, [TOOL, '--unknown', current.input], { encoding: 'utf8' }), /unknown flag/u);
  fails(spawnSync(process.execPath, [TOOL, '--input', current.input], { encoding: 'utf8' }), /--out/u);
  fails(spawnSync(process.execPath, [TOOL, '--out', current.out], { encoding: 'utf8' }), /--input/u);
  fails(
    spawnSync(process.execPath, [TOOL, '--input', current.input, '--input', current.input, '--out', current.out], {
      encoding: 'utf8',
    }),
    /only once/u,
  );
});
