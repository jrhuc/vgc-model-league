import type { SelectedTraceView } from '../../api';
import { Sprite } from '../components/sprite';
import { TRACE_ARTIFACT_HREF } from '../http';

interface MethodViewProps {
  trace: SelectedTraceView | null;
  onOpenDocs: () => void;
}

const REPOSITORY_ROOT = 'https://github.com/jrhuc/vgc-model-league';

const POSITION_STEPS = [
  {
    index: '01',
    title: 'Rebuild the position',
    body: 'Load the recorded turn exactly — pinned format, simulator revision, seed, teams, and every action so far. A single mismatch rejects the task.',
  },
  {
    index: '02',
    title: 'Fork each accepted action',
    body: 'Generate actions from the live request, then keep the ones Showdown accepts for the tested seat.',
  },
  {
    index: '03',
    title: 'Evaluate with common draws',
    body: 'Play every branch out with common random draws, then report its value under the named reference and sampling budget.',
  },
  {
    index: '04',
    title: 'Keep the answers private',
    body: 'Keep scores, draws, snapshots, and the opponent’s private request in a separate private artifact root.',
  },
] as const;

const EPISODE_STEPS = [
  {
    index: '01',
    title: 'Draft under a budget',
    body: 'Every seat spends the same points on ten exclusive Pokémon from a shared board.',
  },
  {
    index: '02',
    title: 'Commit to a plan',
    body: 'Before each series, the seat writes its plan and registers six of its ten for the matchup.',
  },
  {
    index: '03',
    title: 'Play it out',
    body: 'Bring four, lead two, best of three. The simulator resolves both sides at once, luck included.',
  },
  {
    index: '04',
    title: 'Keep the trail joined',
    body: 'Picks, builds, trades, battle actions, reflections, and the season review stay attached to the same seat, in order.',
  },
] as const;

const SEAT_ACCESS = [
  {
    label: 'The tested seat sees',
    tone: 'visible',
    items: [
      'Anonymized public battle history',
      'Its own request for this turn',
      'The numbered legal actions',
      'The answer format',
    ],
  },
  {
    label: 'Held back',
    tone: 'hidden',
    items: [
      'Which model faced this position, and what it chose',
      'Scores and the draws behind them',
      'The opponent’s private view',
      'Rationales and notebooks from the source run',
    ],
  },
] as const;

function ConstructBoundary() {
  return (
    <section class="method-section" aria-labelledby="construct-title">
      <header class="editorial-section-heading">
        <p class="eyebrow">Construct</p>
        <h2 id="construct-title">The unit is the decision</h2>
        <p>A critical hit can flip a match, so results alone say little. Two protocols grade the choices themselves.</p>
      </header>
      <div class="construct-grid">
        <article>
          <span>Battle position</span>
          <h3>How did this action compare?</h3>
          <p>
            Rebuild a recorded turn and evaluate each request-derived action Showdown accepts under common random draws.
            The submitted action gets a reference-relative score for that position, opponent, horizon, and sampling
            budget.
          </p>
        </article>
        <article>
          <span>Connected episode</span>
          <h3>Did later choices use the plan?</h3>
          <p>
            A draft season makes each seat commit early: spend a budget on ten Pokémon, then plan and build for each
            opponent. The record links those choices to later builds, trades, brings, and battle turns.
          </p>
        </article>
      </div>
      <aside class="construct-bridge">
        <span>Long episode · internal environment</span>
        <p>
          The Draft Circuit packages one eight-seat season as a single verifiers episode. It connects eight separately
          configured player runtimes to the TypeScript referee and pinned simulator. The internal package exists, but it
          has not been published or validated for hosted execution.
        </p>
        <a
          href={`${REPOSITORY_ROOT}/blob/main/docs/evaluation-plan.md#vgc-draft-circuit-v1`}
          target="_blank"
          rel="noreferrer"
        >
          Draft Circuit status <span aria-hidden="true">↗</span>
        </a>
      </aside>
      <div class="construct-boundary" role="note">
        The record shows what each seat saw, said, and submitted — and what the simulator accepted. It cannot show what
        a model privately believed, prove a written rationale caused the move, or predict behavior outside this game.
      </div>
    </section>
  );
}

function StaticPositionMethod() {
  return (
    <section class="method-section" aria-labelledby="position-method-title">
      <header class="editorial-section-heading">
        <p class="eyebrow">Static positions</p>
        <h2 id="position-method-title">Reproduce, fork, then measure</h2>
        <p>The model sees a position and picks one numbered action. How it reasons is its own business.</p>
      </header>
      <ol class="method-steps">
        {POSITION_STEPS.map((step) => (
          <li key={step.index}>
            <span class="method-step-index">{step.index}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div class="access-ledger">
        {SEAT_ACCESS.map((column) => (
          <section class={`access-col access-${column.tone}`} key={column.label}>
            <h3>{column.label}</h3>
            <ul>
              {column.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <aside class="method-status">
        <p>The position task is still a prototype. It is not a released evaluation.</p>
        <a
          href={`${REPOSITORY_ROOT}/blob/main/docs/evaluation-plan.md#vgc-positions-v1`}
          target="_blank"
          rel="noreferrer"
        >
          Position package status and release gates <span aria-hidden="true">↗</span>
        </a>
      </aside>
    </section>
  );
}

function ConnectedEpisodeMethod() {
  return (
    <section class="method-section" aria-labelledby="episode-method-title">
      <header class="editorial-section-heading">
        <p class="eyebrow">Connected episode</p>
        <h2 id="episode-method-title">The season is one long episode</h2>
        <p>Picks, games, and seats inside a season are connected, so the whole circuit reads as a single record.</p>
      </header>
      <ol class="method-steps">
        {EPISODE_STEPS.map((step) => (
          <li key={step.index}>
            <span class="method-step-index">{step.index}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div class="episode-boundary" role="note">
        The joins are mechanical: drafted to built, built to brought, submitted to accepted. Claims about adaptation or
        plan-following need complete records, controlled comparisons, and repeated whole-circuit runs. Standings
        describe a season; they are not the result being measured.
      </div>
    </section>
  );
}

function RecordedTurn({ trace }: { trace: SelectedTraceView }) {
  const evidence = trace.turn;
  return (
    <section class="method-section" aria-labelledby="recorded-turn-title">
      <header class="editorial-section-heading compact">
        <p class="eyebrow">Recorded example</p>
        <h2 id="recorded-turn-title">One recorded turn, fact by fact</h2>
        <p>Game 1, Turn 1 of a recorded series, pulled from the same published artifact as the home page.</p>
      </header>
      <figure class="turn-evidence-figure">
        <figcaption>
          <div>
            <p class="eyebrow">
              Selected {trace.seatModel} trace · {trace.seatAlias} in play
            </p>
            <h3>Seat input → model submission → replay check</h3>
          </div>
          <a href={TRACE_ARTIFACT_HREF} target="_blank" rel="noreferrer">
            Open selected evidence JSON <span aria-hidden="true">↗</span>
          </a>
        </figcaption>
        <div class="turn-evidence-grid">
          <article>
            <span class="turn-access-label">Seat-visible input</span>
            <h4>State excerpt and incoming notebook</h4>
            <pre>
              <code>{evidence.promptExcerpt}</code>
            </pre>
            <details>
              <summary>Incoming notebook</summary>
              <pre>
                <code>{evidence.incomingNotebook}</code>
              </pre>
            </details>
          </article>
          <article>
            <span class="turn-access-label">Recorded model submission</span>
            <div class="turn-actors" aria-hidden="true">
              {trace.firstActions.map((label) => (
                <Sprite id={trace.sprites[label.split(' — ')[0]!] ?? ''} size={44} key={label} />
              ))}
            </div>
            <h4>{trace.firstActions.join(' + ')}</h4>
            <blockquote>“{evidence.rationale}”</blockquote>
            <code class="turn-command">{evidence.submittedCommand}</code>
          </article>
          <article>
            <span class="turn-access-label access-referee">Release-time check</span>
            <h4>Recorded command replay</h4>
            <p>
              Replaying the recorded command today, the pinned referee{' '}
              {evidence.replayAccepted ? 'accepted' : 'rejected'} choice index {evidence.choiceIndex}. The replay is
              stored beside the original record as a separate fact.
            </p>
          </article>
          <article>
            <span class="turn-access-label access-gap">Artifact boundary</span>
            <h4>Where the excerpt ends</h4>
            <p>
              The excerpt stops after the first action — later turns, the between-game reflection, and the next game sit
              outside it. The source run also predates our records of the exact battle prompt and app revision.
            </p>
          </article>
        </div>
      </figure>
    </section>
  );
}

function ValidityLimits() {
  return (
    <section class="method-section" aria-labelledby="limits-title">
      <header class="editorial-section-heading compact">
        <p class="eyebrow">Validity limits</p>
        <h2 id="limits-title">Different evidence answers different questions</h2>
        <p>Each protocol answers a narrow question. Here is what each one leaves open.</p>
      </header>
      <div class="method-gap-grid">
        <article>
          <h3>The reference has limits</h3>
          <p>
            Short-horizon value under sampled opponent responses can miss setup moves, information plays, and long-term
            positioning. Every score is relative to its declared reference.
          </p>
        </article>
        <article>
          <h3>Luck and confounds</h3>
          <p>
            Model, provider, scaffold, board, schedule, and battle luck move together. A comeback win by itself leaves
            open which decision earned it.
          </p>
        </article>
        <article>
          <h3>What text can show</h3>
          <p>
            A written rationale is recorded output. Claims about belief or understanding need controlled comparisons,
            larger samples, and validation beyond this game.
          </p>
        </article>
      </div>
    </section>
  );
}

function Sources({ onOpenDocs }: { onOpenDocs: () => void }) {
  return (
    <section class="method-section" aria-labelledby="sources-title">
      <header class="editorial-section-heading compact">
        <p class="eyebrow">Sources</p>
        <h2 id="sources-title">Canonical contracts and prior work</h2>
        <p>The project documents carry the details; the related-work page sets the context.</p>
      </header>
      <nav class="canonical-links" aria-label="Method sources">
        <a href={`${REPOSITORY_ROOT}/blob/main/docs/measurement.md`} target="_blank" rel="noreferrer">
          Measurement
        </a>
        <a href={`${REPOSITORY_ROOT}/blob/main/docs/evaluation-plan.md`} target="_blank" rel="noreferrer">
          Evaluation plan
        </a>
        <a href={`${REPOSITORY_ROOT}/blob/main/docs/architecture.md`} target="_blank" rel="noreferrer">
          Architecture
        </a>
        <a href={`${REPOSITORY_ROOT}/blob/main/docs/related-work.md`} target="_blank" rel="noreferrer">
          Related work
        </a>
        <button type="button" class="button" onClick={onOpenDocs}>
          Open Docs index
        </button>
      </nav>
    </section>
  );
}

export function MethodView({ trace, onOpenDocs }: MethodViewProps) {
  return (
    <div class="public-ia public-page">
      <header class="public-page-hero">
        <div>
          <p class="eyebrow">Method</p>
          <h1>How the experiments work</h1>
        </div>
        <p class="public-page-intro">
          Language models play a competitive Pokémon draft league: they draft on a budget, build for specific opponents,
          trade, and battle. Two protocols turn that record into evidence — one grades a single turn, the other follows
          the whole season.
        </p>
      </header>
      <ConstructBoundary />
      <StaticPositionMethod />
      <ConnectedEpisodeMethod />
      <div class="selected-trace-slot selected-trace-slot-method" aria-busy={trace ? 'false' : 'true'}>
        {trace ? (
          <RecordedTurn trace={trace} />
        ) : (
          <p class="selected-trace-status" role="status">
            Loading selected trace…
          </p>
        )}
      </div>
      <ValidityLimits />
      <Sources onOpenDocs={onOpenDocs} />
    </div>
  );
}
