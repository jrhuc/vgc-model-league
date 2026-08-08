import { useEffect, useMemo, useState } from 'preact/hooks';

import type { ResearchArtifactView, ResearchResponse } from '../../api';
import { ArtifactLineage, ArtifactSummary, LegacyInventory } from '../components/research/artifact-lineage';
import { ErrorList } from '../components/research/feedback';
import { ProtocolExplorer } from '../components/research/protocol-explorer';
import { ReleaseGates } from '../components/research/release-gates';
import { SplitBalance } from '../components/research/split-balance';
import { TaskBrowser } from '../components/research/task-browser';
import { ViewerBounds } from '../components/research/viewer-bounds';
import { api } from '../http';
import { decodeResearchResponse } from '../lib/research-response';

interface DataRoomViewProps {
  active: boolean;
  epoch: number;
}

export function DataRoomView({ active, epoch }: DataRoomViewProps) {
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [selectedKind, setSelectedKind] = useState<ResearchArtifactView['kind']>('frozen');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError('');
    setData(null);
    api<unknown>('/api/research')
      .then((response) => decodeResearchResponse(response))
      .then((response) => {
        if (!current) return;
        setData(response);
        setLoading(false);
      })
      .catch((failure: Error) => {
        if (!current) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, epoch]);

  const artifacts = useMemo(
    () =>
      [...(data?.artifacts ?? [])].sort((first, second) =>
        first.kind === second.kind ? 0 : first.kind === 'pilot' ? -1 : 1,
      ),
    [data],
  );
  const selected = artifacts.find((artifact) => artifact.kind === selectedKind) ?? artifacts[0] ?? null;

  return (
    <div class="research-view position-lab-view">
      <header class="page-heading research-heading">
        <div>
          <p class="eyebrow">Research / position tasks</p>
          <h1>Position Lab.</h1>
        </div>
        <p class="lede">
          Browse available task metadata, prompt previews, dataset splits, and technical details. Evaluation results are
          unavailable.
        </p>
      </header>

      <aside class="research-privacy-boundary" aria-label="Position data availability">
        <b>Data availability.</b> This page shows position-task metadata only. Scores and other evaluation results are
        unavailable.
      </aside>

      {loading ? (
        <section class="panel research-loading-state" role="status" aria-live="polite">
          <p class="muted">Loading position data…</p>
        </section>
      ) : null}
      {error ? (
        <div class="message error" role="alert">
          Could not load position data: {error}
        </div>
      ) : null}
      {data && data.errors.length > 0 ? (
        <section class="message error research-root-errors" role="alert">
          <b>Some position data could not be loaded.</b>
          <ErrorList errors={data.errors} />
        </section>
      ) : null}
      {data && data.warnings.length > 0 ? (
        <section class="notice-strip research-root-warnings" role="status" aria-live="polite">
          <b>Position data notice.</b>
          <ErrorList errors={data.warnings} />
        </section>
      ) : null}
      {data ? <LegacyInventory legacy={data.legacyPositions} /> : null}

      {data && data.status === 'empty' && artifacts.length === 0 ? (
        <section class="panel research-empty-state" role="status">
          <p class="eyebrow">Position tasks / unavailable</p>
          <h2>No position tasks are available.</h2>
          <p>Task metadata, previews, and evaluation results are unavailable.</p>
        </section>
      ) : null}

      {data && data.status !== 'empty' && artifacts.length === 0 ? (
        <section class="panel research-empty-state" role="alert">
          <p class="eyebrow">Unavailable</p>
          <h2>No position data could be loaded.</h2>
          <p>Review the errors above for details.</p>
        </section>
      ) : null}

      {data && selected ? (
        <>
          <ArtifactLineage artifacts={artifacts} selected={selected} onSelect={setSelectedKind} />
          <ArtifactSummary artifact={selected} />
          <ProtocolExplorer artifact={selected} />
          <ReleaseGates artifact={selected} />
          <SplitBalance artifact={selected} />
          <TaskBrowser key={selected.kind} artifact={selected} />
          <ViewerBounds data={data} />
        </>
      ) : null}
    </div>
  );
}
