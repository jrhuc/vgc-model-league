import { STATIC_SITE } from './capabilities.js';

const IMMUTABLE_PATH = /^\/api\/(?:selected-trace|board)(?:\?|$)/;
const immutableCache = new Map<string, unknown>();
const requests = new Map<string, Promise<unknown>>();

export const TRACE_ARTIFACT_HREF = STATIC_SITE ? 'data/selected-trace-full.json' : '/api/selected-trace/full.json';

/** The static deployment serves each read-only API response as a JSON file exported by `vgcleague export-site`. */
function staticDataPath(pathname: string): string {
  const url = new URL(pathname, 'http://static.invalid');
  const query = url.searchParams;
  switch (url.pathname) {
    case '/api/state':
      return 'data/state.json';
    case '/api/selected-trace':
      return 'data/selected-trace.json';
    case '/api/selected-trace/full.json':
      return 'data/selected-trace-full.json';
    case '/api/leagues':
      return 'data/leagues.json';
    case '/api/tournaments':
      return 'data/tournaments.json';
    case '/api/league':
      return `data/league/${encodeURIComponent(query.get('run') ?? '')}.json`;
    case '/api/league/game':
      return `data/league/${encodeURIComponent(query.get('run') ?? '')}/game-${query.get('series')}-${query.get('game')}.json`;
    case '/api/tournament/game':
      return `data/tournament/${encodeURIComponent(query.get('run') ?? '')}/game-${query.get('series')}-${query.get('game')}.json`;
    case '/api/board':
      return `data/board/${encodeURIComponent(query.get('id') ?? '')}.json`;
    default:
      return pathname;
  }
}

async function request<T>(pathname: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const target = STATIC_SITE && body === undefined ? staticDataPath(pathname) : pathname;
  const response = await fetch(target, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function immutableResponse(pathname: string, data: unknown): boolean {
  if (IMMUTABLE_PATH.test(pathname)) return true;
  if (!/^\/api\/(?:league(?:\/game)?|tournament\/game)\?/.test(pathname)) return false;
  if (typeof data !== 'object' || data === null) return false;
  if ('live' in data) return data.live === false;
  return 'lifecycle' in data && data.lifecycle !== 'live';
}

function load<T>(pathname: string): Promise<T> {
  if (immutableCache.has(pathname)) return Promise.resolve(immutableCache.get(pathname) as T);
  const pending = requests.get(pathname);
  if (pending) return pending as Promise<T>;
  const next = request<T>(pathname)
    .then((data) => {
      if (immutableResponse(pathname, data)) immutableCache.set(pathname, data);
      return data;
    })
    .finally(() => requests.delete(pathname));
  requests.set(pathname, next);
  return next;
}

export async function api<T>(pathname: string, body?: unknown): Promise<T> {
  return body === undefined ? load<T>(pathname) : request<T>(pathname, body);
}

export async function apiFresh<T>(pathname: string): Promise<T> {
  const data = await request<T>(pathname);
  if (immutableResponse(pathname, data)) immutableCache.set(pathname, data);
  return data;
}
