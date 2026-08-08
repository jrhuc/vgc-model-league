import type { ResearchArtifactView } from '../../../api';
import { percent } from './format';

export function SplitBalance({ artifact }: { artifact: ResearchArtifactView }) {
  const balance = artifact.splitBalance;
  if (!balance) {
    return (
      <section class="panel research-split-balance" aria-labelledby="split-balance-title">
        <div class="section-head">
          <div>
            <p class="eyebrow">Dataset split</p>
            <h2 id="split-balance-title">Training and evaluation balance</h2>
            <p>Split counts are unavailable for this task set.</p>
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
          <p class="eyebrow">Dataset split</p>
          <h2 id="split-balance-title">Training and evaluation balance</h2>
          <p>Counts reported for this task set. Targets and tolerance checks are unavailable in the GUI.</p>
        </div>
      </div>
      <dl class="research-balance-summary">
        <div>
          <dt>Overall evaluation share</dt>
          <dd>{percent(balance.evalFraction)}</dd>
        </div>
        <div>
          <dt>Overall deviation</dt>
          <dd>{percent(balance.evalFractionDeviation)}</dd>
        </div>
        <div>
          <dt>Largest group deviation</dt>
          <dd>{percent(balance.maxStratumDeviation)}</dd>
        </div>
      </dl>
      {strata.length === 0 ? (
        <div class="results-empty">No split groups are available.</div>
      ) : (
        /* biome-ignore lint/a11y/noNoninteractiveTabindex: the overflow region must be keyboard-scrollable */
        <section class="table-scroll" aria-label="Training and evaluation counts by group" tabIndex={0}>
          <table class="data-table research-strata-table">
            <caption>Training and evaluation counts by group</caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col" class="num">
                  Total
                </th>
                <th scope="col" class="num">
                  Train
                </th>
                <th scope="col" class="num">
                  Evaluation
                </th>
                <th scope="col" class="num">
                  Evaluation share
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
