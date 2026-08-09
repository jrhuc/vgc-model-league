import type { PublicTeamSheetSetView, TeambuildSetView } from '../../api';
import { STAT_ORDER } from './boardbrowser';
import { ItemIcon, Sprite } from './sprite';

export function SetCard({ set }: { set: PublicTeamSheetSetView }) {
  const privateSet = 'evs' in set ? (set as TeambuildSetView) : null;
  const evs = privateSet
    ? STAT_ORDER.filter((stat) => privateSet.evs[stat])
        .map((stat) => `${privateSet.evs[stat]}\u00a0${stat}`)
        .join('\u00a0· ') || 'no EVs'
    : '';
  return (
    <article class={`teambuild-set ${privateSet?.repaired ? 'repaired' : ''}`}>
      <header class="teambuild-set-head">
        <Sprite id={set.spriteId} size={28} />
        <div class="teambuild-set-identity">
          <b>{set.species}</b>
          <small>{`${set.ability}\u00a0· ${set.nature}`}</small>
          <span class="teambuild-set-item">
            {set.item ? (
              <>
                <ItemIcon item={set.item} size={14} />
                <span title={set.item}>{set.item}</span>
              </>
            ) : (
              <span class="teambuild-set-item-empty">—</span>
            )}
          </span>
        </div>
      </header>
      <ul>
        {set.moves.map((move) => (
          <li key={move}>{move}</li>
        ))}
      </ul>
      {privateSet ? <footer class="teambuild-evs">{evs}</footer> : null}
    </article>
  );
}
