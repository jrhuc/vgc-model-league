let csrfToken = '';

export function configureCsrf(token: string | null | undefined): void {
  csrfToken = token ?? '';
}

const IMMUTABLE_PATH = /^\/api\/(?:selected-trace|board)(?:\?|$)/;
const immutableCache = new Map<string, unknown>();
const requests = new Map<string, Promise<unknown>>();

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

function immutableResponse(pathname: string, data: unknown): boolean {
  if (IMMUTABLE_PATH.test(pathname)) return true;
  if (!/^\/api\/(?:league(?:\/game)?|tournament\/game)\?/.test(pathname)) return false;
  return typeof data === 'object' && data !== null && 'live' in data && data.live === false;
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
