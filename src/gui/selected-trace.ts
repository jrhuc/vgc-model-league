import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../paths.js';
import type { SelectedTraceQuoteView, SelectedTraceView } from './api.js';

const BUNDLE_DIRECTORY = path.join(REPO_ROOT, 'artifacts', 'public', 'landing', 'circuit-trace-v1');

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be nonempty text`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function texts(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) => text(entry, `${label}[${index}]`));
}

function same(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} does not match the corresponding full event`);
  }
}

function readRegularFile(directory: string, name: string): Buffer {
  const root = path.resolve(directory);
  const file = path.resolve(root, name);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`${name} escapes the selected-trace bundle`);
  const directoryStat = fs.lstatSync(root);
  const fileStat = fs.lstatSync(file);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('selected-trace bundle must be a regular directory');
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${name} must be a regular file`);
  const realRoot = fs.realpathSync.native(root);
  const realFile = fs.realpathSync.native(file);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${name} escapes the selected-trace bundle`);
  const descriptor = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${name} must be a regular file`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBundle(directory: string): {
  curated: Record<string, unknown>;
  full: Record<string, unknown>;
  fullJson: Buffer;
} {
  const manifest = record(JSON.parse(readRegularFile(directory, 'manifest.json').toString('utf8')), 'manifest');
  const artifacts = record(manifest.artifacts, 'manifest.artifacts');
  const load = (name: 'curated' | 'full') => {
    const entry = record(artifacts[name], `manifest.artifacts.${name}`);
    const file = `${name}.json`;
    if (entry.path !== file) throw new Error(`manifest.artifacts.${name}.path must be ${file}`);
    const bytes = readRegularFile(directory, file);
    if (createHash('sha256').update(bytes).digest('hex') !== text(entry.sha256, `${name} sha256`)) {
      throw new Error(`${file} does not match its manifest SHA-256`);
    }
    return { value: record(JSON.parse(bytes.toString('utf8')), file), bytes };
  };
  const curated = load('curated');
  const full = load('full');
  return { curated: curated.value, full: full.value, fullJson: full.bytes };
}

function fact(value: Record<string, unknown>, name: string): unknown {
  const matches = array(record(value.refereeEvidence, 'refereeEvidence').facts, 'refereeEvidence.facts')
    .map((entry, index) => record(entry, `refereeEvidence.facts[${index}]`))
    .filter((entry) => entry.name === name);
  if (matches.length !== 1) throw new Error(`event must contain exactly one referee fact ${name}`);
  return matches[0]!.value;
}

function event(events: unknown[], stage: string, name: string): Record<string, unknown> {
  const matches = events
    .map((entry, index) => record(entry, `full.events[${index}]`))
    .filter((entry) => entry.stage === stage && entry.event === name);
  if (matches.length !== 1) throw new Error(`full artifact must contain exactly one ${stage}/${name} event`);
  return matches[0]!;
}

function submission(value: Record<string, unknown>, label: string): Record<string, unknown> {
  return record(value.seatSubmission, `${label}.seatSubmission`);
}

function excerpt(value: unknown, label: string, stage: string, source: string): SelectedTraceQuoteView {
  const excerptText = text(record(value, label).text, `${label}.text`);
  if (!source.startsWith(excerptText)) throw new Error(`${label}.text does not match the corresponding full event`);
  return { stage, text: excerptText };
}

function speciesId(name: string): string {
  const id = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '');
  const mega = /^Mega (.+)$/u.exec(name);
  const tauros = /^Paldean Tauros (Aqua|Blaze)$/u.exec(name);
  if (mega) return `${id(mega[1]!)}-mega`;
  return tauros ? `tauros-paldea-${tauros[1]!.toLowerCase()}` : id(name);
}

function choices(command: string, registered: readonly string[]): string[] {
  const match = /^team (\d(?:\d| )*)$/u.exec(command);
  if (!match) throw new Error('team-preview submission has an unexpected command');
  return match[1]!
    .replaceAll(' ', '')
    .split('')
    .map((choice) => {
      const member = registered[Number(choice) - 1];
      if (!member) throw new Error('team-preview submission references an unregistered member');
      return member;
    });
}

function promptActives(section: string) {
  return [...section.matchAll(/^- ([^;\n]+);[^\n]*active slot ([ab]);[^\n]*moves ([^;]+);/gmu)]
    .map((match) => ({
      name: match[1]!,
      slot: match[2]!,
      moves: match[3]!.split(', ').map((description) => ({
        name: description.split(' [', 1)[0]!,
        spread: description.includes('/spread'),
      })),
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

function actionLabels(prompt: string, command: string): string[] {
  const split = prompt.indexOf('Opponent side conditions:');
  if (split < 0) throw new Error('battle prompt is missing opponent-side state');
  const own = promptActives(prompt.slice(0, split));
  const foes = promptActives(prompt.slice(split));
  const commands = command.split(', ');
  if (commands.length !== own.length) throw new Error('battle command does not match the active slots');
  return commands.map((choice, index) => {
    const match = /^move (\d+)(?: ([+-]\d+))?$/u.exec(choice);
    if (!match) throw new Error(`battle command choice ${index} is not a move`);
    const actor = own[index]!;
    const move = actor.moves[Number(match[1]) - 1];
    if (!move) throw new Error(`battle command choice ${index} references an unavailable move`);
    const target = match[2]?.startsWith('+') ? foes[Number(match[2].slice(1)) - 1] : undefined;
    const suffix = move.spread ? ' (both foes)' : target ? ` into ${target.name}` : '';
    return `${actor.name} — ${move.name}${suffix}`;
  });
}

export function loadSelectedTrace(directory = BUNDLE_DIRECTORY): { view: SelectedTraceView; fullJson: Buffer } {
  const { curated, full, fullJson } = readBundle(directory);
  for (const key of ['traceId', 'seatAlias', 'format'] as const) {
    if (curated[key] !== full[key]) throw new Error(`selected artifact ${key} values do not match`);
  }
  const stages = record(curated.stages, 'curated.stages');
  const events = array(full.events, 'full.events');
  const curatedPicks = array(record(stages.draft, 'curated draft').picks, 'curated draft picks');
  if (curatedPicks.length !== 2) throw new Error('selected artifact must contain two rendered draft picks');
  const draftEvents = events
    .map((value, index) => record(value, `full.events[${index}]`))
    .filter((value) => value.stage === 'draft' && value.event === 'pick');
  const draftQuotes = curatedPicks.map((value, index) => {
    const pick = record(value, `curated draft pick ${index}`);
    const name = text(pick.name, `curated draft pick ${index}.name`);
    const matches = draftEvents.filter((candidate) => fact(candidate, 'acceptedName') === name);
    if (matches.length !== 1) throw new Error(`full artifact must contain exactly one draft event for ${name}`);
    const fullEvent = matches[0]!;
    const output = submission(fullEvent, `${name} draft event`);
    if (output.status !== 'recorded' || flag(fact(fullEvent, 'fallback'), `${name} fallback`)) {
      throw new Error(`${name} draft excerpt is not recorded model output`);
    }
    return {
      pick: integer(fact(fullEvent, 'pick'), `${name} pick number`),
      ...excerpt(pick.quote, `curated draft pick ${index}.quote`, name, text(output.rationale, `${name} rationale`)),
    };
  });

  const construction = record(stages.construction, 'curated construction');
  const constructionEvent = event(events, 'construction', 'matchup-six');
  const registered = texts(fact(constructionEvent, 'registeredDraftedSix'), 'registeredDraftedSix');
  const registeredSix = texts(construction.registered, 'curated construction.registered');
  same(registeredSix.map(speciesId), registered, 'curated registered six');
  same(
    text(submission(constructionEvent, 'construction').submittedAction, 'construction action').split(', '),
    registered,
    'construction submission',
  );

  const preview = record(stages.teamPreview, 'curated team preview');
  const previewEvent = event(events, 'teamPreview', 'bring-and-lead');
  const previewOutput = submission(previewEvent, 'team preview');
  const previewCommand = text(previewOutput.submittedAction, 'team-preview action');
  if (previewCommand !== fact(previewEvent, 'submittedAction'))
    throw new Error('team-preview submission does not match its referee fact');
  const lead = texts(preview.lead, 'curated teamPreview.lead');
  const back = texts(preview.back, 'curated teamPreview.back');
  same([...lead, ...back].map(speciesId), choices(previewCommand, registered), 'curated bring and lead');

  const firstAction = event(events, 'battle', 'first-action');
  const visible = record(firstAction.seatVisibleAtDecision, 'battle input');
  const battleOutput = submission(firstAction, 'battle');
  const prompt = text(visible.prompt, 'battle prompt');
  const incomingNotebook = text(visible.notebook, 'battle incoming notebook');
  if (text(previewOutput.notebook, 'preview notebook') !== incomingNotebook) {
    throw new Error('team-preview submission notebook does not equal the battle decision notebook input');
  }
  const updatedNotebook = text(battleOutput.notebook, 'battle updated notebook');
  if (!updatedNotebook.startsWith(incomingNotebook))
    throw new Error('battle output notebook does not preserve its input');
  if (
    battleOutput.status !== 'recorded' ||
    flag(fact(firstAction, 'fallback'), 'battle fallback') ||
    flag(fact(firstAction, 'automatic'), 'battle automatic')
  ) {
    throw new Error('battle action is not recorded model output');
  }
  const submittedCommand = text(battleOutput.submittedAction, 'battle submitted action');
  if (submittedCommand !== fact(firstAction, 'submittedAction'))
    throw new Error('battle submission does not match its referee fact');
  const firstActions = actionLabels(prompt, submittedCommand);
  same(
    texts(record(stages.battle, 'curated battle').actions, 'curated battle actions'),
    firstActions,
    'curated battle actions',
  );
  const transaction = record(stages.transactionWindow, 'curated transaction window');
  const offer = record(transaction.offer, 'curated transaction offer');
  const offerEvent = event(events, 'transactionWindow', 'offer-declined');
  const offerAction = record(
    JSON.parse(text(submission(offerEvent, 'offer').submittedAction, 'offer action')),
    'offer action',
  );
  const give = text(offer.give, 'curated offer.give');
  const get = text(offer.get, 'curated offer.get');
  if (
    speciesId(give) !== offerAction.give ||
    speciesId(get) !== offerAction.get ||
    offer.status !== 'declined' ||
    flag(offerAction.accepted, 'offer accepted') ||
    flag(fact(offerEvent, 'offerAccepted'), 'offer referee acceptance')
  ) {
    throw new Error('curated transaction offer does not match the recorded declined offer');
  }
  const swaps = array(transaction.changes, 'curated transaction changes').map((value, index) => {
    const swap = record(value, `curated transaction change ${index}`);
    return { drop: text(swap.drop, `swap ${index}.drop`), add: text(swap.add, `swap ${index}.add`) };
  });
  const freeEvent = event(events, 'transactionWindow', 'free-agency-decision');
  const freeAction = record(
    JSON.parse(text(submission(freeEvent, 'free agency').submittedAction, 'free-agency action')),
    'free-agency action',
  );
  const fullSwaps = array(freeAction.swaps, 'free-agency swaps').map((value, index) => {
    const swap = record(value, `free-agency swap ${index}`);
    return `${text(swap.drop, 'swap drop')}>${text(swap.add, 'swap add')}`;
  });
  same(
    swaps.map((swap) => `${speciesId(swap.drop)}>${speciesId(swap.add)}`),
    fullSwaps,
    'curated free-agent swaps',
  );

  const terminal = record(stages.terminalReview, 'curated terminal review');
  const terminalEvent = event(events, 'terminalReview', 'season-retrospective');
  if (
    !flag(fact(terminalEvent, 'recorded'), 'terminal recorded') ||
    flag(fact(terminalEvent, 'fallback'), 'terminal fallback')
  ) {
    throw new Error('terminal excerpt is not recorded model output');
  }
  const statement = text(record(terminalEvent.postrunGenerated, 'terminal output').statement, 'terminal statement');

  const view: SelectedTraceView = {
    traceId: text(curated.traceId, 'curated.traceId'),
    seatAlias: text(curated.seatAlias, 'curated.seatAlias'),
    format: text(curated.format, 'curated.format'),
    eventCount: events.length,
    draftQuotes,
    registeredSix,
    lead,
    back,
    firstActions,
    transaction: { declinedOffer: { give, get }, swaps },
    terminalQuote: excerpt(terminal.quote, 'curated terminal quote', 'Selected terminal review output', statement),
    turn: {
      promptExcerpt: `${prompt.split('\n').slice(0, 7).join('\n')}\n`,
      incomingNotebook,
      rationale: text(battleOutput.rationale, 'battle rationale'),
      submittedCommand,
      replayAccepted: flag(fact(firstAction, 'actionAcceptedInExactReplay'), 'replay accepted'),
      choiceIndex: integer(fact(firstAction, 'choiceIndex'), 'choice index'),
    },
  };
  return { view, fullJson };
}
