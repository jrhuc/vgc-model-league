import { useEffect, useState } from 'preact/hooks';

import type { RecordsResponse } from '../../api';
import { Dropdown } from '../components/dropdown';
import { api } from '../http';

function code(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `Z${index - 25}`;
}

export function ResultsView({ active, epoch }: { active: boolean; epoch: number }) {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [pool, setPool] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    api<RecordsResponse>(`/api/records${pool ? `?pool=${encodeURIComponent(pool)}` : ''}`)
      .then((response) => {
        setData(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, epoch, pool]);

  const rows = data?.standings ?? [];
  const poolOptions = [
    { value: '', label: 'Overall', description: 'Every pool except the disposable test pool' },
    ...(data?.pools ?? []).map((name) => ({ value: name, label: name })),
  ];
  const scopeText = data
    ? data.pool
      ? `${data.count} recorded series in pool ${data.pool}.`
      : `${data.count} recorded series across all pools (test excluded).`
    : 'Loading the record book…';
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Record book / {pool || 'overall'}</p>
          <h1>
            Standings &amp;
            <br />
            head to head.
          </h1>
        </div>
        <p class="lede">
          Recorded Rotation series in this checkout, rated by Elo. The overall view excludes the disposable test pool;
          select a pool to keep ratings within one team-pool epoch.
        </p>
      </div>
      <div class="results-grid">
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Standings</h2>
              <p>{error || scopeText}</p>
            </div>
            <div style="min-width:220px">
              <Dropdown id="recordsPool" label="Scope" options={poolOptions} value={pool} onChange={setPool} />
            </div>
          </div>
          <div class="table-scroll">
            {rows.length === 0 ? (
              <div class="results-empty">No completed series yet — standings appear after the first recorded run.</div>
            ) : (
              <table class="data-table">
                <thead>
                  <tr>
                    <th />
                    <th>Model</th>
                    <th class="num">Elo</th>
                    <th class="num">Series</th>
                    <th class="num">W-L-T</th>
                    <th class="num">Win %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((standing, index) => (
                    <tr key={standing.spec}>
                      <td>{code(index)}</td>
                      <td class="spec-cell" title={standing.spec}>
                        {standing.spec}
                      </td>
                      <td class="num">{Math.round(standing.elo)}</td>
                      <td class="num">{standing.series}</td>
                      <td class="num">
                        {standing.w}-{standing.l}-{standing.t}
                      </td>
                      <td class="num">{Math.round(standing.winrate * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Head to head</h2>
              <p>Series W-L-T, row vs column.</p>
            </div>
          </div>
          <div class="table-scroll">
            {rows.length === 0 ? (
              <div class="results-empty">The matrix fills in as pairings resolve.</div>
            ) : (
              <table class="data-table">
                <thead>
                  <tr>
                    <th />
                    {rows.map((standing, index) => (
                      <th key={standing.spec} class="num" title={standing.spec}>
                        {code(index)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((rowStanding, rowIndex) => (
                    <tr key={rowStanding.spec}>
                      <td title={rowStanding.spec}>{code(rowIndex)}</td>
                      {rows.map((colStanding) => {
                        const cell = data?.h2h[rowStanding.spec]?.[colStanding.spec] ?? [0, 0, 0];
                        const played = cell[0] || cell[1] || cell[2];
                        return (
                          <td key={colStanding.spec} class="num">
                            {played ? `${cell[0]}-${cell[1]}-${cell[2]}` : <span class="muted">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
