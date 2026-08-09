import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentContextStream } from '../src/agent-context.js';

test('seat context pages from the last returned event without jumping to the stream head', () => {
  const stream = new AgentContextStream();
  const first = stream.append('episode', { game: 1 });
  stream.append('observation', { lines: ['|turn|1'] });
  stream.append('decision', { action: 'move 1' });
  stream.append('observation', { lines: ['|turn|2'] });
  stream.append('reflection', { summary: 'review' });
  assert.equal(first.id, 'ctx-00000001');
  assert.equal(stream.cursor(), 'ctx-00000005');

  const ids: string[] = [];
  let after = first.id;
  let more = true;
  while (more) {
    const page = stream.read({ after, limit: 1 });
    ids.push(...page.events.map((event) => event.id));
    assert.equal(page.headCursor, 'ctx-00000005');
    assert.equal(page.nextCursor, page.events.at(-1)?.id ?? null);
    if (page.nextCursor) after = page.nextCursor;
    more = page.more;
  }
  assert.deepEqual(ids, ['ctx-00000002', 'ctx-00000003', 'ctx-00000004', 'ctx-00000005']);

  const page = stream.read({ after: first.id, limit: 1 });
  page.events[0]!.payload.lines = [];
  assert.deepEqual(stream.read({ kind: 'observation' }).events[0]!.payload.lines, ['|turn|1']);
});

test('kind and before filters retain page and head cursor semantics', () => {
  const stream = new AgentContextStream();
  stream.append('episode', {});
  stream.append('observation', { turn: 1 });
  stream.append('decision', {});
  stream.append('observation', { turn: 2 });
  stream.append('reflection', {});

  const firstObservation = stream.read({ kind: 'observation', limit: 1 });
  assert.deepEqual(
    firstObservation.events.map((event) => event.id),
    ['ctx-00000002'],
  );
  assert.equal(firstObservation.nextCursor, 'ctx-00000002');
  assert.equal(firstObservation.headCursor, 'ctx-00000005');
  assert.equal(firstObservation.more, true);
  const secondObservation = stream.read({
    after: firstObservation.nextCursor!,
    kind: 'observation',
    limit: 1,
  });
  assert.deepEqual(
    secondObservation.events.map((event) => event.id),
    ['ctx-00000004'],
  );
  assert.equal(secondObservation.nextCursor, 'ctx-00000004');
  assert.equal(secondObservation.headCursor, 'ctx-00000005');
  assert.equal(secondObservation.more, false);

  const before = stream.read({ before: 'ctx-00000004', limit: 2 });
  assert.deepEqual(
    before.events.map((event) => event.id),
    ['ctx-00000001', 'ctx-00000002'],
  );
  assert.equal(before.nextCursor, 'ctx-00000002');
  assert.equal(before.headCursor, 'ctx-00000005');
  assert.equal(before.more, true);
  const remainder = stream.read({ after: before.nextCursor!, before: 'ctx-00000004', limit: 2 });
  assert.deepEqual(
    remainder.events.map((event) => event.id),
    ['ctx-00000003'],
  );
  assert.equal(remainder.nextCursor, 'ctx-00000003');
  assert.equal(remainder.headCursor, 'ctx-00000005');
  assert.equal(remainder.more, false);
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

test('a failed sink leaves the sequence uncommitted so retry reuses the stable cursor', () => {
  const first = new AgentContextStream();
  first.append('episode', { attempt_id: 'a' });
  const persisted: string[] = [];
  let fail = true;
  const resumed = new AgentContextStream(first.read().events, (event) => {
    if (fail) {
      fail = false;
      throw new Error('disk append failed');
    }
    persisted.push(event.id);
  });

  assert.throws(() => resumed.append('observation', { turn: 1 }), /disk append failed/);
  assert.equal(resumed.cursor(), 'ctx-00000001');
  assert.deepEqual(
    resumed.read().events.map((event) => event.id),
    ['ctx-00000001'],
  );
  const retried = resumed.append('observation', { turn: 1 });
  const next = resumed.append('decision', { action: 'move 1' });
  assert.equal(retried.id, 'ctx-00000002');
  assert.equal(next.id, 'ctx-00000003');
  assert.deepEqual(persisted, ['ctx-00000002', 'ctx-00000003']);
  assert.deepEqual(
    resumed.read().events.map((event) => event.id),
    ['ctx-00000001', 'ctx-00000002', 'ctx-00000003'],
  );
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
