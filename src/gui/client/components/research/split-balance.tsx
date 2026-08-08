import type { ResearchArtifactView } from '../../../api';
import { percent } from './format';

export function SplitBalance({ artifact }: { artifact: ResearchArtifactView }) {
  const balance = artifact.splitBalance;
  if (!balance) {
    return (
      <section class="panel research-split-balance" aria-labelledby="split-balance-title">
        <div class="section-head">
          <div>
            <p class="eyebrow">Split audit</p>
            <h2 id="split-balance-title">Declared stratum balance</h2>
            <p>No per-stratum split balance is declared for this artifact. Absence is not evidence of balance.</p>
          </div>
        </div>
      </section>
    );
  }
  const strata = Object.entries(balance.strata).sort(([first], [second]) => first.localeCompare(second));
  return (
    <section class="panel research-split-balance" aria-labelledby="split-balance-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Split audit</p>
          <h2 id="split-balance-title">Declared stratum balance</h2>
          <p>
            Manifest counts for the frozen assignment. Deviation is the manifest-reported absolute distance from the
            frozen policy target; the target and tolerances are not included in this viewer contract, so these rows are
            descriptive rather than a gate verdict. Source-series and near-duplicate components stay whole under
            deterministic greedy stratification; this table neither recomputes a global optimum nor proves
            candidate/calibration corpora are disjoint.
          </p>
        </div>
      </div>
      <dl class="research-balance-summary">
        <div>
          <dt>Overall eval share</dt>
          <dd>{percent(balance.evalFraction)}</dd>
        </div>
        <div>
          <dt>Overall deviation</dt>
          <dd>{percent(balance.evalFractionDeviation)}</dd>
        </div>
        <div>
          <dt>Largest stratum deviation</dt>
          <dd>{percent(balance.maxStratumDeviation)}</dd>
        </div>
      </dl>
      {strata.length === 0 ? (
        <div class="results-empty">The split balance object contains no declared strata.</div>
      ) : (
        /* biome-ignore lint/a11y/noNoninteractiveTabindex: the overflow region must be keyboard-scrollable */
        <section class="table-scroll" aria-label="Declared split balance by stratum" tabIndex={0}>
          <table class="data-table research-strata-table">
            <caption>Declared split balance by stratum</caption>
            <thead>
              <tr>
                <th scope="col">Declared stratum</th>
                <th scope="col" class="num">
                  Total
                </th>
                <th scope="col" class="num">
                  Train
                </th>
                <th scope="col" class="num">
                  Eval
                </th>
                <th scope="col" class="num">
                  Eval share
                </th>
                <th scope="col" class="num">
                  Deviation
                </th>
              </tr>
            </thead>
            <tbody>
              {strata.map(([stratum, row]) => (
                <tr key={stratum}>
                  <td>
                    <code>{stratum}</code>
                  </td>
                  <td class="num">{row.total.toLocaleString()}</td>
                  <td class="num">{(row.total - row.eval).toLocaleString()}</td>
                  <td class="num">{row.eval.toLocaleString()}</td>
                  <td class="num">{percent(row.evalFraction)}</td>
                  <td class="num">{percent(row.deviation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
