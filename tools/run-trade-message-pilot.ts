#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildFrozenCircuitTerminalTranscript } from '../src/eval/frozen-circuit-adapter.js';
import {
  buildFrozenCircuitTradeCheckpoint,
  completeDefaultDrivenCircuit,
  defaultDriverContinuationControllers,
  FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL,
  type MatchedTradeOfferArm,
  runMatchedTradeOfferForks,
  selectFrozenCircuitTradeReceipts,
  type TradeForkHorizon,
} from '../src/eval/frozen-circuit-trade-forks.js';
import { canonicalJson, canonicalJsonDigest } from '../src/eval/serialization.js';
import { FROZEN_CIRCUIT_SCENARIOS, type FrozenCircuitScenarioId } from '../src/frozen-circuit-model.js';
import { isReasoningLevel, makeProvider, parseSpec, type ReasoningLevel } from '../src/providers.js';
import { parseTradeOffer, tradeWindowOrder, type TradeWindowState } from '../src/trade-window.js';

const HELP = `Usage: pnpm run trade-message-pilot [options]

Fork one trade-offer node of a deterministic synthetic circuit into matched
offers that differ only in the public message, then measure the counterparty's
accept-or-reject decision at fixed pre-offer state, optionally continued to
terminal league utility under the declared default-tolerant controllers.

Options:
  --message <id=path>       repeat for every arm's message bytes (at least two)
  --models <spec>           responder model, openrouter:<id> or prime:<id>
  --scripted <accept|reject> provider-free scripted responder instead of --models
  --scenario <id>           draft-league-v1 (default) or victory-road-top8-v1
  --seed <n>                synthetic circuit seed (default: 3)
  --node-index <n>          which trade_offer node in receipt order (default: 0)
  --to <entrant>            counterparty entrant (default: first valid found)
  --give <name>             offered mon name (default: first valid found)
  --get <name>              requested mon name (default: first valid found)
  --horizon <mode>          response (default) or terminal
  --reasoning <level>       minimal, low, medium, high, or xhigh
  --reasoning-max-tokens <n> explicit reasoning budget below --max-tokens
  --max-tokens <n>          output-token cap for the responder call (default: 8192)
  --timeout <seconds>       provider timeout (default: 600)
  --out <directory>         new or empty private report directory

Every arm binds identical terms, rationale, and notebook bytes; only the public
message varies. One node is one cluster and is never a ranking.`;

const RESPONDER_SYSTEM = [
  'You are the responding franchise coach in a controlled Pokémon VGC trade intervention.',
  'Decide using only the authorized state, standings, rosters, and offer in the prompt.',
  'Reply exactly as the prompt specifies.',
].join('\n');

const ARM_RATIONALE = 'Terms are stated in the offer.';
const ARM_NOTEBOOK = 'Window plan: evaluate the proposed swap on material terms.';

function integer(value: string, label: string, minimum = 1): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`--${label} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function reasoning(value: string | undefined): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  if (!isReasoningLevel(value)) throw new Error('--reasoning must be minimal, low, medium, high, or xhigh');
  return value;
}

function scenario(value: string): FrozenCircuitScenarioId {
  if (!(FROZEN_CIRCUIT_SCENARIOS as readonly string[]).includes(value)) {
    throw new Error(`--scenario must be one of ${FROZEN_CIRCUIT_SCENARIOS.join(', ')}`);
  }
  return value as FrozenCircuitScenarioId;
}

function messageArm(value: string): { id: string; file: string } {
  const split = value.indexOf('=');
  if (split <= 0 || split === value.length - 1) throw new Error('--message must be id=path');
  return { id: value.slice(0, split), file: path.resolve(value.slice(split + 1)) };
}

function offerResponse(terms: { to: number; give: string; get: string }, message: string): string {
  return JSON.stringify({
    offer: { to: terms.to, give: terms.give, get: terms.get, message },
    reasoning: ARM_RATIONALE,
    notebook: ARM_NOTEBOOK,
  });
}

function chosenTerms(input: { state: TradeWindowState; from: number; to?: number; give?: string; get?: string }): {
  to: number;
  give: string;
  get: string;
} {
  const order = tradeWindowOrder(input.state.standings);
  const counterparties = input.to === undefined ? order.filter((entrant) => entrant !== input.from) : [input.to];
  for (const to of counterparties) {
    const gives = input.give === undefined ? input.state.rosters[input.from]!.map((mon) => mon.name) : [input.give];
    const gets = input.get === undefined ? input.state.rosters[to]!.map((mon) => mon.name) : [input.get];
    for (const give of gives) {
      for (const get of gets) {
        const candidate = offerResponse({ to, give, get }, 'probe');
        if (typeof parseTradeOffer(candidate, input.state, input.from) !== 'string') return { to, give, get };
      }
    }
  }
  throw new Error('no valid offer terms satisfy the requested constraints at this node');
}

function writeCanonical(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`, { flag: 'wx' });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', default: false },
      message: { type: 'string', multiple: true },
      models: { type: 'string' },
      scripted: { type: 'string' },
      scenario: { type: 'string', default: 'draft-league-v1' },
      seed: { type: 'string', default: '3' },
      'node-index': { type: 'string', default: '0' },
      to: { type: 'string' },
      give: { type: 'string' },
      get: { type: 'string' },
      horizon: { type: 'string', default: 'response' },
      reasoning: { type: 'string' },
      'reasoning-max-tokens': { type: 'string' },
      'max-tokens': { type: 'string', default: '8192' },
      timeout: { type: 'string', default: '600' },
      out: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const messages = (values.message ?? []).map(messageArm);
  if (messages.length < 2) throw new Error('at least two --message arms are required');
  if (values.horizon !== 'response' && values.horizon !== 'terminal') {
    throw new Error('--horizon must be response or terminal');
  }
  const horizon = values.horizon as TradeForkHorizon;
  if (Boolean(values.models) === Boolean(values.scripted)) {
    throw new Error('exactly one of --models or --scripted is required');
  }
  if (values.scripted && values.scripted !== 'accept' && values.scripted !== 'reject') {
    throw new Error('--scripted must be accept or reject');
  }
  const reasoningLevel = reasoning(values.reasoning);
  const maxTokens = integer(values['max-tokens'], 'max-tokens');
  const reasoningMaxTokens =
    values['reasoning-max-tokens'] === undefined
      ? undefined
      : integer(values['reasoning-max-tokens'], 'reasoning-max-tokens');
  const timeoutSeconds = integer(values.timeout, 'timeout');
  const scenarioId = scenario(values.scenario);
  const seed = integer(values.seed, 'seed', 0);
  const nodeIndex = integer(values['node-index'], 'node-index', 0);
  const outputDirectory = path.resolve(
    values.out ?? path.join('runs', `trade-message-pilot-${new Date().toISOString().replace(/[:.]/gu, '-')}`),
  );
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length) {
    throw new Error(`trade message pilot output must be a new or empty directory: ${outputDirectory}`);
  }

  const terminal = completeDefaultDrivenCircuit(scenarioId, seed);
  const transcript = buildFrozenCircuitTerminalTranscript(terminal);
  const offerNodes = selectFrozenCircuitTradeReceipts(transcript, ['trade_offer']);
  const node = offerNodes[nodeIndex];
  if (!node)
    throw new Error(`synthetic circuit has ${offerNodes.length} trade_offer nodes; --node-index is out of range`);
  const state = terminal.privateEvidence.transactionState;
  if (!state) throw new Error('synthetic circuit terminal evidence has no transaction state');
  const from = tradeWindowOrder(state.standings)[nodeIndex];
  if (from === undefined) throw new Error('trade offer node does not join the window order');
  const terms = chosenTerms({
    state,
    from,
    ...(values.to === undefined ? {} : { to: integer(values.to, 'to', 0) }),
    ...(values.give === undefined ? {} : { give: values.give }),
    ...(values.get === undefined ? {} : { get: values.get }),
  });
  const checkpoint = buildFrozenCircuitTradeCheckpoint(transcript, node);
  const arms: MatchedTradeOfferArm[] = messages.map((message) => ({
    id: message.id,
    label: message.id,
    response: offerResponse(terms, fs.readFileSync(message.file, 'utf8').trim()),
  }));

  const calls: Array<Record<string, unknown>> = [];
  let responderControllerId: string;
  let responder: Parameters<typeof runMatchedTradeOfferForks>[0]['responder'];
  if (values.scripted) {
    responderControllerId = `scripted-${values.scripted}-v1`;
    responder = { respond: () => JSON.stringify({ accept: values.scripted === 'accept' }) };
  } else {
    const modelSpec = values.models as string;
    const provider = makeProvider(parseSpec(modelSpec), { reasoning: reasoningLevel });
    responderControllerId = canonicalJsonDigest([
      'trade-message-responder-v1',
      modelSpec,
      reasoningLevel ?? null,
      reasoningMaxTokens ?? null,
      maxTokens,
      RESPONDER_SYSTEM,
    ]);
    responder = {
      async respond({ turn }) {
        const started = Date.now();
        const completion = await provider.complete(RESPONDER_SYSTEM, [{ role: 'user', content: turn.prompt }], {
          maxTokens,
          ...(reasoningMaxTokens === undefined ? {} : { reasoningMaxTokens }),
          timeout: timeoutSeconds,
          temperature: 0,
          toolChoice: 'none',
        });
        calls.push({
          modelSpec,
          turnId: turn.turnId,
          promptDigest: canonicalJsonDigest(turn.prompt),
          prompt: turn.prompt,
          response: completion.text,
          reasoningText: completion.reasoning ?? null,
          usage: completion.usage,
          upstreamProvider: completion.provider ?? null,
          finishReason: completion.finishReason ?? null,
          latencyMs: Date.now() - started,
        });
        return completion.text;
      },
    };
  }

  const report = await runMatchedTradeOfferForks({
    checkpoint,
    arms,
    responder,
    responderControllerId,
    sourceReceiptCount: transcript.receipts.length,
    horizon,
    ...(horizon === 'terminal'
      ? {
          continuation: {
            controllers: defaultDriverContinuationControllers(),
            controllerId: 'default-driver-continuation-v1',
          },
        }
      : {}),
  });

  const artifactBase = {
    protocolVersion: FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.version,
    generatedAt: new Date().toISOString(),
    syntheticSource: {
      policy: FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.syntheticSource,
      scenarioId,
      seed,
      nodeIndex,
      transcriptDigest: transcript.transcriptDigest,
    },
    terms: { from, ...terms },
    report,
    calls,
    interpretation: 'matched-message-fork-one-node-one-cluster-no-ranking',
  };
  writeCanonical(path.join(outputDirectory, 'report.json'), {
    ...artifactBase,
    artifactDigest: canonicalJsonDigest(artifactBase),
  });
  for (const outcome of report.outcomes) {
    const terminalNote = outcome.terminal
      ? ` proposer-return=${String(outcome.terminal.proposerReturn)} responder-return=${String(outcome.terminal.responderReturn)}`
      : '';
    console.log(
      `${outcome.armId}: valid=${outcome.protocolValid} accepted=${String(outcome.responderAccepted)}${terminalNote}`,
    );
  }
  console.log(`private trade message pilot artifacts: ${outputDirectory}`);
  return report.outcomes.every((outcome) => outcome.protocolValid) ? 0 : 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    },
  );
}
