import type { ResearchArtifactView } from '../../../api';

function previewDescription(artifact: ResearchArtifactView): string {
  if (artifact.taskPreviewAvailability === 'available') {
    return `${artifact.taskPreviewCount.toLocaleString()} of ${artifact.taskTotal.toLocaleString()} task previews are shown.`;
  }
  if (artifact.taskPreviewAvailability === 'withheld') return 'Task previews are unavailable on this deployment.';
  return 'Task previews are unavailable because this task set could not be loaded.';
}

export function ReleaseGates({ artifact }: { artifact: ResearchArtifactView }) {
  const metadataAvailable = artifact.validation.status === 'valid';
  const previewsAvailable = artifact.taskPreviewAvailability === 'available';
  return (
    <section class="panel research-release-gates" aria-labelledby="release-gates-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Data availability</p>
          <h2 id="release-gates-title">Available in this view</h2>
          <p>Position-task data is listed below. Evaluation results are not available in the GUI.</p>
        </div>
      </div>
      <ul class="research-gate-list">
        <li class={`research-gate ${metadataAvailable ? 'valid' : 'blocked'}`}>
          <span class="research-gate-marker" aria-hidden="true">
            {metadataAvailable ? '✓' : '×'}
          </span>
          <div>
            <b>Task metadata</b>
            <small>{metadataAvailable ? 'Available.' : 'Unavailable because this task set could not be loaded.'}</small>
          </div>
        </li>
        <li class={`research-gate ${previewsAvailable ? 'valid' : 'unknown'}`}>
          <span class="research-gate-marker" aria-hidden="true">
            {previewsAvailable ? '✓' : '—'}
          </span>
          <div>
            <b>Task previews</b>
            <small>{previewDescription(artifact)}</small>
          </div>
        </li>
        <li class="research-gate unknown">
          <span class="research-gate-marker" aria-hidden="true">
            —
          </span>
          <div>
            <b>Evaluation results</b>
            <small>Unavailable.</small>
          </div>
        </li>
      </ul>
    </section>
  );
}
