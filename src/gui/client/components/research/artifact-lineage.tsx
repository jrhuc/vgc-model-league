import type { ResearchArtifactView, ResearchLegacyPositionsView } from '../../../api';
import { ErrorList } from './feedback';
import { count, releaseDeclaration, titleCase } from './format';

export function ArtifactLineage({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: ResearchArtifactView[];
  selected: ResearchArtifactView;
  onSelect: (kind: ResearchArtifactView['kind']) => void;
}) {
  return (
    <section class="panel research-artifact-lineage" aria-labelledby="artifact-lineage-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Artifact Room</p>
          <h2 id="artifact-lineage-title">Lineage and release state</h2>
          <p>
            Each node is a discovered artifact and its public validation result. A valid public boundary does not make a
            candidate release-ready.
          </p>
        </div>
      </div>
      <ol class="research-lineage-list">
        {artifacts.map((artifact, index) => {
          const active = artifact.kind === selected.kind;
          const release = releaseDeclaration(artifact.releaseReady);
          return (
            <li class="research-lineage-stage" key={artifact.kind}>
              {index > 0 ? (
                <span class="research-lineage-connector" aria-hidden="true">
                  →
                </span>
              ) : null}
              <button
                type="button"
                class={`research-artifact-selector ${active ? 'selected' : ''}`}
                aria-pressed={active}
                onClick={() => onSelect(artifact.kind)}
              >
                <span class="research-artifact-stage">Stage {index + 1}</span>
                <b>{artifact.kind === 'pilot' ? 'Pilot panel artifact' : 'Frozen split candidate'}</b>
                <span>{titleCase(artifact.status)}</span>
                <span class={`research-validation-state ${artifact.validation.status}`}>
                  {artifact.validation.status === 'valid' ? 'Public boundary valid' : 'Artifact rejected'}
                </span>
                <span class={`research-release-state ${release.className}`}>{release.label}</span>
                <small>
                  {artifact.schemaVersion === null ? 'Schema unavailable' : `Schema v${artifact.schemaVersion}`} ·{' '}
                  {artifact.taskPreviewAvailability === 'withheld'
                    ? `${artifact.taskTotal.toLocaleString()} bound public task${artifact.taskTotal === 1 ? '' : 's'} · content withheld`
                    : artifact.taskPreviewAvailability === 'unavailable'
                      ? 'task count unavailable'
                      : `${artifact.taskTotal.toLocaleString()} bound public task${artifact.taskTotal === 1 ? '' : 's'}`}
                </small>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ArtifactCounts({ artifact }: { artifact: ResearchArtifactView }) {
  const counts = artifact.counts;
  if (!counts) {
    return (
      <div class="results-empty">Counts are unavailable because this artifact did not pass public validation.</div>
    );
  }
  return (
    <dl class="research-count-grid">
      <div>
        <dt>Input positions</dt>
        <dd>{count(counts.input)}</dd>
      </div>
      <div>
        <dt>Eligible</dt>
        <dd>{count(counts.eligible)}</dd>
      </div>
      <div>
        <dt>Excluded</dt>
        <dd>{count(counts.excluded)}</dd>
      </div>
      <div>
        <dt>Train / eval</dt>
        <dd>
          {count(counts.train)} / {count(counts.eval)}
        </dd>
      </div>
      <div>
        <dt>Source groups</dt>
        <dd>{count(counts.sourceGroups)}</dd>
      </div>
      <div>
        <dt>Duplicate clusters</dt>
        <dd>{count(counts.duplicateClusters)}</dd>
      </div>
      <div>
        <dt>Near-duplicate pairs</dt>
        <dd>{count(counts.nearDuplicatePairs)}</dd>
      </div>
    </dl>
  );
}

export function ArtifactSummary({ artifact }: { artifact: ResearchArtifactView }) {
  const release = releaseDeclaration(artifact.releaseReady);
  return (
    <section class="panel research-artifact-summary" aria-labelledby="artifact-summary-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Selected artifact / {artifact.kind}</p>
          <h2 id="artifact-summary-title">{titleCase(artifact.status)}</h2>
          <p>
            {artifact.validation.status === 'valid'
              ? 'Public manifest and task bindings validated within the API boundary.'
              : 'This artifact is malformed or noncanonical. Metadata and task rows fail closed.'}
          </p>
        </div>
        <div class="research-artifact-state-stack">
          <span class={`research-validation-state ${artifact.validation.status}`}>
            {titleCase(artifact.validation.status)}
          </span>
          <span class={`research-release-state ${release.className}`}>{release.label}</span>
        </div>
      </div>
      {artifact.validation.errors.length > 0 ? (
        <div role="alert">
          <ErrorList errors={artifact.validation.errors} />
        </div>
      ) : null}
      <ArtifactCounts artifact={artifact} />
    </section>
  );
}

export function LegacyInventory({ legacy }: { legacy: ResearchLegacyPositionsView }) {
  if (!legacy.present) return null;
  return (
    <aside class="panel research-legacy-inventory" aria-label="Legacy position inventory">
      <p class="eyebrow">Legacy inventory / not a release artifact</p>
      <p>
        {legacy.rows.toLocaleString()} legacy position row{legacy.rows === 1 ? '' : 's'} detected · inventory only · no
        bound manifest. These rows are never folded into the schema-v2 lineage, validation states, or task totals below.
      </p>
    </aside>
  );
}
