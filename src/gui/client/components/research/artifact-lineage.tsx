import type { ResearchArtifactView, ResearchLegacyPositionsView } from '../../../api';
import { ErrorList } from './feedback';
import { count } from './format';

function taskSetName(artifact: ResearchArtifactView): string {
  return artifact.kind === 'pilot' ? 'Pilot task set' : 'Frozen task set';
}

function previewSummary(artifact: ResearchArtifactView): string {
  if (artifact.taskPreviewAvailability === 'available') {
    return `${artifact.taskPreviewCount.toLocaleString()} of ${artifact.taskTotal.toLocaleString()} task previews shown`;
  }
  return `${artifact.taskTotal.toLocaleString()} tasks listed · previews unavailable`;
}

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
          <p class="eyebrow">Position data</p>
          <h2 id="artifact-lineage-title">Available task sets</h2>
          <p>Choose a task set to inspect its counts, previews, dataset split, and technical details.</p>
        </div>
      </div>
      <ol class="research-lineage-list">
        {artifacts.map((artifact, index) => {
          const active = artifact.kind === selected.kind;
          const available = artifact.validation.status === 'valid';
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
                <span class="research-artifact-stage">Set {index + 1}</span>
                <b>{taskSetName(artifact)}</b>
                <span>{available ? 'Task metadata available' : 'Task metadata unavailable'}</span>
                <span class={`research-validation-state ${artifact.validation.status}`}>
                  {available ? 'Available' : 'Unavailable'}
                </span>
                <span class="research-release-state unknown">Evaluation results unavailable</span>
                <small>
                  {artifact.schemaVersion === null ? 'Schema unavailable' : `Schema v${artifact.schemaVersion}`} ·{' '}
                  {previewSummary(artifact)}
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
  if (!counts) return <div class="results-empty">Position counts are unavailable for this task set.</div>;
  return (
    <dl class="research-count-grid">
      <div>
        <dt>Input positions</dt>
        <dd>{count(counts.input)}</dd>
      </div>
      <div>
        <dt>Usable positions</dt>
        <dd>{count(counts.eligible)}</dd>
      </div>
      <div>
        <dt>Excluded positions</dt>
        <dd>{count(counts.excluded)}</dd>
      </div>
      <div>
        <dt>Training / evaluation</dt>
        <dd>
          {count(counts.train)} / {count(counts.eval)}
        </dd>
      </div>
      <div>
        <dt>Source groups</dt>
        <dd>{count(counts.sourceGroups)}</dd>
      </div>
      <div>
        <dt>Duplicate groups</dt>
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
  const available = artifact.validation.status === 'valid';
  return (
    <section class="panel research-artifact-summary" aria-labelledby="artifact-summary-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Selected task set / {artifact.kind}</p>
          <h2 id="artifact-summary-title">{taskSetName(artifact)}</h2>
          <p>{available ? 'Task metadata is available.' : 'This task set could not be loaded.'}</p>
        </div>
        <div class="research-artifact-state-stack">
          <span class={`research-validation-state ${artifact.validation.status}`}>
            {available ? 'Available' : 'Unavailable'}
          </span>
          <span class="research-release-state unknown">Results unavailable</span>
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
    <aside class="panel research-legacy-inventory" aria-label="Older position data">
      <p class="eyebrow">Older position data</p>
      <p>
        {legacy.rows.toLocaleString()} older position row{legacy.rows === 1 ? '' : 's'} found. Task details and
        evaluation results are unavailable for these rows.
      </p>
    </aside>
  );
}
