import crypto from 'node:crypto';

export const CANONICAL_JSON_PROTOCOL = {
  version: 1,
  objectKeys: 'ascending-utf16-code-unit',
  arrays: 'preserve-order',
  strings: 'ecmascript-json-string-escaping-no-unicode-normalization',
  numbers: 'finite-ecmascript-json-number-negative-zero-normalized',
  lineEnding: 'lf',
  jsonlFinalNewline: true,
} as const;

function normalize(value: unknown, location: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => {
      if (entry === undefined) throw new Error(`${location}[${index}] is undefined`);
      return normalize(entry, `${location}[${index}]`);
    });
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${location} is not a plain JSON object`);
    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) throw new Error(`${location}.${key} is undefined`);
      normalized[key] = normalize(object[key], `${location}.${key}`);
    }
    return normalized;
  }
  throw new Error(`${location} contains unsupported ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, '$'));
}

export function canonicalJsonl(rows: readonly unknown[]): string {
  return rows.length ? `${rows.map(canonicalJson).join('\n')}\n` : '';
}

export function canonicalJsonDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
