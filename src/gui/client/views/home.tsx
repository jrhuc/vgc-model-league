import { useRef } from 'preact/hooks';

import type { SelectedTraceView } from '../../api';
import { Sprite } from '../components/sprite';

const TRACE_ARTIFACT = '/api/selected-trace/full.json';

function MonChip({ name, trace }: { name: string; trace: SelectedTraceView }) {
  return (
    <span class="mon-chip">
      <Sprite id={trace.sprites[name] ?? ''} size={24} />
      {name}
    </span>
  );
}

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
        <h3 id="choice-horizon-heading">Replay one turn, fork every legal action</h3>
        <p>
          The simulator rewinds to the recorded state, branches down each legal action, and scores the branches under
          the same luck.
        </p>
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
        <b>Evidence:</b> a score for the chosen action relative to its alternatives, in this one position.
      </figcaption>
    </figure>
  );
}

const COMPACT_SEASON_STAGES = [
  ['Draft 10 Pokémon', 'shared board, fixed budget'],
  ['Build six for an opponent', 'from the drafted ten'],
  ['Fresh bring, lead, and Bo3', 'ordinary VGC game loop'],
  ['Trade window', 'offers and free agents mid-season'],
  ['Finish the round robin', 'every seat plays every seat'],
  ['Playoffs', 'top seeds advance'],
  ['Season review', 'written self-assessment'],
] as const;

function WholeCircuitDiagram({ onOpenMethod }: { onOpenMethod: () => void }) {
  return (
    <figure class="horizon-card circuit-horizon" aria-labelledby="circuit-horizon-heading">
      <div class="horizon-card-copy">
        <p class="eyebrow">Draft season</p>
        <h3 id="circuit-horizon-heading">One season, one paper trail</h3>
        <p>Each matchup turns a drafted ten into a fresh six, a bring of four, and a best-of-three.</p>
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
        <b>Evidence:</b> one seat’s decisions, linked in order across the season.{' '}
        <button type="button" class="text-link" onClick={onOpenMethod}>
          See the season protocol →
        </button>
      </figcaption>
    </figure>
  );
}

const RECORD_KINDS = [
  ['written', 'Model-written'],
  ['commit', 'Binding commitment'],
  ['check', 'Harness-measured'],
] as const;

type RecordKind = (typeof RECORD_KINDS)[number][0];

const RECORD_STAGES: ReadonlyArray<{
  stage: string;
  detail: string;
  artifacts: ReadonlyArray<readonly [RecordKind, string]>;
}> = [
  {
    stage: 'Draft',
    detail: 'Ten exclusive picks from a shared points board.',
    artifacts: [
      ['written', 'rationale for every pick'],
      ['commit', 'pick + price paid'],
      ['check', 'flag when the harness picked instead'],
    ],
  },
  {
    stage: 'Teambuild',
    detail: 'Six of the ten get full sets for the coming opponent.',
    artifacts: [
      ['written', 'build plan'],
      ['commit', 'six sets — moves, items, EVs'],
      ['check', 'attempts + auto-repair log'],
    ],
  },
  {
    stage: 'Battle',
    detail: 'Bring four, lead two, then turn-by-turn play.',
    artifacts: [
      ['written', 'rationale each turn'],
      ['commit', 'submitted command'],
      ['check', 'simulator accept / reject'],
      ['check', 'latency + token spend'],
    ],
  },
  {
    stage: 'Between games',
    detail: 'A short reflection after every game of the set.',
    artifacts: [
      ['written', 'result summary'],
      ['written', 'planned adjustment'],
      ['commit', 'notebook carried into the next game'],
    ],
  },
  {
    stage: 'Trade window',
    detail: 'Mid-season offers and free agency.',
    artifacts: [
      ['written', 'offer message + both sides’ reasoning'],
      ['commit', 'accepted / declined'],
      ['commit', 'add–drop swaps'],
    ],
  },
  {
    stage: 'Season review',
    detail: 'A final written self-assessment.',
    artifacts: [
      ['written', 'did well / did poorly / would change'],
      ['commit', 'final standing'],
    ],
  },
];

function RecordLedger() {
  return (
    <section class="home-section" aria-labelledby="record-title">
      <header class="editorial-section-heading">
        <p class="eyebrow">The record</p>
        <h2 id="record-title">What gets written down</h2>
        <p>
          Every stage leaves artifacts. Text the model writes is kept verbatim, commitments bind its later play, and the
          harness measures the rest. All of it ships with the season archive.
        </p>
      </header>
      <div class="record-ledger">
        {RECORD_STAGES.map((row, index) => (
          <div class="record-row" key={row.stage}>
            <span class="record-index" aria-hidden="true">
              0{index + 1}
            </span>
            <div class="record-copy">
              <h3>{row.stage}</h3>
              <p>{row.detail}</p>
            </div>
            <ul class="record-chips" aria-label={`Artifacts recorded during ${row.stage.toLowerCase()}`}>
              {row.artifacts.map(([kind, label]) => (
                <li class={`record-chip-${kind}`} key={label}>
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p class="record-legend" aria-hidden="true">
        {RECORD_KINDS.map(([kind, label]) => (
          <span class={`record-chip-${kind}`} key={kind}>
            {label}
          </span>
        ))}
      </p>
    </section>
  );
}

function WorkedExampleTrace({ trace }: { trace: SelectedTraceView }) {
  return (
    <article class="worked-trace" aria-labelledby="worked-trace-title">
      <header class="worked-trace-header">
        <div>
          <p class="eyebrow">Selected recorded trace</p>
          <h2 id="worked-trace-title">
            {trace.seatModel}’s sand plan, in {trace.eventCount} recorded moments
          </h2>
          <p class="lede">
            Eight moments from a recorded {trace.seatModel} season — the seat played anonymously as {trace.seatAlias}:
            two mid-draft picks, a matchup build, the preview, the first submitted battle action, trade-window
            decisions, and the closing review. The complete artifact is linked below.
          </p>
        </div>
        <ul class="trace-verification" aria-label="Selected trace contents">
          {[`${trace.eventCount} recorded moments`, 'Model outputs kept verbatim', 'Commands replay-checked'].map(
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
          <ul class="trace-six" aria-label="Registered six">
            {trace.registeredSix.map((name) => (
              <li key={name}>
                <Sprite id={trace.sprites[name] ?? ''} size={52} />
                <span>{name}</span>
              </li>
            ))}
          </ul>
          <dl class="trace-facts">
            <div>
              <dt>Lead</dt>
              <dd>
                {trace.lead.map((name) => (
                  <MonChip name={name} trace={trace} key={name} />
                ))}
              </dd>
            </div>
            <div>
              <dt>Back</dt>
              <dd>
                {trace.back.map((name) => (
                  <MonChip name={name} trace={trace} key={name} />
                ))}
              </dd>
            </div>
            <div>
              <dt>First submitted battle action</dt>
              <dd>{trace.firstActions.join(' + ')}</dd>
            </div>
          </dl>
          <p class="trace-replay-note">
            Replaying it today, the pinned simulator {trace.turn.replayAccepted ? 'accepted' : 'rejected'} the recorded
            command.
          </p>
        </section>

        <section class="trace-stage" aria-labelledby="trace-window-title">
          <span class="trace-stage-number" aria-hidden="true">
            06–07 / {trace.eventCount}
          </span>
          <h3 id="trace-window-title">Offer declined &amp; free agency</h3>
          <p class="trace-offer">
            <MonChip name={trace.transaction.declinedOffer.give} trace={trace} /> for{' '}
            <MonChip name={trace.transaction.declinedOffer.get} trace={trace} /> — declined
          </p>
          <ul class="trace-swaps" aria-label="Free-agent swaps">
            {trace.transaction.swaps.map((swap) => (
              <li key={swap.drop}>
                <span>
                  Drop <MonChip name={swap.drop} trace={trace} />
                </span>
                <span aria-hidden="true">→</span>
                <span>
                  Add <MonChip name={swap.add} trace={trace} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section class="trace-stage trace-review" aria-labelledby="trace-review-title">
          <span class="trace-stage-number" aria-hidden="true">
            08 / {trace.eventCount}
          </span>
          <h3 id="trace-review-title">Closing review</h3>
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
          The artifact holds {trace.eventCount} stage events; its battle excerpt stops after the first submitted action.
          What the original run recorded and what our replay verified are stored as separate fields.{' '}
          <a href={TRACE_ARTIFACT} target="_blank" rel="noreferrer">
            Open the complete selected evidence artifact <span aria-hidden="true">↗</span>
          </a>
        </p>
      </footer>
    </article>
  );
}

const TRUTH_ITEMS = [
  ['Format', 'Pokémon Champions VGC 2026 · Reg M-B · Bo3 doubles'],
  ['Simulator', 'Pinned Pokémon Showdown revision'],
  ['Record', 'Every decision + its written rationale'],
  ['Identity', 'Anonymous in play · named at publication'],
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
            Model seats draft on a budget, write plans, trade, and battle through full seasons. Every decision is
            recorded with the reasoning behind it — and any turn can be replayed against the moves not taken.
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
          {trace.lead.map((name, index) => (
            <img
              class={`hero-sprite hero-sprite-${index + 1}`}
              src={`/sprites/${trace.sprites[name]}.png`}
              alt=""
              key={name}
            />
          ))}
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
            One lens replays a single turn and compares the chosen action with every legal alternative. The other
            follows a whole season and asks whether early commitments showed up in later play.
          </p>
        </header>
        <div class="horizons-grid">
          <ChoiceMicroscopeDiagram />
          <WholeCircuitDiagram onOpenMethod={onOpenMethod} />
        </div>
      </section>

      <RecordLedger />

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
