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
  'not-generated': 'No position tasks available',
  pilot: 'Pilot position tasks available',
  candidate: 'Candidate position tasks available',
  invalid: 'Position data unavailable',
};

const METHOD = [
  {
    index: '01',
    eyebrow: 'Fork',
    title: 'Reproduce the recorded position',
    body: 'Replay the source game from its recorded format, Showdown revision, seed, teams, and actions. Reject the position unless the replay reproduces the stored log.',
  },
  {
    index: '02',
    eyebrow: 'Panel',
    title: 'Evaluate accepted candidate actions',
    body: 'Fork the reproduced position for each Showdown-accepted action from the frozen candidate protocol. Use common opponent-action draws and battle seeds within each panel, independent panels for eligibility, and a separate panel for reward values.',
  },
  {
    index: '03',
    eyebrow: 'Reward',
    title: 'Compute the normalized reward',
    body: 'Normalize each action’s measurement-panel mean over the task’s measured minimum-to-maximum span. The recorded match result is not part of the reward.',
  },
] as const;

const CIRCUIT = [
  'Anonymous seats draft from a shared board in snake order under a budget.',
  'Each seat converts its roster into complete legal matchup teams.',
  'Each seat selects its bring and lead.',
  'Each matchup is recorded as a best-of-three series.',
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
          <h1>Explore how language models play VGC.</h1>
          <p class="lede">
            Compare choices in replayable Pokémon Showdown positions, and inspect complete draft, teambuild, bring,
            lead, and battle records.
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
          <h2 id="research-method-title">Position-task evaluation</h2>
          <p class="lede">
            Reproduce a position, evaluate its accepted candidate actions, and freeze the measured reward.
          </p>
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
          <p class="eyebrow">Reference</p>
          <h3>Rewards are relative to the prototype reference</h3>
          <p>
            The reference uses short-horizon material differential, sampled uniform Showdown-accepted candidate opponent
            actions, and uniform-random continuations. It evaluates the realized hidden state and does not estimate
            optimal play.
          </p>
        </aside>
      </section>

      <section class="research-roadmap-section" aria-labelledby="research-circuit-title">
        <header class="research-section-header">
          <p class="eyebrow">Draft circuit</p>
          <h2 id="research-circuit-title">Draft-circuit stages</h2>
          <p class="lede">
            A legal draft pick has no direct quality label. Drafting, teambuilding, bring and lead choices, and battles
            remain one episode.
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
          Draft picks, built teams, bring choices, and battle decisions remain linked. Standings describe one league and
          are not model rankings.
        </p>
      </section>

      <section class="research-artifacts-section" aria-labelledby="research-state-title">
        <header class="research-section-header">
          <p class="eyebrow">Position data</p>
          <h2 id="research-state-title">Availability</h2>
          <p class="lede">No public task package, calibrated reward, or validated benchmark has been released.</p>
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
                <dt>Task previews</dt>
                <dd>{previewCount.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Evaluation results</dt>
                <dd>Unavailable</dd>
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
          <p class="eyebrow">More</p>
          <h2 id="research-links-title">Browse, watch, or start a run</h2>
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
