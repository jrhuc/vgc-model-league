import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentContextStream } from '../src/agent-context.js';

test('seat context is append-only, cursor-addressable, and returned by value', () => {
  const stream = new AgentContextStream();
  const first = stream.append('episode', { game: 1 });
  stream.append('observation', { lines: ['|turn|1'] });
  stream.append('decision', { action: 'move 1' });
  assert.equal(first.id, 'ctx-00000001');
  assert.equal(stream.cursor(), 'ctx-00000003');
  const page = stream.read({ after: first.id, limit: 1 });
  assert.deepEqual(
    page.events.map((event) => event.id),
    ['ctx-00000002'],
  );
  assert.equal(page.more, true);
  page.events[0]!.payload.lines = [];
  assert.deepEqual(stream.read({ kind: 'observation' }).events[0]!.payload.lines, ['|turn|1']);
});

test('a resumed stream continues prior stable cursors without mutating its source', () => {
  const first = new AgentContextStream();
  first.append('episode', { attempt_id: 'a' });
  const saved = first.read().events;
  const resumed = new AgentContextStream(saved);
  resumed.append('episode', { attempt_id: 'b' });
  assert.equal(resumed.cursor(), 'ctx-00000002');
  assert.equal(first.cursor(), 'ctx-00000001');
  assert.throws(() => new AgentContextStream([{ ...saved[0]!, id: 'ctx-00000002' }]), /non-contiguous context event/);
});

test('context cursors are validated and bounded', () => {
  const stream = new AgentContextStream();
  stream.append('episode', {});
  assert.throws(() => stream.read({ after: 'bad' }), /invalid context cursor/);
  assert.throws(() => stream.read({ kind: 'private' as never }), /invalid context kind/);
  assert.throws(() => stream.read({ limit: Number.NaN }), /invalid context limit/);
  assert.equal(stream.read({ limit: 0 }).events.length, 1);
  assert.deepEqual(stream.read({ before: 'ctx-00000001' }).events, []);
});
