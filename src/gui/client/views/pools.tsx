import { useRef, useState } from 'preact/hooks';

import type { AppState, CreatePoolResponse, PoolInfo, TeamMemberView, ValidateResponse } from '../../api';
import { Dropdown } from '../components/dropdown';
import { api } from '../http';

interface Draft {
  key: number;
  id: string;
  paste: string;
  members: TeamMemberView[];
  problems: string[];
}

interface PoolsProps {
  app: AppState;
  onPools: (pools: PoolInfo[]) => void;
}

function newDraft(key: number): Draft {
  return { key, id: `team-${key}`, paste: '', members: [], problems: [] };
}

function Member({ member }: { member: TeamMemberView }) {
  const line = [member.item, member.ability].filter(Boolean).join(' · ');
  return (
    <div class="member">
      <b>{member.species}</b>
      <span>{line}</span>
      <span>{member.moves.join(' / ')}</span>
    </div>
  );
}

export function PoolsView({ app, onPools }: PoolsProps) {
  const [drafts, setDrafts] = useState<Draft[]>([newDraft(1), newDraft(2)]);
  const nextDraftKey = useRef(3);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [poolName, setPoolName] = useState('');
  const [format, setFormat] = useState(() =>
    app.formats.some((item) => item.id === app.defaultFormat) ? app.defaultFormat : (app.formats[0]?.id ?? ''),
  );
  const [message, setMessage] = useState({ text: '', cls: '' });
  const [creating, setCreating] = useState(false);

  const patchDraft = (index: number, patch: Partial<Draft>) => {
    setDrafts((previous) => previous.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const validate = (index: number) => {
    const draft = drafts[index];
    if (!draft) return;
    setMessage({ text: `Checking ${draft.id} with the local Showdown validator…`, cls: '' });
    api<ValidateResponse>('/api/team/validate', { paste: draft.paste, format })
      .then((data) => {
        patchDraft(index, { members: data.members, problems: data.problems });
        setMessage(
          data.problems.length
            ? { text: `Showdown found issues in ${draft.id}.`, cls: 'error' }
            : { text: `${draft.id} is legal and ready.`, cls: 'success' },
        );
      })
      .catch((error: Error) => {
        patchDraft(index, { members: [], problems: [error.message] });
        setMessage({ text: error.message, cls: 'error' });
      });
  };

  const pasteClipboard = (index: number) => {
    if (!navigator.clipboard?.readText) {
      patchDraft(index, { problems: ['Clipboard access is unavailable. Paste into the editor manually.'] });
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => patchDraft(index, { paste: text, members: [], problems: [] }))
      .catch(() => patchDraft(index, { problems: ['Clipboard access was denied. Paste into the editor manually.'] }));
  };

  const createPool = () => {
    setMessage({ text: 'Validating every team and saving the pool…', cls: '' });
    setCreating(true);
    api<CreatePoolResponse>('/api/pool', {
      name: poolName.trim(),
      format,
      teams: drafts.map((draft) => ({ id: draft.id, paste: draft.paste })),
    })
      .then((data) => {
        setMessage({ text: `Pool ${data.name} created`, cls: 'success' });
        onPools(data.pools);
      })
      .catch((error: Error) => setMessage({ text: error.message, cls: 'error' }))
      .finally(() => setCreating(false));
  };

  const formatOptions = app.formats.map((item) => ({ value: item.id, label: item.label, description: item.id }));

  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Reusable team pools</p>
          <h2>
            Create a
            <br />
            team pool
          </h2>
        </div>
        <p class="lede">
          Paste Showdown teambuilder exports, validate them, and save the pool for later runs. Create a new pool when
          teams change so earlier runs keep their original teams.
        </p>
      </div>
      <div class="pool-layout">
        <aside class="panel pool-rail">
          <div class="section-head">
            <div>
              <h3>Saved pools</h3>
              <p>Available to new runs.</p>
            </div>
          </div>
          <div class="pool-list">
            {app.pools.length === 0 ? (
              <div class="pool-item">
                <span>No pools yet.</span>
              </div>
            ) : (
              app.pools.map((pool) => (
                <div class="pool-item" key={pool.name}>
                  <b>{pool.name}</b>
                  <span>{pool.teamCount} teams</span>
                  <span>{pool.format}</span>
                </div>
              ))
            )}
          </div>
        </aside>
        <section class="panel builder">
          <div class="builder-intro">
            <div>
              <p class="eyebrow" style="color:#f3ce39">
                Validated with Pokémon Showdown
              </p>
              <h3>Team intake</h3>
              <p>
                Build each team in the official teambuilder and paste its Import/Export text here. Every set is checked
                against the selected format before the pool is saved.
              </p>
            </div>
            <a class="button" href="https://play.pokemonshowdown.com/teambuilder" target="_blank" rel="noreferrer">
              Open teambuilder ↗
            </a>
          </div>
          <div class="pool-form">
            <div class="field">
              <label class="field-label" for="poolName">
                New pool name
              </label>
              <input
                id="poolName"
                placeholder="regmb-202608"
                autocomplete="off"
                value={poolName}
                onInput={(event) => setPoolName(event.currentTarget.value)}
              />
            </div>
            <Dropdown
              id="poolFormat"
              label="Champions BO3 format"
              options={formatOptions}
              value={format}
              onChange={(value) => {
                setFormat(value);
                setDrafts((previous) => previous.map((draft) => ({ ...draft, members: [], problems: [] })));
              }}
            />
          </div>
          <div class="drafts">
            {drafts.map((draft, index) => (
              <article class={`draft ${expanded === index ? 'open' : ''}`} key={draft.key}>
                <div class="draft-head">
                  <div class="draft-number">{String(index + 1).padStart(2, '0')}</div>
                  <input
                    value={draft.id}
                    aria-label={`Team ${index + 1} id`}
                    onInput={(event) => patchDraft(index, { id: event.currentTarget.value })}
                  />
                  <div class="draft-summary">
                    {draft.problems.length ? (
                      <span class="bad-text">
                        Needs attention · {draft.problems.length} issue{draft.problems.length === 1 ? '' : 's'}
                      </span>
                    ) : draft.members.length ? (
                      <span class="good-text">Legal · {draft.members.length} Pokémon</span>
                    ) : (
                      'Not validated'
                    )}
                  </div>
                  <div class="draft-actions">
                    <button type="button" class="button" onClick={() => setExpanded(expanded === index ? null : index)}>
                      {expanded === index ? 'Close' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      class="button"
                      aria-label={`Remove team ${index + 1}`}
                      onClick={() => {
                        setDrafts((previous) => previous.filter((_, i) => i !== index));
                        setExpanded((current) => {
                          if (current === null) return null;
                          if (current === index) return drafts.length > 1 ? Math.min(index, drafts.length - 2) : null;
                          return current > index ? current - 1 : current;
                        });
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div class="draft-body">
                  <label class="field-label" for={`paste-${index}`}>
                    Showdown Import/Export text
                  </label>
                  <textarea
                    id={`paste-${index}`}
                    placeholder={'Incineroar @ Safety Goggles\nAbility: Intimidate\n…'}
                    value={draft.paste}
                    onInput={(event) =>
                      patchDraft(index, { paste: event.currentTarget.value, members: [], problems: [] })
                    }
                  />
                  <div class="paste-actions">
                    <button type="button" class="button" onClick={() => pasteClipboard(index)}>
                      Paste clipboard
                    </button>
                    <button type="button" class="button primary" onClick={() => validate(index)}>
                      Validate with Showdown
                    </button>
                    {draft.problems.length > 0 && <div class="message error">{draft.problems.join('\n')}</div>}
                  </div>
                  {draft.problems.length === 0 && draft.members.length > 0 && (
                    <>
                      <div class="team-sheet">
                        {draft.members.map((member, memberIndex) => (
                          <Member key={`${member.species}-${memberIndex}`} member={member} />
                        ))}
                      </div>
                      <div class="message success">Legal in {format} and ready for the pool.</div>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div class="builder-footer">
            <button
              type="button"
              class="button"
              onClick={() => {
                const key = nextDraftKey.current++;
                setDrafts((previous) => [...previous, newDraft(key)]);
                setExpanded(drafts.length);
              }}
            >
              Add team
            </button>
            <button type="button" class="button primary" disabled={creating} onClick={createPool}>
              Create pool
            </button>
            {message.text && (
              <div class={`message ${message.cls}`} role="status">
                {message.text}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
