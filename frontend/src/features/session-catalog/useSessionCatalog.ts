import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, onSocketEvent } from '../../shared/api';
import { sessionCacheKey, openSessionKey, type Kind, type OpenSession } from '../../shared/model';
import { catalogAreas, emptyCatalogSlice, mergeCatalog, updateCatalogStatus, type Catalog, type CatalogArea } from './catalog-state';

export function useSessionCatalog(user: string | null, enabled: Partial<Record<Kind, boolean>>) {
  const [areas, setAreas] = useState<Catalog>({});
  const state = useRef<Catalog>({}), owner = useRef(user), epoch = useRef(0);
  const pending = useRef(new Map<CatalogArea, Promise<void>>());
  const scans = useRef(new Map<CatalogArea, Promise<void>>());
  const wanted = useRef(new Map<CatalogArea, number>());
  const mutations = useRef(new Map<CatalogArea, number>());
  const timer = useRef(0), dirty = useRef(new Set<CatalogArea>());
  owner.current = user;
  const publish = (next: Catalog) => { state.current = next; setAreas(next); };
  const targets = () => catalogAreas.filter(area => area === 'local' || enabled[area] !== false);
  const write = (next: Catalog) => {
    const previous = state.current;
    publish(next);
    if (!owner.current) return;
    for (const area of catalogAreas) if (next[area] && next[area]!.rows !== previous[area]?.rows) {
      try { localStorage.setItem(sessionCacheKey(owner.current, area as Kind), JSON.stringify(next[area]!.rows)); } catch {}
    }
  };
  const sync = async (requested: CatalogArea[] = targets()) => {
    if (!user || navigator.onLine === false) return;
    const generation = epoch.current, account = user;
    const alive = () => generation === epoch.current && account === owner.current;
    const fresh = requested.filter(area => !pending.current.has(area));
    const waits = requested.map(area => pending.current.get(area)).filter(Boolean);
    if (fresh.length) {
      const versions = new Map(fresh.map(area => [area, mutations.current.get(area) || 0]));
      publish(Object.fromEntries(Object.entries(state.current).map(([area, slice]) => [area, fresh.includes(area as CatalogArea) ? { ...slice, refreshing: true } : slice])));
      const work = (async () => {
        let succeeded = false;
        try {
          const result = await api<{ areas: Catalog }>('/sessions/catalog?areas=' + fresh.join(','));
          if (!alive()) return;
          const valid = Object.fromEntries(Object.entries(result.areas).filter(([area]) => versions.get(area as CatalogArea) === (mutations.current.get(area as CatalogArea) || 0))) as Catalog;
          write(mergeCatalog(state.current, valid));
          for (const area of fresh) if (versions.get(area) !== (mutations.current.get(area) || 0)) dirty.current.add(area);
          succeeded = true;
        } catch (error) {
          if (alive()) publish({ ...state.current, ...Object.fromEntries(fresh.map(area => [area, { ...(state.current[area] || emptyCatalogSlice()), refreshing: false, error: errorMessage(error) }])) });
        } finally {
          if (alive()) {
            for (const area of fresh) { pending.current.delete(area); if (succeeded && (wanted.current.get(area) ?? -1) > (state.current[area]?.revision ?? -1)) dirty.current.add(area); }
            if (dirty.current.size && navigator.onLine !== false && !document.hidden) schedule();
          }
        }
      })();
      for (const area of fresh) pending.current.set(area, work);
      waits.push(work);
    }
    await Promise.all(waits);
  };
  const schedule = () => {
    if (timer.current || document.hidden || navigator.onLine === false) return;
    timer.current = window.setTimeout(() => { timer.current = 0; const list = [...dirty.current]; dirty.current.clear(); void sync(list); }, 150);
  };
  const refresh = (area: CatalogArea) => {
    const existing = scans.current.get(area);
    if (existing) return existing;
    const generation = epoch.current, account = user;
    const work = (async () => {
      if (!account) return;
      if (navigator.onLine === false) { publish({ ...state.current, [area]: { ...(state.current[area] || emptyCatalogSlice()), error: '已离线，联网后可刷新', refreshing: false } }); return; }
      publish({ ...state.current, [area]: { ...(state.current[area] || emptyCatalogSlice()), refreshing: true, error: null } });
      try {
        if (area !== 'local') await api(`/agents/${area}/sessions/refresh`, { method: 'POST' });
        if (generation !== epoch.current || account !== owner.current) return;
        await pending.current.get(area);
        await sync([area]);
      } catch (error) {
        if (generation === epoch.current && account === owner.current) publish({ ...state.current, [area]: { ...(state.current[area] || emptyCatalogSlice()), refreshing: false, error: errorMessage(error) } });
      } finally { if (generation === epoch.current) scans.current.delete(area); }
    })();
    scans.current.set(area, work);
    return work;
  };
  const clear = () => { epoch.current++; window.clearTimeout(timer.current); timer.current = 0; pending.current.clear(); scans.current.clear(); wanted.current.clear(); dirty.current.clear(); publish({}); };
  const upsert = (row: OpenSession) => {
    mutations.current.set(row.kind, (mutations.current.get(row.kind) || 0) + 1);
    const slice = state.current[row.kind] || emptyCatalogSlice();
    write({ ...state.current, [row.kind]: { ...slice, rows: [row, ...slice.rows.filter(value => openSessionKey(value) !== openSessionKey(row))] } });
  };
  const updateStatus = (row: OpenSession, status: 'running' | 'ended') => {
    const next = updateCatalogStatus(state.current, row, status);
    if (next === state.current) return;
    mutations.current.set(row.kind, (mutations.current.get(row.kind) || 0) + 1);
    write(next);
  };
  const remove = (row: OpenSession) => {
    mutations.current.set(row.kind, (mutations.current.get(row.kind) || 0) + 1);
    const slice = state.current[row.kind];
    if (slice) write({ ...state.current, [row.kind]: { ...slice, rows: slice.rows.filter(value => openSessionKey(value) !== openSessionKey(row)) } });
  };
  const latest = useRef({ sync, targets, schedule }); latest.current = { sync, targets, schedule };
  useEffect(() => {
    clear();
    if (!user) return;
    const cached: Catalog = {};
    for (const area of catalogAreas) {
      try { const rows = JSON.parse(localStorage.getItem(sessionCacheKey(user, area as Kind)) || '[]'); if (Array.isArray(rows)) cached[area] = { ...emptyCatalogSlice(), rows }; } catch {}
    }
    publish(cached);
    void latest.current.sync();
    const changed = onSocketEvent('sessions.catalog.changed', event => {
      const area = event.area as CatalogArea;
      if (!catalogAreas.includes(area) || !latest.current.targets().includes(area) || typeof event.revision !== 'number') return;
      wanted.current.set(area, Math.max(wanted.current.get(area) ?? -1, event.revision));
      if (event.revision > (state.current[area]?.revision ?? -1)) { dirty.current.add(area); latest.current.schedule(); }
    });
    const resume = () => { if (!document.hidden && navigator.onLine !== false) void latest.current.sync(); };
    const reconnect = () => {
      epoch.current++; pending.current.clear(); scans.current.clear(); wanted.current.clear(); dirty.current.clear();
      publish(Object.fromEntries(Object.entries(state.current).map(([area, slice]) => [area, { ...slice, revision: -1, refreshing: false }])));
      resume();
    };
    const resync = onSocketEvent('sessions.catalog.resync', resume), connected = onSocketEvent('api.connected', reconnect);
    window.addEventListener('online', resume); window.addEventListener('pageshow', resume); document.addEventListener('visibilitychange', resume);
    return () => { epoch.current++; window.clearTimeout(timer.current); timer.current = 0; pending.current.clear(); scans.current.clear(); wanted.current.clear(); dirty.current.clear(); changed(); resync(); connected(); window.removeEventListener('online', resume); window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', resume); };
  }, [user]);
  useEffect(() => { if (user) void latest.current.sync(); }, [enabled.codex, enabled.hermes, enabled.pi]);
  const read = async (area: CatalogArea, native = false) => { if (native) await refresh(area); else await sync([area]); return state.current[area] || emptyCatalogSlice(); };
  return { areas, sync, refresh, read, clear, upsert, remove, updateStatus };
}
