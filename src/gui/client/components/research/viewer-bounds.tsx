import type { ResearchResponse } from '../../../api';
import { bytes } from './format';

export function ViewerBounds({ data }: { data: ResearchResponse }) {
  return (
    <details class="audit-details research-viewer-bounds">
      <summary>Preview limits</summary>
      <div class="panel">
        <dl class="research-bounds-list">
          <div>
            <dt>Response schema</dt>
            <dd>v{data.schemaVersion}</dd>
          </div>
          <div>
            <dt>Task previews per set</dt>
            <dd>{data.limits.taskPreviews.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Prompt preview</dt>
            <dd>{data.limits.promptCharacters.toLocaleString()} characters</dd>
          </div>
          <div>
            <dt>Legal actions per task</dt>
            <dd>{data.limits.actionsPerTask.toLocaleString()} actions</dd>
          </div>
          <div>
            <dt>Action text limit</dt>
            <dd>{data.limits.actionLabelCharacters.toLocaleString()} characters</dd>
          </div>
          <div>
            <dt>Rows per task set</dt>
            <dd>{data.limits.artifactRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Metadata file limit</dt>
            <dd>{bytes(data.limits.manifestBytes)}</dd>
          </div>
          <div>
            <dt>Task file limit</dt>
            <dd>{bytes(data.limits.taskBytes)}</dd>
          </div>
        </dl>
        <p class="muted">
          Shortened prompts are marked. If a task has too many legal actions to display completely, the task set is
          unavailable.
        </p>
      </div>
    </details>
  );
}
