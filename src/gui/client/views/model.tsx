import { useEffect, useState } from 'preact/hooks';

import type { LegacyObservationIndexResponse } from '../../api';
import { api } from '../http';
import { when } from '../lib/labels';

const MODE_LABELS: Record<string, string> = {
  rotation: 'Rotation',
  draft: 'Draft leagues',
  tournament: 'Tournaments',
  exhibition: 'Exhibitions',
};

interface ArchiveRun {
  mode: string;
  runId: string;
  when: string;
}

function compareArchiveRuns(a: ArchiveRun, b: ArchiveRun): number {
  if (!a.when && b.when) return 1;
  if (a.when && !b.when) return -1;
  return a.when.localeCompare(b.when) || a.runId.localeCompare(b.runId);
}

export function ModelProfileView({
  active,
  model,
  onBack,
  onOpenLeague,
  onOpenTournament,
}: {
  active: boolean;
  model: string;
  onBack: () => void;
  onOpenLeague: (runId: string) => void;
  onOpenTournament: (runId: string) => void;
}) {
  const [profile, setProfile] = useState<LegacyObservationIndexResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !model) return;
    if (profile?.id === model) return;
    setProfile(null);
    setError('');
    api<LegacyObservationIndexResponse>(`/api/model?id=${encodeURIComponent(model)}`)
      .then((response) => {
        setProfile(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, model, profile?.id]);

  if (error) {
    return (
      <div class="league-view research-observation-index">
        <div class="message error">Could not load this legacy observation index: {error}</div>
      </div>
    );
  }
  if (!profile || profile.id !== model) return <p class="muted">Loading the legacy observation index…</p>;

  const modes = [...profile.modes].sort((a, b) =>
    (MODE_LABELS[a.mode] ?? a.mode).localeCompare(MODE_LABELS[b.mode] ?? b.mode),
  );
  const archiveRuns = modes
    .filter((mode) => mode.mode === 'draft' || mode.mode === 'tournament')
    .flatMap((mode) => mode.runs.map((run): ArchiveRun => ({ mode: mode.mode, runId: run.runId, when: run.when })))
    .sort(compareArchiveRuns);

  return (
    <div class="league-view research-observation-index">
      <header class="page-heading league-heading research-index-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← Data room
            </button>{' '}
            / legacy observation index
          </p>
          <h1>Legacy Observation Index</h1>
          <p class="legacy-model-key-value">
            Collapsed backend id: <code>{profile.id}</code>
          </p>
        </div>
        <p class="lede research-coverage-span">
          Archived non-test-pool observations span {when(profile.firstSeen)} to {when(profile.lastSeen)}.
        </p>
      </header>

      <section class="panel legacy-identity-panel" aria-labelledby="legacy-identity-heading">
        <div class="section-head">
          <div>
            <h2 id="legacy-identity-heading">Legacy identity boundary</h2>
            <p>
              The backend id is a legacy collapsed <code>modelKey</code>, not a provider-qualified specification.
            </p>
          </div>
        </div>
        <p>The archived records grouped under that id contain these exact provider-qualified specifications:</p>
        {profile.providers.length === 0 ? (
          <p class="muted">No provider-qualified specification was retained.</p>
        ) : (
          <ul class="legacy-provider-spec-list">
            {profile.providers.map((provider) => (
              <li key={provider}>
                <code>{provider}</code>
              </li>
            ))}
          </ul>
        )}
        <div class="message legacy-identity-warning">
          This endpoint collapses those specifications before counting. It does not expose provider-specific counts or
          denominators, so no observation below can be attributed to one listed specification.
        </div>
      </section>

      <section class="panel research-coverage-panel" aria-labelledby="coverage-inventory-heading">
        <div class="section-head">
          <div>
            <h2 id="coverage-inventory-heading">Coverage inventory</h2>
            <p>Record counts only; they are not results, rates, or comparisons.</p>
          </div>
        </div>
        <div class="message legacy-denominator-warning">
          <b>Legacy denominator warning.</b> Series and games are player-side observations, not distinct-event totals; a
          record with this collapsed key on both sides can be counted twice. The endpoint does not report eligible
          decision or reflection opportunities, archive-completeness denominators, or missing-log counts.
        </div>
        <div class="table-scroll">
          <table class="data-table research-coverage-table">
            <thead>
              <tr>
                <th>Record type</th>
                <th class="num">Observed records</th>
                <th>Available denominator or scope</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Series</td>
                <td class="num">{profile.series.toLocaleString()}</td>
                <td>Matched player-side series outside the test pool; no distinct-series denominator.</td>
              </tr>
              <tr>
                <td>Games</td>
                <td class="num">{profile.games.toLocaleString()}</td>
                <td>Games attached to the matched player-side series; no distinct-game denominator.</td>
              </tr>
              <tr>
                <td>Decisions</td>
                <td class="num">{profile.decisions.toLocaleString()}</td>
                <td>Logged decisions for matched sides; eligible decision opportunities are unavailable.</td>
              </tr>
              <tr>
                <td>Reflections</td>
                <td class="num">{profile.reflections.toLocaleString()}</td>
                <td>Logged reflections for matched sides; eligible reflection opportunities are unavailable.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel research-mode-inventory" aria-labelledby="mode-inventory-heading">
        <div class="section-head">
          <div>
            <h2 id="mode-inventory-heading">Recorded modes</h2>
            <p>Series-observation coverage under the same collapsed identity and denominator warning.</p>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table research-mode-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th class="num">Series observations</th>
              </tr>
            </thead>
            <tbody>
              {modes.map((mode) => (
                <tr key={mode.mode}>
                  <td>{MODE_LABELS[mode.mode] ?? mode.mode}</td>
                  <td class="num">{mode.series.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel research-archive-chronology" aria-labelledby="archive-chronology-heading">
        <div class="section-head">
          <div>
            <h2 id="archive-chronology-heading">Linked archive runs</h2>
            <p>Stored league and tournament destinations in chronological order, oldest first.</p>
          </div>
        </div>
        {archiveRuns.length === 0 ? (
          <p class="muted">No linked league or tournament archive is available for this collapsed id.</p>
        ) : (
          <div class="table-scroll">
            <table class="data-table research-archive-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Mode</th>
                  <th>Archive run</th>
                </tr>
              </thead>
              <tbody>
                {archiveRuns.map((run) => (
                  <tr key={`${run.mode}:${run.runId}`}>
                    <td>{when(run.when)}</td>
                    <td>{MODE_LABELS[run.mode] ?? run.mode}</td>
                    <td>
                      <button
                        type="button"
                        class="text-link research-archive-link"
                        onClick={() => (run.mode === 'draft' ? onOpenLeague(run.runId) : onOpenTournament(run.runId))}
                      >
                        {run.runId}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
