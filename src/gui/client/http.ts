let csrfToken = '';

export function configureCsrf(token: string | null | undefined): void {
  csrfToken = token ?? '';
}

/**
 * Archive reads (finished runs, immutable boards, records) serve stale from a
 * session cache while revalidating in the background: remote deployments sit
 * behind ~0.5s round trips, and without this every tab switch re-pays them.
 * Live routes (state, battle, events, run control) must never be cached.
 */
const CACHEABLE =
  /^\/api\/(?:leagues|league|league\/game|tournaments|board|records|evidence|model|pool\/teams)(?:\?|$)/;
const CACHE_TTL_MS = 300_000;
const cache = new Map<string, { at: number; data: unknown }>();

async function request<T>(pathname: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          },
          body: JSON.stringify(body),
        };
  const response = await fetch(pathname, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function revalidate<T>(pathname: string): Promise<T> {
  const data = await request<T>(pathname);
  cache.set(pathname, { at: Date.now(), data });
  return data;
}

export async function api<T>(pathname: string, body?: unknown): Promise<T> {
  if (body !== undefined || !CACHEABLE.test(pathname)) return request<T>(pathname, body);
  const hit = cache.get(pathname);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    void revalidate<T>(pathname).catch(() => {});
    return hit.data as T;
  }
  return revalidate<T>(pathname);
}
