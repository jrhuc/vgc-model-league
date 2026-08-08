import { useEffect, useState } from 'preact/hooks';

import type { ResearchArtifactView, ResearchResponse } from '../../api';
import { api } from '../http';
import { decodeResearchResponse } from '../lib/research-response';

interface ResearchOverviewProps {
  onOpenPositions: () => void;
  onOpenDraftArchive: () => void;
  onOpenLive: () => void;
  onOpenTournaments: () => void;
  onNewRun: () => void;
}

function artifactTitle(artifact: ResearchArtifactView): string {
  return artifact.kind === 'frozen' ? 'Frozen position set' : 'Position pilot';
}

function artifactStatus(artifact: ResearchArtifactView): string {
  if (artifact.validation.status === 'invalid') return 'Unavailable';
  if (artifact.taskTotal === 0) return 'Available · no tasks';
  return 'Available';
}

function previewStatus(artifact: ResearchArtifactView): string {
  if (artifact.taskPreviewAvailability === 'available') {
    return `${artifact.taskPreviewCount.toLocaleString()} available`;
  }
  return 'Unavailable';
}

function positionStatus(research: ResearchResponse): string {
  if (research.program.positions.stage === 'pilot') return 'Pilot tasks available';
  if (research.program.positions.stage === 'candidate') return 'Position tasks available';
  return 'Unavailable';
}

function ArtifactSummary({ artifact }: { artifact: ResearchArtifactView }) {
  return (
    <article class={`panel research-artifact-summary research-artifact-${artifact.kind}`}>
      <header class="research-artifact-summary-header">
        <div>
          <p class="eyebrow">{artifactTitle(artifact)}</p>
          <h3>{artifactStatus(artifact)}</h3>
        </div>
        <span class={`research-status research-status-${artifact.validation.status}`}>
          {artifact.validation.status === 'valid' ? 'Available' : 'Unavailable'}
        </span>
      </header>
      <dl class="research-artifact-summary-state">
        <div>
          <dt>Tasks listed</dt>
          <dd>{artifact.taskTotal.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Task previews</dt>
          <dd>{previewStatus(artifact)}</dd>
        </div>
        <div>
          <dt>Evaluation results</dt>
          <dd>Unavailable</dd>
        </div>
      </dl>
      {artifact.taskPreviewReason ? (
        <p class="muted research-task-availability-reason">Task previews are unavailable on this deployment.</p>
      ) : null}
      {artifact.validation.errors.length > 0 ? (
        <div class="message error research-validation-errors" role="alert">
          <b>This position set could not be loaded.</b>
          <p>Open Position Lab for technical details.</p>
        </div>
      ) : null}
    </article>
  );
}

function ProgramState({ research, error }: { research: ResearchResponse | null; error: string }) {
  if (research) return <span>{positionStatus(research)}</span>;
  return <span role="status">{error ? 'Position data unavailable' : 'Loading position data…'}</span>;
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

  return (
    <div class="research-view research-overview-view">
      <header class="research-hero">
        <div class="research-hero-copy">
          <p class="eyebrow">VGC Model League</p>
          <h1>Explore how language models play VGC.</h1>
          <p class="lede">
            Browse position tasks, draft leagues, tournaments, and live runs. Each page states which data is available.
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

      <section class="research-roadmap-section" aria-labelledby="research-roadmap-title">
        <header class="research-section-header">
          <p class="eyebrow">Explore</p>
          <h2 id="research-roadmap-title">Choose a place to start</h2>
          <p class="lede">Inspect individual decisions, follow full seasons, or watch battles as they run.</p>
        </header>
        <ol class="research-roadmap">
          <li class="panel research-roadmap-step research-roadmap-step-current">
            <span class="research-roadmap-index">01</span>
            <div>
              <p class="eyebrow">Position tasks</p>
              <h3>Review a single decision</h3>
              <p class="research-roadmap-state">
                <ProgramState research={research} error={error} />
              </p>
              <p>
                Open a task to read the prompt and its legal actions. Evaluation results are not available in this GUI.
              </p>
              <button type="button" class="text-link research-roadmap-link" onClick={onOpenPositions}>
                Open Position Lab →
              </button>
            </div>
          </li>
          <li class="panel research-roadmap-step research-roadmap-step-proposed">
            <span class="research-roadmap-index">02</span>
            <div>
              <p class="eyebrow">Draft leagues</p>
              <h3>Follow a complete season</h3>
              <p class="research-roadmap-state research-proposal-state">
                <span>Recorded seasons available</span>
              </p>
              <p>Review draft picks, matchup teams, battle decisions, and results from recorded leagues.</p>
              <button type="button" class="text-link research-roadmap-link" onClick={onOpenDraftArchive}>
                Browse draft leagues →
              </button>
            </div>
          </li>
          <li class="panel research-roadmap-step research-roadmap-step-next">
            <span class="research-roadmap-index">03</span>
            <div>
              <p class="eyebrow">Live and recorded play</p>
              <h3>Watch battles turn by turn</h3>
              <p class="research-roadmap-state">
                <span>Shown when runs are available</span>
              </p>
              <p>Follow an active run or open a recorded tournament bracket and its battle logs.</p>
              <button type="button" class="text-link research-roadmap-link" onClick={onOpenLive}>
                Open live run →
              </button>
            </div>
          </li>
        </ol>
        <aside class="panel research-referee-boundary">
          <p class="eyebrow">Battle rules</p>
          <h3>Pokémon Showdown resolves every game</h3>
          <p>The GUI displays recorded choices and outcomes from the pinned simulator.</p>
        </aside>
      </section>

      <section class="research-artifacts-section" aria-labelledby="research-artifacts-title">
        <header class="research-section-header">
          <p class="eyebrow">Position data</p>
          <h2 id="research-artifacts-title">Availability</h2>
          <p class="lede">Missing task files and results are shown as unavailable.</p>
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
                <dd>{positionStatus(research)}</dd>
              </div>
              <div class="research-state-item">
                <dt>Task sets</dt>
                <dd>{research.artifacts.length.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Task previews</dt>
                <dd>{previewCount.toLocaleString()}</dd>
              </div>
              <div class="research-state-item">
                <dt>Older position rows</dt>
                <dd>{research.legacyPositions.present ? research.legacyPositions.rows.toLocaleString() : '0'}</dd>
              </div>
              <div class="research-state-item">
                <dt>Evaluation results</dt>
                <dd>Unavailable</dd>
              </div>
            </dl>

            {research.errors.length > 0 ? (
              <div class="message error research-root-errors" role="alert">
                <b>Some position data is unavailable.</b>
                <p>Open Position Lab for technical details.</p>
              </div>
            ) : null}

            {research.warnings.length > 0 ? (
              <aside class="panel research-root-warnings" aria-label="Position data notices">
                <b>Some position data needs attention.</b>
                <p>Open Position Lab for technical details.</p>
              </aside>
            ) : null}

            {research.artifacts.length > 0 ? (
              <div class="research-artifact-summary-list">
                {research.artifacts.map((artifact) => (
                  <ArtifactSummary artifact={artifact} key={artifact.kind} />
                ))}
              </div>
            ) : (
              <div class="panel research-empty-state">
                <h3>No position tasks are available</h3>
                <p>This server has no browsable position-task files. Evaluation results are also unavailable.</p>
              </div>
            )}

            {research.legacyPositions.present ? (
              <aside class="panel research-legacy-inventory">
                <p class="eyebrow">Older position data</p>
                <h3>{research.legacyPositions.rows.toLocaleString()} rows found</h3>
                <p>Task details and evaluation results are unavailable for these rows.</p>
              </aside>
            ) : null}
          </>
        )}
      </section>

      <section class="research-workspace-links" aria-labelledby="research-workspace-links-title">
        <header class="research-section-header">
          <p class="eyebrow">More</p>
          <h2 id="research-workspace-links-title">Browse, watch, or start a run</h2>
        </header>
        <div class="research-link-grid">
          <article class="panel research-link-card research-link-research">
            <h3>Browse</h3>
            <p>Open position tasks or recorded draft leagues.</p>
            <div class="research-link-actions">
              <button type="button" class="button" onClick={onOpenPositions}>
                Position Lab
              </button>
              <button type="button" class="button" onClick={onOpenDraftArchive}>
                Draft leagues
              </button>
            </div>
          </article>
          <article class="panel research-link-card research-link-observe">
            <h3>Watch</h3>
            <p>Follow an active run or inspect recorded tournament brackets.</p>
            <div class="research-link-actions">
              <button type="button" class="button" onClick={onOpenLive}>
                Live run
              </button>
              <button type="button" class="button" onClick={onOpenTournaments}>
                Tournaments
              </button>
            </div>
          </article>
          <article class="panel research-link-card research-link-operate">
            <h3>Start</h3>
            <p>Choose models, teams, and run settings.</p>
            <button type="button" class="button" onClick={onNewRun}>
              New run
            </button>
          </article>
        </div>
      </section>
    </div>
  );
}
