#!/usr/bin/env node
import { readBoundedLines } from '../src/bounded-lines.js';
import { FrozenCircuitProtocolSession } from '../src/frozen-circuit-protocol.js';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const session = new FrozenCircuitProtocolSession();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

write(session.ready());
for await (const event of readBoundedLines(process.stdin, MAX_REQUEST_BYTES)) {
  if (event.kind === 'too-large') {
    write({ id: null, ok: false, error: { code: 'request-too-large', message: 'request exceeds 32 MiB' } });
    continue;
  }
  const line = event.value;
  if (!line.trim()) continue;
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    write({ id: null, ok: false, error: { code: 'invalid-json', message: 'request is not valid JSON' } });
    continue;
  }
  write(session.handle(request));
}
