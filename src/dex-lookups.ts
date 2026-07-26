import { assistantToolMessage, classifyProviderFailure, toolResultMessage } from './providers.js';
import type { RecoveryGate } from './recovery.js';
import type { ShowdownReference } from './reference.js';
import { DEX_TOOLS } from './reference.js';
import type { Completion, JsonObject, Provider, ProviderMessage, ToolCall } from './types.js';

export interface DexToolPolicy {
  maxTokens: number;
  timeoutSeconds: number;
  /** Rounds of lookups before the model must answer. */
  toolRounds: number;
  maxCallsPerRound: number;
  providerRetries: number;
  retryBaseMs: number;
}

export interface DexToolRequest {
  provider: Provider;
  system: string;
  /** Extended in place, so a retry sees the lookups the model already made. */
  messages: ProviderMessage[];
  spec: string;
  reference: ShowdownReference;
  policy: DexToolPolicy;
  recovery?: RecoveryGate;
  signal?: AbortSignal;
  onLookup?: (call: { name: string; arguments: JsonObject; result: string }) => void;
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

/**
 * Transient upstream failures retry with backoff and never surface, so a rate
 * limit cannot be mistaken for a model that failed to answer. Pausable
 * failures are thrown for the caller to hold on its RecoveryGate.
 */
async function completeOnce(request: DexToolRequest, options: { tools: boolean; final: boolean }): Promise<Completion> {
  for (let attempt = 0; ; attempt += 1) {
    await request.recovery?.wait(request.signal);
    try {
      return await request.provider.complete(request.system, request.messages, {
        maxTokens: request.policy.maxTokens,
        timeout: request.policy.timeoutSeconds,
        ...(options.tools ? { tools: DEX_TOOLS, toolChoice: options.final ? 'none' : 'auto' } : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      const failure = classifyProviderFailure(error, request.spec);
      const retryable = failure.retryable ?? !failure.terminal;
      if (!retryable || attempt >= request.policy.providerRetries - 1 || request.signal?.aborted) throw error;
      await delay(request.policy.retryBaseMs * 2 ** attempt, request.signal);
    }
  }
}

function boundedCalls(calls: ToolCall[], max: number): ToolCall[] {
  return calls.slice(0, max);
}

/**
 * Runs the model with the Showdown dex tools available, resolving each lookup
 * until it answers or its rounds run out. Drafting and teambuilding need the
 * same simulator facts as battling — what a Mega becomes, how a matchup reads,
 * what a spread outruns — so they get the same tools rather than a second,
 * weaker source of truth.
 */
export async function completeWithDexTools(request: DexToolRequest): Promise<Completion> {
  const usage: Record<string, number> = {};
  for (let round = 0; ; round += 1) {
    request.signal?.throwIfAborted();
    const final = round >= request.policy.toolRounds;
    const completion = await completeOnce(request, { tools: true, final });
    for (const [key, value] of Object.entries(completion.usage)) {
      usage[key] = (usage[key] ?? 0) + Math.trunc(value);
    }
    if (!completion.toolCalls.length || final) {
      // Providers disagree about whether reasoning counts toward the cap and
      // several never set finishReason, so treat spending the budget as the
      // signal. Callers use it to tell a cut-off model to answer immediately
      // instead of blaming its formatting.
      const spent = (completion.usage.output_tokens ?? 0) >= request.policy.maxTokens;
      return {
        ...completion,
        usage,
        ...(spent || completion.finishReason === 'length' ? { finishReason: 'length' as const } : {}),
      };
    }

    const calls = boundedCalls(completion.toolCalls, request.policy.maxCallsPerRound);
    request.messages.push(
      assistantToolMessage(
        calls.length === completion.toolCalls.length
          ? completion
          : { ...completion, toolCalls: calls, responseMessages: [] },
      ),
    );
    for (const call of calls) {
      const result = request.reference.lookup(call.name, call.arguments);
      request.onLookup?.({ name: call.name, arguments: call.arguments, result });
      request.messages.push(toolResultMessage(call.id, result));
    }
  }
}
