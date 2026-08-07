import { canonicalJsonDigest } from './serialization.js';

export const NEAR_DUPLICATE_PROTOCOL = {
  version: 1,
  scope: 'rendered-visible-position-between-introduction-and-action-footer',
  normalization: 'NFKC-lowercase-numeric-token-placeholder',
  features: 'unique-consecutive-token-trigrams',
  similarity: 'jaccard',
  clustering: 'connected-components-at-frozen-threshold',
} as const;

export interface DuplicateCandidate {
  id: string;
  prompt: string;
}

export interface DuplicatePair {
  first: string;
  second: string;
  similarity: number;
}

function visiblePosition(prompt: string): string {
  const start = prompt.indexOf('\n\n');
  const end = prompt.indexOf('\n\nLEGAL JOINT ACTIONS:');
  return prompt.slice(start < 0 ? 0 : start + 2, end < 0 ? prompt.length : end);
}

export function positionDuplicateFeatures(prompt: string): string[] {
  const tokens = (
    visiblePosition(prompt)
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).map((token) => (/^\p{N}+$/u.test(token) ? '#' : token));
  if (tokens.length < 3) return tokens.length ? [tokens.join(' ')] : [];
  return [
    ...new Set(tokens.slice(0, -2).map((token, index) => `${token} ${tokens[index + 1]} ${tokens[index + 2]}`)),
  ].sort();
}

export function jaccard(first: readonly string[], second: readonly string[]): number {
  const a = new Set(first);
  const b = new Set(second);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 1;
}

export function clusterNearDuplicatePositions(
  candidates: readonly DuplicateCandidate[],
  threshold: number,
): { clusters: Map<string, string>; pairs: DuplicatePair[] } {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('near-duplicate threshold must be in [0, 1]');
  const byId = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(byId.map((entry) => entry.id)).size !== byId.length)
    throw new Error('duplicate candidate ids are not unique');
  const features = new Map(byId.map((entry) => [entry.id, positionDuplicateFeatures(entry.prompt)]));
  const parent = new Map(byId.map((entry) => [entry.id, entry.id]));
  const find = (id: string): string => {
    const prior = parent.get(id) as string;
    if (prior === id) return id;
    const root = find(prior);
    parent.set(id, root);
    return root;
  };
  const union = (first: string, second: string) => {
    const a = find(first);
    const b = find(second);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  const pairs: DuplicatePair[] = [];
  for (let first = 0; first < byId.length; first += 1) {
    for (let second = first + 1; second < byId.length; second += 1) {
      const a = byId[first] as DuplicateCandidate;
      const b = byId[second] as DuplicateCandidate;
      const similarity = jaccard(features.get(a.id) as string[], features.get(b.id) as string[]);
      if (similarity < threshold) continue;
      pairs.push({ first: a.id, second: b.id, similarity });
      union(a.id, b.id);
    }
  }
  const members = new Map<string, string[]>();
  for (const entry of byId) {
    const root = find(entry.id);
    const group = members.get(root) ?? [];
    group.push(entry.id);
    members.set(root, group);
  }
  const clusters = new Map<string, string>();
  for (const group of members.values()) {
    const cluster = canonicalJsonDigest(['near-duplicate-cluster-v1', threshold, group]);
    for (const id of group) clusters.set(id, cluster);
  }
  return { clusters, pairs };
}
