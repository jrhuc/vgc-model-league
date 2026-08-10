import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../src/gui/client/http.js';

test('pool team reads deduplicate only while the request is in flight', async () => {
  const nativeFetch = globalThis.fetch;
  let requests = 0;
  let finishFirst: (() => void) | undefined;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) await new Promise<void>((resolve) => (finishFirst = resolve));
    return new Response(JSON.stringify({ teams: [{ id: `version-${requests}` }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const pathname = '/api/pool/teams?pool=client-cache-behavior';
    const first = api<{ teams: Array<{ id: string }> }>(pathname);
    const duplicate = api<{ teams: Array<{ id: string }> }>(pathname);
    assert.equal(requests, 1);
    finishFirst?.();
    assert.deepEqual(await first, await duplicate);

    const refreshed = await api<{ teams: Array<{ id: string }> }>(pathname);
    assert.equal(requests, 2);
    assert.equal(refreshed.teams[0]?.id, 'version-2');
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
