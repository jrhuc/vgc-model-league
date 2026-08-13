import { useEffect, useState } from 'preact/hooks';

import type { LeagueResponse, LeaguesResponse } from '../../api';
import { api, apiFresh } from '../http';

interface ArchiveResource<T> {
  key: string;
  value: T | null;
  error: string;
}

const EMPTY_ARCHIVE_RESOURCE = { key: '', value: null, error: '' } as const;

export function useLeagueList(active: boolean, epoch: number): ArchiveResource<LeaguesResponse> {
  const key = active ? String(epoch) : '';
  const [resource, setResource] = useState<ArchiveResource<LeaguesResponse>>(EMPTY_ARCHIVE_RESOURCE);

  useEffect(() => {
    if (!active) {
      setResource(EMPTY_ARCHIVE_RESOURCE);
      return;
    }
    let current = true;
    setResource({ key, value: null, error: '' });
    api<LeaguesResponse>('/api/leagues')
      .then((value) => {
        if (current) setResource({ key, value, error: '' });
      })
      .catch((failure: Error) => {
        if (current) setResource({ key, value: null, error: failure.message });
      });
    return () => {
      current = false;
    };
  }, [active, key]);

  const value = resource.key === key ? resource.value : null;
  const live = value?.leagues.some((card) => card.lifecycle === 'live') === true;
  useEffect(() => {
    if (!active || !live) return;
    let current = true;
    const timer = setInterval(() => {
      apiFresh<LeaguesResponse>('/api/leagues')
        .then((next) => {
          if (current) setResource({ key, value: next, error: '' });
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [active, key, live]);

  return resource.key === key ? resource : { key, value: null, error: '' };
}

export function useLeague(runId: string | undefined, epoch: number): ArchiveResource<LeagueResponse> {
  const key = runId ? `${runId}:${epoch}` : '';
  const [resource, setResource] = useState<ArchiveResource<LeagueResponse>>(EMPTY_ARCHIVE_RESOURCE);
  const path = runId ? `/api/league?run=${encodeURIComponent(runId)}` : '';

  useEffect(() => {
    if (!runId) {
      setResource(EMPTY_ARCHIVE_RESOURCE);
      return;
    }
    let current = true;
    setResource({ key, value: null, error: '' });
    api<LeagueResponse>(path)
      .then((value) => {
        if (current) setResource({ key, value, error: '' });
      })
      .catch((failure: Error) => {
        if (current) setResource({ key, value: null, error: failure.message });
      });
    return () => {
      current = false;
    };
  }, [key, path, runId]);

  const value = resource.key === key ? resource.value : null;
  const live = value?.lifecycle === 'live';
  useEffect(() => {
    if (!runId || !live) return;
    let current = true;
    const timer = setInterval(() => {
      apiFresh<LeagueResponse>(path)
        .then((next) => {
          if (current) setResource({ key, value: next, error: '' });
        })
        .catch(() => {});
    }, 20_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [key, live, path, runId]);

  return resource.key === key ? resource : { key, value: null, error: '' };
}
