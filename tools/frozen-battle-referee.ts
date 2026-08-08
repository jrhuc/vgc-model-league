#!/usr/bin/env node
import { createInterface } from 'node:readline';

import { FrozenBattleProtocolSession } from '../src/frozen-battle-protocol.js';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const session = new FrozenBattleProtocolSession();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

write(session.ready());
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
for await (const line of lines) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
    write({ id: null, ok: false, error: { code: 'request-too-large', message: 'request exceeds 32 MiB' } });
    continue;
  }
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    write({ id: null, ok: false, error: { code: 'invalid-json', message: 'request is not valid JSON' } });
    continue;
  }
  write(session.handle(request));
}
