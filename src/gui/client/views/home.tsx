import { useRef } from 'preact/hooks';

import type { SelectedTraceView } from '../../api';

const TRACE_ARTIFACT = '/api/selected-trace/full.json';

interface HomeViewProps {
  trace: SelectedTraceView;
  onOpenMethod: () => void;
  onOpenDocs: () => void;
}

function ChoiceMicroscopeDiagram() {
  const viewport = useRef<HTMLDivElement>(null);
  const scroll = (direction: -1 | 1) => {
    if (!viewport.current) return;
    viewport.current.scrollLeft += direction * Math.max(220, viewport.current.clientWidth * 0.7);
  };

  return (
    <figure class="horizon-card" aria-labelledby="choice-horizon-heading">
      <div class="horizon-card-copy">
        <p class="eyebrow">Battle turn</p>
        <h3 id="choice-horizon-heading">Compare actions from one recorded position</h3>
        <p>Reproduce the state, fork each accepted action, and measure candidates with the same reference.</p>
      </div>
      <div class="choice-diagram-scroll" ref={viewport}>
        <svg
          class="choice-diagram"
          viewBox="0 0 720 250"
          role="img"
          aria-labelledby="choice-diagram-title choice-diagram-desc"
        >
          <title id="choice-diagram-title">Recorded turn comparison flow</title>
          <desc id="choice-diagram-desc">
            A recorded turn is replayed, branched into accepted actions, and returned as a comparison under shared
            random draws.
          </desc>
          <defs>
            <marker id="choice-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8 Z" class="diagram-arrow-head" />
            </marker>
          </defs>
          <g class="diagram-flow">
            <path d="M108 125 H238" />
            <path d="M342 125 C410 125 406 45 475 45" />
            <path d="M342 125 H475" />
            <path d="M342 125 C410 125 406 205 475 205" />
            <path d="M580 45 C637 45 620 104 667 116" />
            <path d="M580 125 H655" />
            <path d="M580 205 C637 205 620 146 667 134" />
          </g>
          <g class="diagram-node diagram-node-source">
            <rect x="18" y="84" width="90" height="82" rx="2" />
            <text x="63" y="113">
              RECORDED
            </text>
            <text x="63" y="136">
              TURN
            </text>
          </g>
          <g class="diagram-node diagram-node-fork">
            <circle cx="290" cy="125" r="52" />
            <text x="290" y="129">
              REPLAY
            </text>
          </g>
          <g class="diagram-node diagram-node-action">
            <rect x="475" y="18" width="105" height="54" rx="2" />
            <rect x="475" y="98" width="105" height="54" rx="2" />
            <rect x="475" y="178" width="105" height="54" rx="2" />
            <text x="527" y="49">
              ACTION 0
            </text>
            <text x="527" y="129">
              ACTION 1
            </text>
            <text x="527" y="209">
              ACTION N
            </text>
          </g>
          <g class="diagram-node diagram-node-output">
            <circle cx="678" cy="125" r="27" />
            <text x="678" y="129">
              COMPARISON
            </text>
          </g>
        </svg>
      </div>
      <fieldset class="choice-scroll-controls">
        <legend class="visually-hidden">Scroll action comparison diagram</legend>
        <button type="button" onClick={() => scroll(-1)} aria-label="Previous part of action comparison diagram">
          ← Prev
        </button>
        <span>Narrow-screen diagram controls</span>
        <button type="button" onClick={() => scroll(1)} aria-label="Next part of action comparison diagram">
          Next →
        </button>
      </fieldset>
      <figcaption>
        <b>Evidence:</b> a reference-relative comparison for one reproduced choice, not a match or season score.
      </figcaption>
    </figure>
  );
}

const COMPACT_SEASON_STAGES = [
  ['Draft 10 Pokémon', 'exclusive points board'],
  ['Build six for an opponent', 'from the drafted ten'],
  ['Fresh bring, lead, and Bo3', 'ordinary VGC game loop'],
  ['Transaction barrier', 'after configured weeks'],
  ['Finish the round robin', 'repeat opponent loop'],
  ['Playoffs', 'qualification dependent'],
  ['Season review', 'recorded after the season'],
] as const;

function WholeCircuitDiagram({ onOpenMethod }: { onOpenMethod: () => void }) {
  return (
    <figure class="horizon-card circuit-horizon" aria-labelledby="circuit-horizon-heading">
      <div class="horizon-card-copy">
        <p class="eyebrow">Draft season</p>
        <h3 id="circuit-horizon-heading">Follow commitments across opponents</h3>
        <p>Each matchup turns a drafted ten into a fresh six, bring, lead, and best-of-three.</p>
      </div>
      <div class="compact-season-route">
        <svg class="compact-season-flow" viewBox="0 0 40 700" preserveAspectRatio="none" aria-hidden="true">
          <path class="route-flow-track" d="M20 0 V700" />
          <path class="route-flow-line" d="M20 0 V700" />
        </svg>
        <ol aria-label="Draft season route">
          {COMPACT_SEASON_STAGES.map(([stage, detail], index) => (
            <li key={stage}>
              <span class="route-node" aria-hidden="true" />
              <span class="circuit-stage-index">0{index + 1}</span>
              <span>
                <strong>{stage}</strong>
                <small>{detail}</small>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <figcaption>
        <b>Evidence:</b> linked decisions across time, not a complete causal account.{' '}
        <button type="button" class="text-link" onClick={onOpenMethod}>
          See the season protocol →
        </button>
      </figcaption>
    </figure>
  );
}

function WorkedExampleTrace({ trace }: { trace: SelectedTraceView }) {
  return (
    <article class="worked-trace" aria-labelledby="worked-trace-title">
      <header class="worked-trace-header">
        <div>
          <p class="eyebrow">Selected recorded trace</p>
          <h2 id="worked-trace-title">
            {trace.seatModel}’s sand plan across {trace.eventCount} selected stage events
          </h2>
          <p class="lede">
            This is selected evidence from a recorded {trace.seatModel} run — the seat played anonymously as{' '}
            {trace.seatAlias}: two mid-draft picks, matchup construction, preview, the first submitted battle action,
            transactions, and a terminal review output. It is not a full season record or complete replay.
          </p>
        </div>
        <ul class="trace-verification" aria-label="Selected trace contents">
          {[`${trace.eventCount} selected stage events`, 'Recorded source outputs', 'Release-time replay facts'].map(
            (status) => (
              <li key={status}>{status}</li>
            ),
          )}
        </ul>
      </header>

      <div class="trace-limit" role="note">
        Selected outputs show what the model said and submitted. They do not reveal hidden beliefs, establish learning,
        or control for battle variance.
      </div>

      <div class="trace-grid">
        <section class="trace-stage" aria-labelledby="trace-draft-title">
          <span class="trace-stage-number" aria-hidden="true">
            01–02 / {trace.eventCount}
          </span>
          <h3 id="trace-draft-title">Two mid-draft picks</h3>
          {trace.draftQuotes.map((quote) => (
            <blockquote key={quote.stage}>
              <span class="trace-quote-label">
                Overall pick {quote.pick} · {quote.stage} · recorded model output
              </span>
              <p>“{quote.text}”</p>
            </blockquote>
          ))}
        </section>

        <section class="trace-stage" aria-labelledby="trace-registration-title">
          <span class="trace-stage-number" aria-hidden="true">
            03–05 / {trace.eventCount}
          </span>
          <h3 id="trace-registration-title">Six, four, and the first action</h3>
          <dl class="trace-facts">
            <div>
              <dt>Registered six</dt>
              <dd>{trace.registeredSix.join(' · ')}</dd>
            </div>
            <div>
              <dt>Lead</dt>
              <dd>{trace.lead.join(' + ')}</dd>
            </div>
            <div>
              <dt>Back</dt>
              <dd>{trace.back.join(' + ')}</dd>
            </div>
            <div>
              <dt>First submitted battle action</dt>
              <dd>{trace.firstActions.join(' + ')}</dd>
            </div>
          </dl>
          <p class="trace-replay-note">
            Release-time replay {trace.turn.replayAccepted ? 'accepted' : 'did not accept'} the recorded command under
            the pinned referee.
          </p>
        </section>

        <section class="trace-stage" aria-labelledby="trace-window-title">
          <span class="trace-stage-number" aria-hidden="true">
            06–07 / {trace.eventCount}
          </span>
          <h3 id="trace-window-title">Offer declined &amp; free agency</h3>
          <p class="trace-offer">
            {trace.transaction.declinedOffer.give} for {trace.transaction.declinedOffer.get} — declined
          </p>
          <ul class="trace-swaps" aria-label="Free-agent swaps">
            {trace.transaction.swaps.map((swap) => (
              <li key={swap.drop}>
                <span>Drop {swap.drop}</span>
                <span aria-hidden="true">→</span>
                <span>Add {swap.add}</span>
              </li>
            ))}
          </ul>
        </section>

        <section class="trace-stage trace-review" aria-labelledby="trace-review-title">
          <span class="trace-stage-number" aria-hidden="true">
            08 / {trace.eventCount}
          </span>
          <h3 id="trace-review-title">Selected terminal output</h3>
          <blockquote>
            <span class="trace-quote-label">{trace.terminalQuote.stage} · recorded model output</span>
            <p>“{trace.terminalQuote.text}”</p>
          </blockquote>
        </section>
      </div>

      <footer class="trace-publication">
        <span class="trace-publication-mark" aria-hidden="true">
          ↗
        </span>
        <p>
          The selected artifact contains {trace.eventCount} stage events and stops its battle excerpt after the first
          submitted action. Recorded-source and release-time replay facts remain distinct.{' '}
          <a href={TRACE_ARTIFACT} target="_blank" rel="noreferrer">
            Open the complete selected evidence artifact <span aria-hidden="true">↗</span>
          </a>
        </p>
      </footer>
    </article>
  );
}

const TRUTH_ITEMS = [
  ['Format', 'Pokémon Champions VGC 2026 · Regulation M-B · best-of-three doubles'],
  ['Simulator', 'Pinned Pokémon Showdown revision'],
] as const;

export function HomeView({ trace, onOpenMethod, onOpenDocs }: HomeViewProps) {
  return (
    <div class="public-ia public-home">
      <section class="public-hero" aria-labelledby="home-title">
        <div class="public-hero-grid" aria-hidden="true" />
        <div class="public-hero-copy">
          <p class="eyebrow">Language models play competitive Pokémon</p>
          <h1 id="home-title">How well does a language model decide when the game is VGC?</h1>
          <p class="public-hero-lede">
            We study decisions at two scales: one replayable battle choice and a linked draft-season horizon.
          </p>
          <div class="public-hero-actions">
            <button type="button" class="button primary" onClick={onOpenMethod}>
              Read the method
            </button>
            <button type="button" class="button hero-secondary" onClick={onOpenDocs}>
              Open Docs
            </button>
          </div>
        </div>
        <div class="public-hero-visual" aria-hidden="true">
          <svg viewBox="0 0 430 430">
            <title>Decorative decision field</title>
            <circle cx="215" cy="215" r="152" />
            <circle cx="215" cy="215" r="93" />
            <path d="M63 215 H367 M215 63 V367" />
            <path d="M107 107 L323 323 M323 107 L107 323" />
            <rect x="188" y="188" width="54" height="54" transform="rotate(45 215 215)" />
            <circle class="hero-signal" cx="322" cy="107" r="8" />
            <circle class="hero-signal secondary" cx="108" cy="323" r="5" />
          </svg>
          <span class="hero-visual-label label-one">CHOICE</span>
          <span class="hero-visual-label label-two">CONTEXT</span>
          <span class="hero-visual-label label-three">EVIDENCE</span>
        </div>
      </section>

      <dl class="truth-strip" aria-label="Project facts">
        {TRUTH_ITEMS.map(([term, description]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>

      <section class="home-section" aria-labelledby="horizons-title">
        <header class="editorial-section-heading">
          <p class="eyebrow">Research shape</p>
          <h2 id="horizons-title">Two scales, two kinds of evidence</h2>
          <p>
            Action comparisons diagnose one reproduced choice. Linked events show how commitments meet later play. An
            internal frozen matchday environment bridges them: one construction-to-Bo3 tie replayed under isolated
            seats.
          </p>
        </header>
        <div class="horizons-grid">
          <ChoiceMicroscopeDiagram />
          <WholeCircuitDiagram onOpenMethod={onOpenMethod} />
        </div>
      </section>

      <WorkedExampleTrace trace={trace} />

      <aside class="home-cta" aria-label="Next steps">
        <div>
          <p class="eyebrow">Continue</p>
          <h2>Read the protocol or open the canonical project documents</h2>
        </div>
        <div>
          <button type="button" class="button primary" onClick={onOpenMethod}>
            Read Method
          </button>
          <button type="button" class="button" onClick={onOpenDocs}>
            Open Docs
          </button>
        </div>
      </aside>
    </div>
  );
}
