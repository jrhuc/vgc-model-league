#!/usr/bin/env node
import path from 'node:path';

import {
  FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
  FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
  FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
  FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY,
  freezeFrozenMatchdayTaskSource,
} from '../src/eval/frozen-matchday-task-source.js';

interface Settings {
  input: string;
  out: string;
}

const HELP = `Usage: freeze-frozen-matchday-task-source --input <private-source.json> --out <absent-private-output-root>

Publication precondition: ${FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION}.
Runtime-byte portability: ${FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY}.
Loaded-JS module-byte attestation: ${FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION}.
Authority snapshot scope: ${FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE}.
The trusted single producer must keep the repository, build, and runtime tree immutable from process start through
publication. Loaded JS module bytes are not independently attested. The authority snapshot detects mutations only
after capture; whole-set membership and file-state checks do not attest earlier process-start state.
The reviewed runtime-byte digest requires the repository's supported POSIX/LF build. Authority bytes are raw,
are not newline-normalized, and are not claimed to have equal digests across platforms or build encodings.
Node provides no portable atomic directory NOREPLACE; do not run a concurrent same-privilege writer.
Existing roots are verified only as byte-identical complete reruns and are never knowingly overwritten.
`;

function parse(argv: string[]): Settings {
  const values: Partial<Settings> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--input' && flag !== '--out') throw new Error(`unknown flag ${String(flag)}`);
    const value = argv[++index];
    if (!value) throw new Error(`${flag} requires a path`);
    const key = flag === '--input' ? 'input' : 'out';
    if (values[key]) throw new Error(`${flag} may be supplied only once`);
    values[key] = path.resolve(value);
  }
  if (!values.input) throw new Error('--input <private-source.json> is required');
  if (!values.out) throw new Error('--out <absent-private-output-root> is required');
  return values as Settings;
}

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  if (argv.length !== 1) throw new Error('--help must be supplied alone');
  process.stdout.write(HELP);
} else {
  const settings = parse(argv);
  const result = freezeFrozenMatchdayTaskSource(settings.input, settings.out, import.meta.url);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
