import type { ComponentChildren } from 'preact';

export function MatchMenu({ count, children }: { count: number; children: ComponentChildren }) {
  return (
    <div class="match-menu">
      <p class="match-menu-head">
        <span>
          <span class="live-dot" aria-hidden="true" /> Now playing
        </span>
        <span>
          {count} match{count === 1 ? '' : 'es'}
        </span>
      </p>
      <ul>{children}</ul>
    </div>
  );
}

export function MatchMenuRow({
  eyebrow,
  sides,
  state,
  onWatch,
}: {
  eyebrow: ComponentChildren;
  sides: ComponentChildren;
  state: ComponentChildren;
  onWatch?: (() => void) | undefined;
}) {
  return (
    <li class="match-menu-row">
      <p class="match-menu-eyebrow">{eyebrow}</p>
      <p class="match-menu-sides">{sides}</p>
      <p class="match-menu-state">{state}</p>
      {onWatch ? (
        <button type="button" class="match-menu-watch" onClick={onWatch}>
          Watch live
        </button>
      ) : null}
    </li>
  );
}
