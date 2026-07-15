import type { JsonObject } from './types.js';

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function asRecords(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function afterColon(value: string): string {
  const separator = value.indexOf(': ');
  return separator < 0 ? value : value.slice(separator + 2);
}
