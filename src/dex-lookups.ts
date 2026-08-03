import { assistantToolMessage, classifyProviderFailure, toolResultMessage } from './providers.js';
import type { RecoveryGate } from './recovery.js';
import type { ShowdownReference } from './reference.js';
import { DEX_TOOLS } from './reference.js';
import type { Completion, JsonObject, Provider, ProviderMessage } from './types.js';
import { isRecord } from './value.js';

export const TOOL_BUDGET_NOTICE =
  'Tool budget for this reply is exhausted; further tool calls will not be executed. Reply now with only the final JSON object.';

function textToolCall(text: string): { name: string; arguments: JsonObject } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string') return undefined;
  const name = parsed.name;
  if (!DEX_TOOLS.some((tool) => tool.name === name)) return undefined;
  const args = parsed.args ?? parsed.arguments ?? parsed.parameters;
  return isRecord(args) ? { name, arguments: args } : undefined;
}

export interface DexToolPolicy {
  maxTokens: number;
  timeoutSeconds: number;
  toolRounds: number;
  maxCallsPerRound: number;
  providerRetries: number;
  retryBaseMs: number;
}

export interface DexToolRequest {
  provider: Provider;
  system: string;
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

async function completeOnce(request: DexToolRequest, options: { tools: boolean; final: boolean }): Promise<Completion> {
  for (let attempt = 0; ; attempt += 1) {
    await request.recovery?.wait(request.spec, request.signal);
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

export async function completeWithDexTools(request: DexToolRequest): Promise<Completion> {
  const usage: Record<string, number> = {};
  const seenToolResults = new Map<string, string>();
  const lookup = (name: string, args: JsonObject): string => {
    const seenKey = `${name} ${JSON.stringify(args)}`;
    const cached = seenToolResults.get(seenKey);
    if (cached !== undefined) return `[identical to an earlier call this reply] ${cached}`;
    const result = request.reference.lookup(name, args);
    seenToolResults.set(seenKey, result);
    return result;
  };
  for (let round = 0; ; round += 1) {
    request.signal?.throwIfAborted();
    const final = round >= request.policy.toolRounds;
    if (final && round === request.policy.toolRounds) {
      request.messages.push({ role: 'user', content: TOOL_BUDGET_NOTICE });
    }
    const completion = await completeOnce(request, { tools: true, final });
    for (const [key, value] of Object.entries(completion.usage)) {
      usage[key] = (usage[key] ?? 0) + Math.trunc(value);
    }
    if (!completion.toolCalls.length || final) {
      const salvaged = final ? undefined : textToolCall(completion.text);
      if (salvaged) {
        request.messages.push({ role: 'assistant', content: completion.text });
        const result = lookup(salvaged.name, salvaged.arguments);
        request.onLookup?.({ name: salvaged.name, arguments: salvaged.arguments, result });
        request.messages.push({
          role: 'user',
          content: `Tool result for ${salvaged.name}: ${result}\nWhen your analysis is done, reply with only the final JSON object.`,
        });
        continue;
      }
      /** Some providers omit finishReason, so an exhausted output budget also means truncation. */
      const spent = (completion.usage.output_tokens ?? 0) >= request.policy.maxTokens;
      return {
        ...completion,
        usage,
        ...(spent || completion.finishReason === 'length' ? { finishReason: 'length' as const } : {}),
      };
    }

    const calls = completion.toolCalls.slice(0, request.policy.maxCallsPerRound);
    const dropped = completion.toolCalls.slice(request.policy.maxCallsPerRound);
    request.messages.push(assistantToolMessage(completion));
    for (const call of dropped) {
      const result = `Not executed: this round exceeded its budget of ${request.policy.maxCallsPerRound} calls. Re-issue the call next round if you still need it.`;
      request.onLookup?.({ name: call.name, arguments: call.arguments, result });
      request.messages.push(toolResultMessage(call.id, result));
    }
    for (const call of calls) {
      const result = lookup(call.name, call.arguments);
      request.onLookup?.({ name: call.name, arguments: call.arguments, result });
      request.messages.push(toolResultMessage(call.id, result));
    }
  }
}
