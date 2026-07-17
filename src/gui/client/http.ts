export async function api<T>(pathname: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(pathname, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
