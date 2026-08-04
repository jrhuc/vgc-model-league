import type { TeambuildSetView } from '../../api';
import { STAT_ORDER } from './boardbrowser';
import { ItemIcon, Sprite } from './sprite';

export function SetCard({ set }: { set: TeambuildSetView }) {
  return (
    <div class={`teambuild-set ${set.repaired ? 'repaired' : ''}`}>
      <div class="teambuild-set-head">
        <Sprite id={set.spriteId} size={26} />
        <b>{set.species}</b>
        {set.item ? (
          <span class="teambuild-set-item">
            <ItemIcon item={set.item} size={16} /> {set.item}
          </span>
        ) : null}
      </div>
      <small>
        {set.ability} · {set.nature}
      </small>
      <ul>
        {set.moves.map((move) => (
          <li key={move}>{move}</li>
        ))}
      </ul>
      <small class="teambuild-evs">
        {STAT_ORDER.filter((stat) => set.evs[stat])
          .map((stat) => `${set.evs[stat]} ${stat}`)
          .join(' / ') || 'no EVs'}
      </small>
    </div>
  );
}
