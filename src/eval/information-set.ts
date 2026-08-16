import { seededRng } from '../random.js';
import { canonicalJsonDigest } from './serialization.js';

export const INFORMATION_SET_PROTOCOL = {
  version: 1,
  prior: 'compatible-hidden-state-weighted-support-v1',
  draws: 'seeded-systematic-resampling-common-action-plan-v1',
} as const;

export interface HiddenStateCompletion {
  id: string;
  hiddenStateDigest: string;
  provenance: string;
  weight: number;
}

export interface InformationSetPrior {
  protocolVersion: typeof INFORMATION_SET_PROTOCOL.version;
  id: string;
  revision: string;
  publicInformationDigest: string;
  completions: Array<HiddenStateCompletion & { normalizedWeight: number }>;
  priorDigest: string;
}

export interface InformationSetDraw {
  id: string;
  index: number;
  completionId: string;
  hiddenStateDigest: string;
  hiddenStateSeed: string;
  opponentPolicySeed: string;
  battleSeed: [number, number, number, number];
  continuationSeed: string;
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

export function buildInformationSetPrior(input: {
  id: string;
  revision: string;
  publicInformationDigest: string;
  completions: readonly HiddenStateCompletion[];
}): InformationSetPrior {
  if (!input.id || !input.revision) throw new Error('information-set prior needs non-empty id and revision');
  assertDigest(input.publicInformationDigest, 'publicInformationDigest');
  if (!input.completions.length) throw new Error('information-set prior needs compatible hidden-state support');
  const ids = new Set<string>();
  let total = 0;
  for (const completion of input.completions) {
    if (!completion.id || !completion.provenance) {
      throw new Error('hidden-state completion needs non-empty id and provenance');
    }
    if (ids.has(completion.id)) throw new Error(`information-set prior repeats completion ${JSON.stringify(completion.id)}`);
    ids.add(completion.id);
    assertDigest(completion.hiddenStateDigest, `${completion.id} hiddenStateDigest`);
    if (!Number.isFinite(completion.weight) || completion.weight <= 0) {
      throw new Error(`${completion.id} hidden-state weight must be positive and finite`);
    }
    total += completion.weight;
  }
  const completions = input.completions.map((completion) => ({
    ...structuredClone(completion),
    normalizedWeight: completion.weight / total,
  }));
  const base = {
    protocolVersion: INFORMATION_SET_PROTOCOL.version,
    id: input.id,
    revision: input.revision,
    publicInformationDigest: input.publicInformationDigest,
    completions,
  };
  return { ...base, priorDigest: canonicalJsonDigest(base) };
}

function completionForTarget(
  completions: readonly InformationSetPrior['completions'][number][],
  target: number,
): InformationSetPrior['completions'][number] {
  let cumulative = 0;
  for (const completion of completions) {
    cumulative += completion.normalizedWeight;
    if (target < cumulative || Math.abs(cumulative - 1) <= 1e-12) return completion;
  }
  return completions.at(-1) as InformationSetPrior['completions'][number];
}

export function informationSetDrawPlan(
  prior: InformationSetPrior,
  count: number,
  seed: string | number,
): InformationSetDraw[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('information-set draw count must be a positive integer');
  if (
    canonicalJsonDigest({
      protocolVersion: prior.protocolVersion,
      id: prior.id,
      revision: prior.revision,
      publicInformationDigest: prior.publicInformationDigest,
      completions: prior.completions,
    }) !== prior.priorDigest
  ) {
    throw new Error('information-set prior digest does not match its contents');
  }
  const namespace = `${prior.priorDigest}:${String(seed)}`;
  const random = seededRng(`${namespace}:systematic-offset`);
  const offset = random() / count;
  return Array.from({ length: count }, (_, index) => {
    const target = offset + index / count;
    const completion = completionForTarget(prior.completions, target);
    const battleRandom = seededRng(`${namespace}:battle:${index}`);
    const word = () => 1 + Math.floor(battleRandom() * 0xffff);
    return {
      id: canonicalJsonDigest([namespace, index, completion.id]),
      index,
      completionId: completion.id,
      hiddenStateDigest: completion.hiddenStateDigest,
      hiddenStateSeed: `${namespace}:hidden:${index}`,
      opponentPolicySeed: `${namespace}:opponent:${index}`,
      battleSeed: [word(), word(), word(), word()],
      continuationSeed: `${namespace}:continuation:${index}`,
    };
  });
}
