import { useEffect, useState } from 'preact/hooks';

import type { PokepasteResponse, PoolInfo, PoolTeamsResponse, ValidateResponse } from '../../api';
import { Dropdown } from '../components/dropdown';
import { api } from '../http';

export interface TeamAssignment {
  paste: string;
  label: string;
}

export function TeamEditor({
  slot,
  spec,
  team,
  pools,
  poolTeams,
  onLoadPool,
  onAssign,
  formatLabel,
  format,
  onDone,
}: {
  slot: number;
  spec: string;
  team: TeamAssignment | null;
  pools: PoolInfo[];
  poolTeams: Record<string, PoolTeamsResponse | 'loading' | { error: string } | undefined>;
  onLoadPool: (name: string, force?: boolean) => void;
  onAssign: (team: TeamAssignment | null, format?: string) => void;
  formatLabel: string;
  format: string;
  onDone: () => void;
}) {
  const [selPool, setSelPool] = useState(
    () => pools.find((info) => info.name !== 'test')?.name ?? pools[0]?.name ?? '',
  );
  const [selTeam, setSelTeam] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [pasteLink, setPasteLink] = useState('');
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (selPool) onLoadPool(selPool);
  }, [selPool]);
  const loaded = poolTeams[selPool];
  const teams = loaded && typeof loaded === 'object' && 'teams' in loaded ? loaded : null;
  const teamOptions = teams ? teams.teams.map((entry) => ({ value: entry.name, label: entry.name })) : [];
  const insert = () => {
    if (!teams) return;
    const found = teams.teams.find((entry) => entry.name === selTeam);
    if (!found) return;
    onAssign({ paste: found.paste, label: `${selPool} · ${found.name}` }, teams.format);
    onDone();
  };
  const validatePaste = (paste: string) => {
    if (!paste.trim()) return;
    setChecking(true);
    setProblems([]);
    api<ValidateResponse>('/api/team/validate', { paste, format })
      .then((data) => {
        if (data.problems.length) {
          setProblems(data.problems);
          return;
        }
        onAssign({ paste, label: `Pasted team ✓ (${data.species.length})` });
        onDone();
      })
      .catch((error: Error) => setProblems([error.message]))
      .finally(() => setChecking(false));
  };
  const importPokepaste = () => {
    if (!pasteLink.trim() || importing) return;
    setImporting(true);
    setProblems([]);
    api<PokepasteResponse>('/api/team/pokepaste', { url: pasteLink.trim() })
      .then((data) => {
        onAssign({ paste: data.paste, label: 'Poképaste import' });
        setPasteLink('');
        validatePaste(data.paste);
      })
      .catch((error: Error) => setProblems([error.message]))
      .finally(() => setImporting(false));
  };
  const clearTeam = () => {
    setProblems([]);
    setPasteLink('');
    onAssign(null);
  };
  return (
    <div class="team-editor">
      <div class="team-editor-head">
        <b>
          Team {String.fromCharCode(65 + slot)} · {spec}
        </b>
        <span>{formatLabel} · Poképaste export</span>
      </div>
      {pools.length > 0 && (
        <div class="team-editor-pool">
          <Dropdown
            id={`teamPool${slot}`}
            label="From pool"
            options={pools.map((info) => ({
              value: info.name,
              label: info.name,
              description: `${info.teamCount} teams`,
            }))}
            value={selPool}
            onChange={(name) => {
              setSelPool(name);
              setSelTeam('');
            }}
          />
          <Dropdown
            id={`teamPick${slot}`}
            label="Pool team"
            options={teamOptions}
            value={selTeam}
            onChange={setSelTeam}
            placeholder={
              loaded === 'loading'
                ? 'Loading teams…'
                : loaded && typeof loaded === 'object' && 'error' in loaded
                  ? 'Pool teams unavailable'
                  : 'Pick a team'
            }
            disabled={loaded === 'loading' || (loaded !== undefined && typeof loaded === 'object' && 'error' in loaded)}
          />
          <button type="button" class="button" disabled={!selTeam || !teams} onClick={insert}>
            Use this team
          </button>
        </div>
      )}
      {loaded && typeof loaded === 'object' && 'error' in loaded && (
        <div class="message error" role="alert">
          {loaded.error}{' '}
          <button type="button" class="button" onClick={() => onLoadPool(selPool, true)}>
            Retry
          </button>
        </div>
      )}
      <div class="field">
        <label class="field-label" for={`teamLink${slot}`}>
          Import from a Poképaste link
        </label>
        <div class="paste-import">
          <input
            id={`teamLink${slot}`}
            autocomplete="off"
            spellcheck={false}
            placeholder="https://pokepast.es/0123456789abcdef"
            value={pasteLink}
            onInput={(event) => setPasteLink(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') importPokepaste();
            }}
          />
          <button type="button" class="button" disabled={importing || !pasteLink.trim()} onClick={importPokepaste}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for={`teamPaste${slot}`}>
          Or paste a team
        </label>
        <textarea
          id={`teamPaste${slot}`}
          rows={8}
          spellcheck={false}
          value={team?.paste ?? ''}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setProblems([]);
            onAssign(value.trim() ? { paste: value, label: 'Pasted team' } : null);
          }}
        />
        <div class="paste-actions">
          <button
            type="button"
            class="button"
            disabled={checking || !team?.paste.trim()}
            onClick={() => validatePaste(team?.paste ?? '')}
          >
            {checking ? 'Validating…' : 'Validate team'}
          </button>
          <button type="button" class="button" disabled={checking || !team} onClick={clearTeam}>
            Clear team
          </button>
        </div>
        {problems.length > 0 && (
          <div class="message error" role="alert">
            {problems.join('\n')}
          </div>
        )}
      </div>
    </div>
  );
}
