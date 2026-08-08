import { useEffect, useState } from 'preact/hooks';

import type { ResearchResponse } from '../../api';
import { api } from '../http';
import { decodeResearchResponse } from '../lib/research-response';

interface ResearchOverviewProps {
  onOpenPositions: () => void;
  onOpenDraftArchive: () => void;
  onOpenLive: () => void;
  onOpenTournaments: () => void;
  onNewRun: () => void;
}

const POSITION_STAGE: Record<ResearchResponse['program']['positions']['stage'], string> = {
  'not-generated': 'No task sets exported',
  pilot: 'Pilot task sets exported',
  candidate: 'Candidate task sets frozen',
  invalid: 'Task sets present but unreadable',
};

const METHOD = [
  {
    index: '01',
    eyebrow: 'Fork',
    title: 'Replay the game, stop at one choice',
    body: 'A recorded game is replayed from its format, Showdown revision, seed, teams, and actions. A run that does not reproduce its stored log is refused, so the position is provably the one that was played.',
  },
  {
    index: '02',
    eyebrow: 'Panel',
    title: 'Play every legal action from there',
    body: 'The position forks once per Showdown-accepted joint action, across shared opponent draws and battle seeds. Two panels decide whether the position separates actions at all; a third, untouched panel supplies the values.',
  },
  {
    index: '03',
    eyebrow: 'Reward',
    title: 'Score the choice against its alternatives',
    body: 'Each action is normalised across the measured spread, so the reward is what the choice cost against what the position had on offer — not whether the game was later won.',
  },
] as const;

const CIRCUIT = [
  'Anonymous seats draft one shared board in snake order under a budget.',
  'Each seat turns its roster into complete legal matchup teams.',
  'Seats choose what to bring and what to lead.',
  'The teams play recorded best-of-three battles.',
] as const;

function ProgramState({ research, error }: { research: ResearchResponse | null; error: string }) {
  if (research) return <span>{POSITION_STAGE[research.program.positions.stage]}</span>;
  return <span role="status">{error ? 'Position data unavailable' : 'Loading…'}</span>;
}

export function ResearchOverviewView({
  onOpenPositions,
  onOpenDraftArchive,
  onOpenLive,
  onOpenTournaments,
  onNewRun,
}: ResearchOverviewProps) {
  const [research, setResearch] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api<unknown>('/api/research')
      .then(decodeResearchResponse)
      .then((response) => {
        if (active) setResearch(response);
      })
      .catch(() => {
        if (active) setError('Position data could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, []);

  const previewCount = research?.artifacts.reduce((total, artifact) => total + artifact.taskPreviewCount, 0) ?? 0;
  const taskTotal = research?.artifacts.reduce((total, artifact) => total + artifact.taskTotal, 0) ?? 0;

  return (
    <div class="research-view research-overview-view">
      <header class="research-hero">
        <div class="research-hero-copy">
          <p class="eyebrow">VGC Model League</p>
          <h1>Grade the decision, not the scoreboard.</h1>
          <p class="lede">
            Language models draft, build, and play Pokémon VGC on a pinned Showdown simulator. Because the simulator
            forks, a single choice can be replayed against every legal alternative it had.
          </p>
        </div>
        <nav class="research-hero-actions" aria-label="Featured pages">
          <button type="button" class="button primary research-action" onClick={onOpenPositions}>
            Open Position Lab
          </button>
          <button type="button" class="button research-action" onClick={onOpenDraftArchive}>
            Browse draft leagues
          </button>
        </nav>
      </header>

      <section class="research-roadmap-section" aria-labelledby="research-method-title">
        <header class="research-section-header">
          <p class="eyebrow">Method</p>
          <h2 id="research-method-title">How a choice gets a number</h2>
          <p class="lede">A win or a loss is one bit, and a critical hit can flip it. The forked position is denser.</p>
        </header>
        <ol class="research-roadmap">
          {METHOD.map((step) => (
            <li class="panel research-roadmap-step" key={step.index}>
              <span class="research-roadmap-index">{step.index}</span>
              <div>
                <p class="eyebrow">{step.eyebrow}</p>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <aside class="panel research-referee-boundary">
          <p class="eyebrow">Reference limits</p>
          <h3>These values are reference-relative, not optimal play</h3>
          <p>
            The current reference is short-horizon material differential under uniform opponent actions and
            uniform-random continuations, and it sees the realized hidden state. It is a diagnostic, not a solver.
          </p>
        </aside>
      </section>

      <section class="research-roadmap-section" aria-labelledby="research-circuit-title">
        <header class="research-section-header">
          <p class="eyebrow">Draft circuit</p>
          <h2 id="research-circuit-title">One season, one episode</h2>
          <p class="lede">
            A pick has no cheap quality oracle, so the episode stays intact rather than inventing a per-pick label.
          </p>
        </header>
        <ol class="research-circuit">
          {CIRCUIT.map((stage, index) => (
            <li key={stage}>
              <span class="research-circuit-index">{index + 1}</span>
              <span>{stage}</span>
            </li>
          ))}
        </ol>
        <p class="research-circuit-note">
          What a model drafted, what it built, and what it brought are recorded links, so a plan can be checked against
          the play that followed. Standings describe one league; they are never aggregated into a ranking.
        </p>
      </section>

      <section class="research-artifacts-section" aria-labelledby="research-state-title">
        <header class="research-section-header">
          <p class="eyebrow">Status</p>
          <h2 id="research-state-title">What this server holds</h2>
          <p class="lede">
            No public task package, calibrated reward, or validated benchmark has been released. Everything here is
            exploratory.
          </p>
        </header>

        {error ? (
          <div class="message error research-load-error" role="alert">
            <b>Position data unavailable.</b> {error}
          </div>
        ) : !research ? (
          <p class="muted research-loading" role="status" aria-live="polite">
            Loading position data…
          </p>
        ) : (
          <>
            <dl class="research-state-summary">
              <div class="research-state-item">
                <dt>Position tasks</dt>
                <dd>
                  <ProgramState research={research} error={error} />
                </dd>
              </div>
              <div class="research-state-item">
                <dt>Task sets</dt>
                <dd>{research.artifacts.length.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Tasks listed</dt>
                <dd>{taskTotal.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Prompt previews</dt>
                <dd>{previewCount.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Evaluation results</dt>
                <dd>None</dd>
              </div>
            </dl>

            {research.errors.length > 0 ? (
              <div class="message error research-root-errors" role="alert">
                <b>Some position data could not be read.</b> Open Position Lab for details.
              </div>
            ) : null}

            {research.warnings.length > 0 ? (
              <aside class="notice-strip research-root-warnings" aria-label="Position data notices">
                <b>Some position data needs attention.</b> Open Position Lab for details.
              </aside>
            ) : null}

            {research.legacyPositions.present ? (
              <p class="muted research-legacy-note">
                {research.legacyPositions.rows.toLocaleString()} older position rows are on disk without a bound
                manifest. They are counted, not served.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section class="research-workspace-links" aria-labelledby="research-links-title">
        <header class="research-section-header">
          <p class="eyebrow">Go to</p>
          <h2 id="research-links-title">Everywhere else</h2>
        </header>
        <div class="research-destinations">
          <button type="button" class="button" onClick={onOpenPositions}>
            Position Lab
          </button>
          <button type="button" class="button" onClick={onOpenDraftArchive}>
            Draft leagues
          </button>
          <button type="button" class="button" onClick={onOpenLive}>
            Live run
          </button>
          <button type="button" class="button" onClick={onOpenTournaments}>
            Tournaments
          </button>
          <button type="button" class="button" onClick={onNewRun}>
            New run
          </button>
        </div>
      </section>
    </div>
  );
}
