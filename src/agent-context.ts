import type { JsonObject } from './types.js';

export type AgentContextKind = 'episode' | 'observation' | 'decision' | 'reflection';

export interface AgentContextEvent extends JsonObject {
  id: string;
  sequence: number;
  kind: AgentContextKind;
  payload: JsonObject;
}

export interface AgentContextQuery {
  after?: string;
  before?: string;
  kind?: AgentContextKind;
  limit?: number;
}

function sequenceOf(cursor: string | undefined, fallback: number): number {
  if (cursor === undefined) return fallback;
  if (typeof cursor !== 'string') throw new Error(`invalid context cursor ${JSON.stringify(cursor)}`);
  const match = /^ctx-(\d{8})$/.exec(cursor);
  if (!match) throw new Error(`invalid context cursor ${JSON.stringify(cursor)}`);
  return Number(match[1]);
}

/** A seat-private append-only episode stream. Rendered prompts may compact it, but authorized
 * clients can page the original accepted observations and decisions by stable cursor. */
export class AgentContextStream {
  private readonly events: AgentContextEvent[];

  constructor(initial: readonly AgentContextEvent[] = []) {
    this.events = initial.map((event, index) => {
      const sequence = index + 1;
      const id = `ctx-${String(sequence).padStart(8, '0')}`;
      if (event.sequence !== sequence || event.id !== id) throw new Error(`non-contiguous context event ${event.id}`);
      return structuredClone(event);
    });
  }

  append(kind: AgentContextKind, payload: JsonObject): AgentContextEvent {
    const sequence = this.events.length + 1;
    const event: AgentContextEvent = {
      id: `ctx-${String(sequence).padStart(8, '0')}`,
      sequence,
      kind,
      payload: structuredClone(payload),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  cursor(): string | null {
    return this.events.at(-1)?.id ?? null;
  }

  read(query: AgentContextQuery = {}): { events: AgentContextEvent[]; cursor: string | null; more: boolean } {
    const after = sequenceOf(query.after, 0);
    const before = sequenceOf(query.before, Number.POSITIVE_INFINITY);
    if (query.kind !== undefined && !['episode', 'observation', 'decision', 'reflection'].includes(query.kind))
      throw new Error(`invalid context kind ${JSON.stringify(query.kind)}`);
    const requestedLimit = query.limit ?? 100;
    if (!Number.isFinite(requestedLimit)) throw new Error(`invalid context limit ${JSON.stringify(requestedLimit)}`);
    const limit = Math.max(1, Math.min(Math.trunc(requestedLimit), 500));
    const eligible = this.events.filter(
      (event) => event.sequence > after && event.sequence < before && (!query.kind || event.kind === query.kind),
    );
    return {
      events: structuredClone(eligible.slice(0, limit)),
      cursor: this.cursor(),
      more: eligible.length > limit,
    };
  }
}
