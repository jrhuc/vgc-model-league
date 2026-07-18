export function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const secret of secrets) {
    if (secret && secret !== 'none') redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted.slice(0, 2000);
}

export async function readCappedText(response: Response, limit: number): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > limit) return undefined;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}
