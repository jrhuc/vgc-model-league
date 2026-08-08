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

export interface StratifiedSplitCandidate extends SplitCandidate {
  stratum: string;
}

export interface StratifiedSplitAssignment extends SplitAssignment {
  stratum: string;
}

interface SplitComponent {
  id: string;
  members: StratifiedSplitCandidate[];
  strata: Map<string, number>;
  tie: string;
}

/** Deterministically allocates whole leakage components with a largest-first greedy pass against
 * global plus per-stratum squared deviation, then applies at most one improving single-flip or swap
 * repair. Caller-gated tolerances remain the fail-closed release gate; neither tolerance feasibility
 * nor global optimality is guaranteed. */
export function assignStratifiedPositionSplits(
  candidates: readonly StratifiedSplitCandidate[],
  seed: string,
  evalFraction: number,
): StratifiedSplitAssignment[] {
  if (!(evalFraction > 0 && evalFraction < 1)) throw new Error('eval fraction must be between zero and one');
  if (candidates.some((entry) => !entry.stratum)) throw new Error('every stratified split candidate needs a stratum');
  const base = assignPositionSplits(candidates, seed, evalFraction);
  const candidateById = new Map(candidates.map((entry) => [entry.taskId, entry]));
  const grouped = new Map<string, StratifiedSplitCandidate[]>();
  for (const entry of base) {
    const candidate = candidateById.get(entry.taskId) as StratifiedSplitCandidate;
    grouped.set(entry.componentId, [...(grouped.get(entry.componentId) ?? []), candidate]);
  }
  const totals = new Map<string, number>();
  for (const entry of base) {
    const stratum = (candidateById.get(entry.taskId) as StratifiedSplitCandidate).stratum;
    totals.set(stratum, (totals.get(stratum) ?? 0) + 1);
  }
  const components: SplitComponent[] = [...grouped.entries()].map(([id, members]) => {
    const strata = new Map<string, number>();
    for (const member of members) strata.set(member.stratum, (strata.get(member.stratum) ?? 0) + 1);
    return { id, members, strata, tie: digest(['position-stratified-order-v1', seed, id]) };
  });
  components.sort((a, b) => b.members.length - a.members.length || a.tie.localeCompare(b.tie));
  const evalByStratum = new Map<string, number>();
  let evalTotal = 0;
  const targetTotal = candidates.length * evalFraction;
  const objective = (component: SplitComponent, assignEval: boolean): number => {
    const candidateTotal = evalTotal + (assignEval ? component.members.length : 0);
    let score = ((candidateTotal - targetTotal) / candidates.length) ** 2;
    for (const [stratum, total] of totals) {
      const count = (evalByStratum.get(stratum) ?? 0) + (assignEval ? (component.strata.get(stratum) ?? 0) : 0);
      score += ((count - total * evalFraction) / total) ** 2;
    }
    return score;
  };
  const splitByComponent = new Map<string, PositionSplit>();
  for (const component of components) {
    const evalScore = objective(component, true);
    const trainScore = objective(component, false);
    const split: PositionSplit =
      evalScore < trainScore || (evalScore === trainScore && fractionFromDigest(component.tie) < evalFraction)
        ? 'eval'
        : 'train';
    splitByComponent.set(component.id, split);
    if (split === 'eval') {
      evalTotal += component.members.length;
      for (const [stratum, count] of component.strata)
        evalByStratum.set(stratum, (evalByStratum.get(stratum) ?? 0) + count);
    }
  }
  if (components.length) {
    const scoreWithChanges = (changes: readonly SplitComponent[]): number => {
      let candidateTotal = evalTotal;
      const candidateByStratum = new Map(evalByStratum);
      for (const component of changes) {
        const direction = splitByComponent.get(component.id) === 'eval' ? -1 : 1;
        candidateTotal += direction * component.members.length;
        for (const [stratum, count] of component.strata)
          candidateByStratum.set(stratum, (candidateByStratum.get(stratum) ?? 0) + direction * count);
      }
      let score = ((candidateTotal - targetTotal) / candidates.length) ** 2;
      for (const [stratum, total] of totals) {
        const count = candidateByStratum.get(stratum) ?? 0;
        score += ((count - total * evalFraction) / total) ** 2;
      }
      return score;
    };
    let bestScore = scoreWithChanges([]);
    let bestRepair: readonly SplitComponent[] = [];
    const considerRepair = (changes: readonly SplitComponent[]): void => {
      const score = scoreWithChanges(changes);
      if (score < bestScore) {
        bestScore = score;
        bestRepair = changes;
      }
    };
    for (const component of components) considerRepair([component]);
    for (const [index, first] of components.entries()) {
      for (let secondIndex = index + 1; secondIndex < components.length; secondIndex += 1) {
        const second = components[secondIndex] as SplitComponent;
        if (splitByComponent.get(first.id) !== splitByComponent.get(second.id)) considerRepair([first, second]);
      }
    }
    for (const component of bestRepair) {
      const split = splitByComponent.get(component.id) as PositionSplit;
      splitByComponent.set(component.id, split === 'eval' ? 'train' : 'eval');
    }
  }
  return base
    .map((entry) => ({
      ...entry,
      stratum: (candidateById.get(entry.taskId) as StratifiedSplitCandidate).stratum,
      split: splitByComponent.get(entry.componentId) as PositionSplit,
    }))
    .sort((a, b) => Buffer.from(a.taskId).compare(Buffer.from(b.taskId)));
}

export function splitBalance(
  assignments: readonly StratifiedSplitAssignment[],
  target: number,
): {
  evalFraction: number;
  evalFractionDeviation: number;
  strata: Record<string, { total: number; eval: number; evalFraction: number; deviation: number }>;
  maxStratumDeviation: number;
} {
  if (!assignments.length) throw new Error('cannot measure an empty split');
  const evalCount = assignments.filter((entry) => entry.split === 'eval').length;
  const strata = new Map<string, { total: number; eval: number }>();
  for (const entry of assignments) {
    const counts = strata.get(entry.stratum) ?? { total: 0, eval: 0 };
    counts.total += 1;
    if (entry.split === 'eval') counts.eval += 1;
    strata.set(entry.stratum, counts);
  }
  const result = Object.fromEntries(
    [...strata.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stratum, counts]) => {
        const fraction = counts.eval / counts.total;
        return [stratum, { ...counts, evalFraction: fraction, deviation: Math.abs(fraction - target) }];
      }),
  );
  return {
    evalFraction: evalCount / assignments.length,
    evalFractionDeviation: Math.abs(evalCount / assignments.length - target),
    strata: result,
    maxStratumDeviation: Math.max(...Object.values(result).map((entry) => entry.deviation)),
  };
}

export function positionSplitDigest(assignments: readonly SplitAssignment[]): string {
  const canonical = [...assignments]
    .sort((a, b) => Buffer.from(a.taskId).compare(Buffer.from(b.taskId)))
    .map((entry) => canonicalJson(entry));
  return digest(['position-split-v1', ...canonical]);
}
