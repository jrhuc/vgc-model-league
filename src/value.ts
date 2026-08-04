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

export function ordinal(rank: number): string {
  const suffix =
    rank % 10 === 1 && rank !== 11
      ? 'st'
      : rank % 10 === 2 && rank !== 12
        ? 'nd'
        : rank % 10 === 3 && rank !== 13
          ? 'rd'
          : 'th';
  return `${rank}${suffix}`;
}

/** Doom-loop backstop, not a content budget: limits should be set far above real traffic, and any
 * clipping must stay visible to the model and in traces rather than silently amputating content. */
export function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)} [clipped]`;
}
