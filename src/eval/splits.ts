import { createHash } from 'node:crypto';

import { canonicalJson } from './serialization.js';

export type PositionSplit = 'train' | 'eval';

export interface SplitCandidate {
  taskId: string;
  sourceGroup: string;
  duplicateCluster: string;
}

export interface SplitAssignment extends SplitCandidate {
  split: PositionSplit;
  componentId: string;
}

class Components {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index] as number;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(first: number, second: number): void {
    const a = this.find(first);
    const b = this.find(second);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}

function digest(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`, 'utf8').update(part, 'utf8');
  return hash.digest('hex');
}

function fractionFromDigest(value: string): number {
  return Number(BigInt(`0x${value.slice(0, 16)}`)) / 2 ** 64;
}

/** Source games and caller-supplied duplicate clusters form connected components. The split is
 * assigned only after that union, so nearby positions and repeated public tasks cannot cross it. */
export function assignPositionSplits(
  candidates: readonly SplitCandidate[],
  seed: string,
  evalFraction: number,
): SplitAssignment[] {
  if (!(evalFraction > 0 && evalFraction < 1)) throw new Error('eval fraction must be between zero and one');
  const ordered = [...candidates].sort((a, b) => Buffer.from(a.taskId).compare(Buffer.from(b.taskId)));
  if (new Set(ordered.map((entry) => entry.taskId)).size !== ordered.length) throw new Error('duplicate task id');
  if (ordered.some((entry) => !entry.taskId || !entry.sourceGroup || !entry.duplicateCluster)) {
    throw new Error('every split candidate needs task, source-group, and duplicate-cluster ids');
  }
  const components = new Components(ordered.length);
  for (const field of ['sourceGroup', 'duplicateCluster'] as const) {
    const first = new Map<string, number>();
    for (const [index, entry] of ordered.entries()) {
      const prior = first.get(entry[field]);
      if (prior === undefined) first.set(entry[field], index);
      else components.union(prior, index);
    }
  }
  const members = new Map<number, SplitCandidate[]>();
  for (const [index, entry] of ordered.entries()) {
    const root = components.find(index);
    members.set(root, [...(members.get(root) ?? []), entry]);
  }
  const assignments: SplitAssignment[] = [];
  for (const group of members.values()) {
    const ids = group.map((entry) => entry.taskId).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    const componentId = digest(['position-split-component-v1', ...ids]);
    const split: PositionSplit =
      fractionFromDigest(digest(['position-split-assignment-v1', seed, componentId])) < evalFraction ? 'eval' : 'train';
    for (const entry of group) assignments.push({ ...entry, split, componentId });
  }
  return assignments.sort((a, b) => Buffer.from(a.taskId).compare(Buffer.from(b.taskId)));
}

export function positionSplitDigest(assignments: readonly SplitAssignment[]): string {
  const canonical = [...assignments]
    .sort((a, b) => Buffer.from(a.taskId).compare(Buffer.from(b.taskId)))
    .map((entry) => canonicalJson(entry));
  return digest(['position-split-v1', ...canonical]);
}
