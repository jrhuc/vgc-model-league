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
  return artifact.kind === 'frozen' ? 'Frozen position candidate' : 'Position pilot';
}

function releaseLabel(artifact: ResearchArtifactView): string {
  if (artifact.releaseReady === null) return 'Unknown / untrusted';
  return artifact.releaseReady ? 'Release ready' : 'Not release ready';
}

function ArtifactSummary({ artifact }: { artifact: ResearchArtifactView }) {
  return (
    <article class={`panel research-artifact-summary research-artifact-${artifact.kind}`}>
      <header class="research-artifact-summary-header">
        <div>
          <p class="eyebrow">{artifactTitle(artifact)}</p>
          <h3>{artifact.status}</h3>
        </div>
        <span class={`research-status research-status-${artifact.validation.status}`}>
          {artifact.validation.status}
        </span>
      </header>
      <dl class="research-artifact-summary-state">
        <div>
          <dt>Release state</dt>
          <dd>{releaseLabel(artifact)}</dd>
        </div>
        <div>
          <dt>Verified task rows</dt>
          <dd>{artifact.taskTotal.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Task previews</dt>
          <dd>{artifact.taskPreviewAvailability}</dd>
        </div>
      </dl>
      {artifact.taskPreviewReason ? (
        <p class="muted research-task-availability-reason">
          Viewer policy: <code>{artifact.taskPreviewReason}</code>
        </p>
      ) : null}
      {artifact.validation.errors.length > 0 ? (
        <div class="message error research-validation-errors" role="alert">
          <b>Public artifact validation failed.</b>
          <ul>
            {artifact.validation.errors.map((error, index) => (
              <li key={`${index}:${error}`}>{error}</li>
            ))}
          </ul>
          <p>Rejected metadata and tasks are not treated as evidence.</p>
        </div>
      ) : null}
    </article>
  );
}

function ProgramState({ research, error }: { research: ResearchResponse | null; error: string }) {
  if (research) {
    return (
      <>
        <code>{research.program.positions.target}</code>
        <span>Program stage: {research.program.positions.stage}</span>
      </>
    );
  }
  return <span role="status">{error ? 'Program state unavailable' : 'Loading program state…'}</span>;
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
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'The research endpoint could not be decoded safely.');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div class="research-view research-overview-view">
      <header class="research-hero">
        <div class="research-hero-copy">
          <p class="eyebrow">Research overview</p>
          <h1>Controlled decisions first. Long-horizon play next.</h1>
          <p class="lede">
            VGC Model League studies local battle choices under declared references and follows planning from a shared
            draft into actual play. Artifact state stays separate from exploratory match outcomes.
          </p>
        </div>
        <nav class="research-hero-actions" aria-label="Research workspace actions">
          <button type="button" class="button primary research-action" onClick={onOpenPositions}>
            Open Position Lab
          </button>
          <button type="button" class="button research-action" onClick={onOpenDraftArchive}>
            Browse draft league archive
          </button>
        </nav>
      </header>

      <section class="research-roadmap-section" aria-labelledby="research-roadmap-title">
        <header class="research-section-header">
          <p class="eyebrow">Research roadmap</p>
          <h2 id="research-roadmap-title">From static positions to connected episodes</h2>
          <p class="lede">
            Each arm answers a different question. Neither a short rollout value, a proposed teambuilding test, nor a
            small league table is a general model ranking.
          </p>
        </header>
        <ol class="research-roadmap">
          <li class="panel research-roadmap-step research-roadmap-step-current">
            <span class="research-roadmap-index">01</span>
            <div>
              <p class="eyebrow">Static positions · build first</p>
              <h3>One public decision contract</h3>
              <p class="research-roadmap-state">
                <ProgramState research={research} error={error} />
              </p>
              <p>
                Give every model the same anonymized prompt and exhaustive legal action map, then look up its submitted
                action under a frozen, reference-relative score vector. This is the planned controlled release path
                through Prime and verifiers; every result remains relative to its declared reference and sampling
                budget.
              </p>
              <button type="button" class="text-link research-roadmap-link" onClick={onOpenPositions}>
                Inspect position artifacts →
              </button>
            </div>
          </li>
          <li class="panel research-roadmap-step research-roadmap-step-proposed">
            <span class="research-roadmap-index">02</span>
            <div>
              <p class="eyebrow">Standalone teambuilding · proposed arm</p>
              <h3>Build from the whole regulation</h3>
              <p class="research-roadmap-state research-proposal-state">
                <span>Proposed · not implemented or released</span>
              </p>
              <p>
                This arm would build a complete team from a regulation-wide pool, distinct from sets for ten drafted
                picks or piloting a real top-bracket team. Pokémon Showdown would enforce legality. A frozen, game-based
                opponent suite—not an LLM meta-team judge—would evaluate the submission.
              </p>
            </div>
          </li>
          <li class="panel research-roadmap-step research-roadmap-step-next">
            <span class="research-roadmap-index">03</span>
            <div>
              <p class="eyebrow">Draft Circuit · proposed environment</p>
              <h3>Carry commitments into played matches</h3>
              <p class="research-roadmap-state">
                {research ? (
                  <>
                    <code>{research.program.draftCircuit.target}</code>
                    <span>Program stage: {research.program.draftCircuit.stage}</span>
                  </>
                ) : (
                  <span role="status">{error ? 'Program state unavailable' : 'Loading program state…'}</span>
                )}
              </p>
              <p>
                The planned circuit adds multi-agent drafting, teambuilding, bring and lead choices, and linked
                cross-stage evidence around played battles. Existing draft leagues are exploratory archives, not this
                proposed environment and not a causal reward for a pick.
              </p>
              <button type="button" class="text-link research-roadmap-link" onClick={onOpenDraftArchive}>
                Browse current draft league archive →
              </button>
            </div>
          </li>
        </ol>
        <aside class="panel research-referee-boundary">
          <p class="eyebrow">Rules boundary</p>
          <h3>Pokémon Showdown remains authoritative</h3>
          <p>
            Implemented and proposed tracks directly reuse the pinned simulator for legal state and transitions. The
            research layers define tasks, references, opponent suites, stages, and evidence joins; they do not replace
            its battle rules.
          </p>
        </aside>
      </section>

      <section class="research-artifacts-section" aria-labelledby="research-artifacts-title">
        <header class="research-section-header">
          <p class="eyebrow">Program and artifact status</p>
          <h2 id="research-artifacts-title">What is actually available</h2>
          <p class="lede">
            This compact index reports the validated public boundary. Position Lab owns detailed task, protocol,
            provenance, split, count, and gate inspection.
          </p>
        </header>

        {error ? (
          <div class="message error research-load-error" role="alert">
            <b>Research state unavailable.</b> {error}
          </div>
        ) : !research ? (
          <p class="muted research-loading" role="status" aria-live="polite">
            Loading public research state…
          </p>
        ) : (
          <>
            <dl class="research-state-summary">
              <div class="research-state-item">
                <dt>Endpoint state</dt>
                <dd>{research.status}</dd>
              </div>
              <div class="research-state-item">
                <dt>Index schema</dt>
                <dd>v{research.schemaVersion}</dd>
              </div>
              <div class="research-state-item">
                <dt>Position program</dt>
                <dd>{research.program.positions.stage}</dd>
              </div>
              <div class="research-state-item">
                <dt>Draft Circuit</dt>
                <dd>{research.program.draftCircuit.stage}</dd>
              </div>
              <div class="research-state-item">
                <dt>Public artifacts</dt>
                <dd>{research.artifacts.length.toLocaleString()}</dd>
              </div>
            </dl>

            {research.errors.length > 0 ? (
              <div class="message error research-root-errors" role="alert">
                <b>Some public artifact roots could not be validated.</b>
                <ul>
                  {research.errors.map((entry, index) => (
                    <li key={`${index}:${entry}`}>{entry}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {research.warnings.length > 0 ? (
              <aside class="panel research-root-warnings" aria-label="Research artifact warnings">
                <b>Artifact boundary notes</b>
                <ul>
                  {research.warnings.map((warning, index) => (
                    <li key={`${index}:${warning}`}>{warning}</li>
                  ))}
                </ul>
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
                <h3>No public position artifact is available</h3>
                <p>
                  The public boundary returned no pilot or frozen candidate. No task or release claim is made here;
                  archived runs remain exploratory evidence.
                </p>
              </div>
            )}

            {research.legacyPositions.present ? (
              <aside class="panel research-legacy-inventory">
                <p class="eyebrow">Legacy position inventory</p>
                <h3>{research.legacyPositions.rows.toLocaleString()} exploratory rows</h3>
                <p>
                  These rows are not manifest-bound. They are inventory, not a release artifact, benchmark, score, or
                  ranking.
                </p>
              </aside>
            ) : null}
          </>
        )}
      </section>

      <section class="research-workspace-links" aria-labelledby="research-workspace-links-title">
        <header class="research-section-header">
          <p class="eyebrow">Continue in the workspace</p>
          <h2 id="research-workspace-links-title">Inspect, observe, or operate</h2>
        </header>
        <div class="research-link-grid">
          <article class="panel research-link-card research-link-research">
            <h3>Research archives</h3>
            <p>Inspect controlled position artifacts or browse exploratory draft league trajectories.</p>
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
            <h3>Observe</h3>
            <p>Follow the current referee state or inspect recorded tournament brackets.</p>
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
            <h3>Operate</h3>
            <p>Configure a run. Sign-in and role checks apply only when an operation requires them.</p>
            <button type="button" class="button" onClick={onNewRun}>
              New run
            </button>
          </article>
        </div>
      </section>
    </div>
  );
}
