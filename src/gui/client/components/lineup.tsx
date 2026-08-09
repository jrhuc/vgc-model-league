import type { PublicTeamSheetSetView } from '../../api';
import { Mark } from './mark';
import { SetCard } from './setcard';

export function TeamLineup({
  sides,
}: {
  sides: Array<{
    key: string;
    model: string;
    label: string;
    team: Array<PublicTeamSheetSetView> | undefined;
  }>;
}) {
  return (
    <div class="lineup-grid">
      {sides.map((side) => (
        <section class="lineup-side" key={side.key}>
          <header class="lineup-side-head">
            <Mark spec={side.model} size={18} />
            <h3>{side.label}</h3>
          </header>
          {side.team && side.team.length > 0 ? (
            <div class="teambuild-sets">
              {side.team.map((set) => (
                <SetCard set={set} key={set.species} />
              ))}
            </div>
          ) : (
            <p class="muted">No stored team sheet.</p>
          )}
        </section>
      ))}
    </div>
  );
}
