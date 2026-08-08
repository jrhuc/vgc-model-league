// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the action overflow region must be keyboard-scrollable
import { useMemo, useState } from 'preact/hooks';

import type { ResearchArtifactView, ResearchTaskView } from '../../../api';
import { Dropdown } from '../dropdown';
import { titleCase } from './format';

type SplitFilter = 'all' | ResearchTaskView['split'];
type PhaseFilter = 'all' | ResearchTaskView['phase'];

const PHASE_LABELS: Record<ResearchTaskView['phase'], string> = {
  team_preview: 'Team preview',
  forced_switch: 'Forced switch',
  turn: 'Turn',
};

function CanonicalActionMenu({ task }: { task: ResearchTaskView }) {
  return (
    <section
      class="position-action-scroll"
      aria-label={`Exhaustive canonical action menu for ${task.taskId}`}
      tabIndex={0}
    >
      <ol start={0} class="position-action-list">
        {task.actions.map((action) => (
          <li value={action.number} key={`${action.number}:${action.canonicalAction}`}>
            <span class="position-action-label">{action.label}</span>
            <code class="position-action-command">{action.canonicalAction}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PositionTask({ task }: { task: ResearchTaskView }) {
  return (
    <article class="position-task-card">
      <header class="position-task-header">
        <div>
          <p class="eyebrow">Public task</p>
          <h3>{task.taskId}</h3>
        </div>
        <dl class="position-task-meta">
          <div>
            <dt>Format</dt>
            <dd>{task.format}</dd>
          </div>
          <div>
            <dt>Split</dt>
            <dd>{titleCase(task.split)}</dd>
          </div>
          <div>
            <dt>Phase</dt>
            <dd>{PHASE_LABELS[task.phase]}</dd>
          </div>
          <div>
            <dt>Turn</dt>
            <dd>{task.turn}</dd>
          </div>
          <div>
            <dt>Legal joint actions</dt>
            <dd>{task.actionCount.toLocaleString()}</dd>
          </div>
        </dl>
      </header>
      <section class="position-task-prompt" aria-labelledby="position-task-prompt-title">
        <h4 id="position-task-prompt-title">Model-visible prompt</h4>
        <pre>{task.prompt}</pre>
        {task.promptTruncated ? (
          <p class="research-preview-warning" role="status">
            The prompt exceeds the viewer bound and is truncated here. Use the immutable public artifact for the full
            task; this preview is not a rollout input.
          </p>
        ) : null}
      </section>
      <section class="position-action-menu" aria-labelledby="position-task-actions-title">
        <h4 id="position-task-actions-title">Exhaustive canonical action menu</h4>
        <CanonicalActionMenu task={task} />
      </section>
    </article>
  );
}

export function TaskBrowser({ artifact }: { artifact: ResearchArtifactView }) {
  const [split, setSplit] = useState<SplitFilter>('all');
  const [phase, setPhase] = useState<PhaseFilter>('all');
  const [taskId, setTaskId] = useState('');
  const tasks = artifact.tasks;
  const taskPreviewsWithheld = artifact.taskPreviewAvailability === 'withheld';
  const filtered = useMemo(
    () =>
      tasks.filter((task) => (split === 'all' || task.split === split) && (phase === 'all' || task.phase === phase)),
    [tasks, split, phase],
  );
  const task = filtered.find((entry) => entry.taskId === taskId) ?? filtered[0] ?? null;
  const splitOptions = [
    { value: 'all', label: 'All returned splits' },
    ...([...new Set(tasks.map((entry) => entry.split))].sort() as ResearchTaskView['split'][]).map((value) => ({
      value,
      label: titleCase(value),
    })),
  ];
  const phaseOptions = [
    { value: 'all', label: 'All returned phases' },
    ...([...new Set(tasks.map((entry) => entry.phase))].sort() as ResearchTaskView['phase'][]).map((value) => ({
      value,
      label: PHASE_LABELS[value],
    })),
  ];
  const taskOptions = filtered.map((entry) => ({
    value: entry.taskId,
    label: entry.taskId,
    description: `${entry.format} · ${PHASE_LABELS[entry.phase]} · ${titleCase(entry.split)} · turn ${entry.turn}`,
  }));
  return (
    <section class="panel position-task-browser" aria-labelledby="task-browser-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Position Lab</p>
          <h2 id="task-browser-title">Bounded public task browser</h2>
          <p>
            Filters apply to the API preview, not the full corpus. Every displayed task retains its complete canonical
            legal-action map.
          </p>
        </div>
      </div>
      <p class="research-preview-scope" role="status">
        {taskPreviewsWithheld ? (
          <>
            This deployment returned no unreleased candidate task bytes; the verified manifest inventory contains{' '}
            {artifact.taskTotal.toLocaleString()} public task{artifact.taskTotal === 1 ? '' : 's'}.
          </>
        ) : (
          <>
            Returned {artifact.taskPreviewCount.toLocaleString()} of {artifact.taskTotal.toLocaleString()}{' '}
            manifest-bound public task{artifact.taskTotal === 1 ? '' : 's'}.
          </>
        )}
      </p>
      {tasks.length === 0 ? (
        <div class="results-empty" role="status">
          {artifact.validation.status === 'invalid' || artifact.taskPreviewAvailability === 'unavailable'
            ? 'Task previews are unavailable because this artifact failed public validation.'
            : taskPreviewsWithheld
              ? 'Unreleased public-task bytes are withheld on this deployment. No task content is inferred from their absence.'
              : 'This artifact contains no public task previews.'}
          {artifact.taskPreviewReason ? ` Reason: ${titleCase(artifact.taskPreviewReason)}.` : ''}
        </div>
      ) : (
        <>
          <div class="position-filter-row">
            <Dropdown
              id={`positionSplit-${artifact.kind}`}
              label="Split"
              options={splitOptions}
              value={split}
              onChange={(value) => setSplit(value as SplitFilter)}
            />
            <Dropdown
              id={`positionPhase-${artifact.kind}`}
              label="Phase"
              options={phaseOptions}
              value={phase}
              onChange={(value) => setPhase(value as PhaseFilter)}
            />
            <Dropdown
              id={`positionTask-${artifact.kind}`}
              label="Task"
              options={taskOptions}
              value={task?.taskId ?? ''}
              onChange={setTaskId}
              filterable
              emptyText="No returned task matches these filters."
            />
          </div>
          {task ? (
            <PositionTask task={task} />
          ) : (
            <div class="results-empty" role="status">
              No returned task matches these filters. Reset the split or phase to continue browsing.
            </div>
          )}
        </>
      )}
    </section>
  );
}
