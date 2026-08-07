import type { BattleLogEntryView, LeagueGameDecisionView, LeagueGameReflectionView } from '../../api';

function secondsLabel(ms: number | null): string {
  return ms === null ? '' : `${Math.round(ms / 1000)}s`;
}

export function GameTimeline({
  decisions,
  log,
  names,
}: {
  decisions: LeagueGameDecisionView[];
  log: BattleLogEntryView[];
  names: [string, string];
}) {
  const turns = [...new Set([...log.map((entry) => entry.turn), ...decisions.map((entry) => entry.turn)])].sort(
    (a, b) => a - b,
  );
  return (
    <div class="game-timeline">
      {turns.length === 0 ? <p class="empty-note">Waiting for the first battle event.</p> : null}
      {turns.map((turn) => (
        <div class="game-turn" key={turn}>
          <div class="log-turn">{turn === 0 ? 'Team preview' : `Turn ${turn}`}</div>
          {decisions
            .filter((decision) => decision.turn === turn)
            .map((decision, index) => (
              <details class={`game-decision side-${decision.side}`} key={`${turn}:${decision.side}:${index}`}>
                <summary>
                  <b>{names[decision.side]}</b>
                  <span class="game-decision-choice">
                    {decision.selection.length > 0 ? decision.selection.join(' · ') : decision.action}
                  </span>
                  {decision.fallback ? <span class="game-decision-flag">fallback</span> : null}
                  {decision.automatic ? <span class="game-decision-flag">auto</span> : null}
                  <small>
                    {secondsLabel(decision.latencyMs)}
                    {decision.reasoningTokens ? ` · ${decision.reasoningTokens.toLocaleString()} reasoning tok` : ''}
                  </small>
                </summary>
                <p>{decision.rationale || 'No stored rationale.'}</p>
                {decision.notebook ? <p class="game-decision-notebook">{decision.notebook}</p> : null}
              </details>
            ))}
          {log
            .filter((entry) => entry.turn === turn)
            .map((entry, index) => (
              <div class={`log-line ${entry.kind}`} key={`${turn}:${index}`}>
                {entry.text}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

export function GameReflections({
  reflections,
  names,
  notebookLabel = 'Notebook',
}: {
  reflections: LeagueGameReflectionView[];
  names: [string, string];
  notebookLabel?: string;
}) {
  return (
    <div class="reflection-grid">
      {reflections.map((reflection) => (
        <article class={`reflection-card side-${reflection.side}`} key={reflection.side}>
          <header>
            <b>{names[reflection.side]}</b>
            <span class={`reflection-result ${reflection.result}`}>{reflection.result}</span>
            {reflection.fallback ? <span class="game-decision-flag">fallback</span> : null}
          </header>
          <p>{reflection.summary || 'No stored reflection.'}</p>
          {reflection.adjustment ? <p class="reflection-adjustment">{reflection.adjustment}</p> : null}
          {reflection.notebook ? (
            <details>
              <summary>{notebookLabel}</summary>
              <p class="game-decision-notebook">{reflection.notebook}</p>
            </details>
          ) : null}
        </article>
      ))}
    </div>
  );
}
