import type { BracketEntrantView } from '../../api';

export function displaySpec(spec: string): string {
  return spec.replace(/:(?:nitro|floor|free)$/, '');
}

export function when(iso: string | null): string {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Walks back to the side's most recent deliberate decision; anything older has been superseded.
 * Null is "did not fall back" — an empty string is "fell back with no detail recorded". */
export function latestFallback<D extends { automatic: boolean; fallback: boolean }>(
  decisions: readonly D[],
  onSide: (decision: D) => boolean,
  detail?: (decision: D) => string,
): string | null {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (decision.automatic || !onSide(decision)) continue;
    return decision.fallback ? (detail?.(decision) ?? '') : null;
  }
  return null;
}

export function modelName(spec: string): string {
  return displaySpec(spec).replace(/^[^:]+:/, '');
}

/** Pool team id → readable label when no player name is available. */
export function formatTeamSlug(slug: string): string {
  const trimmed = slug.replace(/^\d+(?:st|nd|rd|th)-/i, '');
  return trimmed
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ordinal(place: number): string {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  return `${place}${['th', 'st', 'nd', 'rd'][place % 10] ?? 'th'}`;
}

export function entrantOrigin(entrant: BracketEntrantView | undefined): string {
  if (!entrant) return '';
  const place = entrant.placement ?? null;
  const who = entrant.player || (entrant.team ? formatTeamSlug(entrant.team) : '');
  if (!who) return place === null ? '' : ordinal(place);
  return place === null ? who : `${ordinal(place)} · ${who}`;
}
