import type { ResearchResponse } from '../../../api';
import { bytes } from './format';

export function ViewerBounds({ data }: { data: ResearchResponse }) {
  return (
    <details class="audit-details research-viewer-bounds">
      <summary>Viewer safety bounds</summary>
      <div class="panel">
        <dl class="research-bounds-list">
          <div>
            <dt>Research response schema</dt>
            <dd>v{data.schemaVersion}</dd>
          </div>
          <div>
            <dt>Task previews per artifact</dt>
            <dd>{data.limits.taskPreviews.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Prompt preview</dt>
            <dd>{data.limits.promptCharacters.toLocaleString()} characters</dd>
          </div>
          <div>
            <dt>Complete action menu ceiling</dt>
            <dd>{data.limits.actionsPerTask.toLocaleString()} actions</dd>
          </div>
          <div>
            <dt>Action text ceiling</dt>
            <dd>{data.limits.actionLabelCharacters.toLocaleString()} characters</dd>
          </div>
          <div>
            <dt>Artifact row ceiling</dt>
            <dd>{data.limits.artifactRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Manifest byte ceiling</dt>
            <dd>{bytes(data.limits.manifestBytes)}</dd>
          </div>
          <div>
            <dt>Task artifact byte ceiling</dt>
            <dd>{bytes(data.limits.taskBytes)}</dd>
          </div>
        </dl>
        <p class="muted">
          Prompt previews may be shortened and are marked when they are. Action menus are never shortened: an artifact
          beyond the structural ceiling is rejected instead.
        </p>
      </div>
    </details>
  );
}
