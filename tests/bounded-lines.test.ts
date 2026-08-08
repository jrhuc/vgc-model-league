import assert from 'node:assert/strict';
import test from 'node:test';

import { type BoundedLineEvent, readBoundedLines } from '../src/bounded-lines.js';

async function collect(input: readonly Uint8Array[], maxBytes: number): Promise<BoundedLineEvent[]> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield* input;
  }
  const events: BoundedLineEvent[] = [];
  for await (const event of readBoundedLines(chunks(), maxBytes)) events.push(event);
  return events;
}

test('bounded lines preserve chunked UTF-8, CRLF, exact-limit lines, and a final unterminated line', async () => {
  const bytes = Buffer.from('é\n1234\r\nlast', 'utf8');
  const events = await collect([bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)], 4);
  assert.deepEqual(events, [
    { kind: 'line', value: 'é' },
    { kind: 'line', value: '1234' },
    { kind: 'line', value: 'last' },
  ]);
});

test('bounded lines report an oversized line before its newline, discard it once, and resynchronize', async () => {
  let releaseInput: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('12345');
    await blocked;
    yield Buffer.from('678\nok\ntail');
  }

  const lines = readBoundedLines(chunks(), 4);
  assert.deepEqual(await lines.next(), { done: false, value: { kind: 'too-large' } });
  releaseInput?.();
  assert.deepEqual(await lines.next(), { done: false, value: { kind: 'line', value: 'ok' } });
  assert.deepEqual(await lines.next(), { done: false, value: { kind: 'line', value: 'tail' } });
  assert.deepEqual(await lines.next(), { done: true, value: undefined });
});
