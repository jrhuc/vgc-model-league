import type { SelectedTraceView } from '../../api';

interface MethodViewProps {
  trace: SelectedTraceView;
  onOpenDocs: () => void;
}

const REPOSITORY_ROOT = 'https://github.com/jrhuc/vgc-model-league';
const TRACE_ARTIFACT = '/api/selected-trace/full.json';

const POSITION_STEPS = [
  {
    index: '01',
    title: 'Reproduce',
    body: 'Replay the pinned format, Showdown revision, seed, teams, and submitted actions. Reject any state mismatch.',
  },
  {
    index: '02',
    title: 'Fork accepted actions',
    body: 'Enumerate joint actions from the tested seat’s request and retain only commands accepted by native Showdown.',
  },
  {
    index: '03',
    title: 'Measure on held-out draws',
    body: 'Use independent common-draw qualification and measurement panels. Report uncertainty and the named reference.',
  },
  {
    index: '04',
    title: 'Separate artifacts',
    body: 'Keep model-visible tasks apart from scores, snapshots, opponent-private requests, draws, and sealed matrices.',
  },
] as const;

const EPISODE_STEPS = [
  {
    index: '01',
    title: 'Commit scarce resources',
    body: 'Seats draft exclusive, budgeted rosters against the same board and public schedule.',
  },
  {
    index: '02',
    title: 'Prepare for an opponent',
    body: 'Each seat records a plan and registers one legal six from its drafted ten for the matchup.',
  },
  {
    index: '03',
    title: 'Choose and play',
    body: 'Fresh bring-four and lead-two choices precede every game; Showdown resolves simultaneous actions and variance.',
  },
  {
    index: '04',
    title: 'Join later evidence',
    body: 'Authorized handoffs, later builds, accepted actions, transactions, and reviews remain bound to the same seat.',
  },
] as const;

function ConstructBoundary() {
  return (
    <section class="method-section" aria-labelledby="construct-title">
      <header class="editorial-section-heading">
        <p class="eyebrow">Construct</p>
        <h2 id="construct-title">Decisions, not standings</h2>
        <p>One protocol compares a battle choice; another links commitments across a draft season.</p>
      </header>
      <div class="construct-grid">
        <article>
          <span>Battle position</span>
          <h3>Reference-relative choice quality</h3>
          <p>
            A forkable simulator can compare accepted actions from one reproduced state under shared draws. The result
            is conditional on that state, horizon, opponent-action distribution, and continuation policy.
          </p>
        </article>
        <article>
          <span>Connected episode</span>
          <h3>Commitment and later execution</h3>
          <p>
            A contested draft, opponent-specific construction, preview, and play place earlier recorded plans and
            resource commitments beside later choices inside this protocol.
          </p>
        </article>
      </div>
      <div class="construct-boundary" role="note">
        Joined records establish what was visible, returned, submitted, and accepted. They do not reveal private
        beliefs, make generated rationales causal, or establish transfer beyond the tested environment.
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
        <p>The model selects one numbered complete joint action; no strategy or reasoning procedure is prescribed.</p>
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
      <aside class="method-status">
        <p>
          The tested seat sees anonymized public history, its own request, accepted candidates, and the output schema.
          Source identity and action, rationales, notebooks, private requests, snapshots, and grader state stay hidden.
        </p>
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
        <h2 id="episode-method-title">Keep the whole circuit as the unit</h2>
        <p>A pick, game, or seat is not an independent replication of a shared multi-seat season.</p>
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
        Mechanical joins can test drafted-to-built, built-to-brought, and submitted-to-accepted links. Claims about
        adaptation, memory use, or plan fidelity additionally require complete handoffs, controlled interventions or an
        audited rubric, and circuit-level uncertainty. Natural standings remain descriptive.
      </div>
    </section>
  );
}

function RecordedTurn({ trace }: { trace: SelectedTraceView }) {
  const evidence = trace.turn;
  return (
    <section class="method-section" aria-labelledby="recorded-turn-title">
      <header class="editorial-section-heading compact">
        <p class="eyebrow">Artifact-backed demonstration</p>
        <h2 id="recorded-turn-title">One recorded turn, with facts kept distinct</h2>
        <p>Game 1, Turn 1 comes from the same hash-checked selected-trace endpoint used on Home.</p>
      </header>
      <figure class="turn-evidence-figure">
        <figcaption>
          <div>
            <p class="eyebrow">Selected {trace.seatAlias} trace</p>
            <h3>Seat input → model submission → replay check</h3>
          </div>
          <a href={TRACE_ARTIFACT} target="_blank" rel="noreferrer">
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
            <h4>{trace.firstActions.join(' + ')}</h4>
            <blockquote>“{evidence.rationale}”</blockquote>
            <code class="turn-command">{evidence.submittedCommand}</code>
          </article>
          <article>
            <span class="turn-access-label access-referee">Release-time check</span>
            <h4>Recorded command replay</h4>
            <p>
              The pinned referee {evidence.replayAccepted ? 'accepted' : 'did not accept'} choice index{' '}
              {evidence.choiceIndex}. The source record and release-time reconstruction remain separate facts.
            </p>
          </article>
          <article>
            <span class="turn-access-label access-gap">Artifact boundary</span>
            <h4>No later handoff is demonstrated</h4>
            <p>
              The excerpt ends after the first action. It has no terminal-game event, between-game reflection, or
              next-game prompt, and the legacy source lacks the exact historical battle system prompt and app revision.
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
        <p>Action values, linked traces, and outcomes cannot substitute for one another.</p>
      </header>
      <div class="method-gap-grid">
        <article>
          <h3>Reference dependence</h3>
          <p>
            Short-horizon material value under sampled accepted opponent actions and random continuations can miss
            setup, information, positioning, and long-term team value. It evaluates the realized hidden state.
          </p>
        </article>
        <article>
          <h3>Confounding and variance</h3>
          <p>
            Model, provider, scaffold, board, schedule, opponents, and battle luck may change together. A result or
            comeback does not identify which decision caused it.
          </p>
        </article>
        <article>
          <h3>Scope and interpretation</h3>
          <p>
            Generated text is observable output, not a belief report. Stronger claims need frozen treatments, matched
            conditions, complete provenance, larger samples, uncertainty, and domain-specific validation.
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
        <p>Project documents own the details; the related-work page keeps external comparisons bounded.</p>
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
          <h1>How the evaluation works</h1>
        </div>
        <p class="public-page-intro">
          Compare one replayable battle choice or follow linked decisions across a draft-season episode. In both cases,
          keep recorded facts, simulator checks, measurements, and interpretation separate.
        </p>
      </header>
      <ConstructBoundary />
      <StaticPositionMethod />
      <ConnectedEpisodeMethod />
      <RecordedTurn trace={trace} />
      <ValidityLimits />
      <Sources onOpenDocs={onOpenDocs} />
    </div>
  );
}
