import type { OpenSession, Kind } from '../../shared/model';

export type CatalogArea = Kind | 'local';
export type CatalogSlice = { rows: OpenSession[]; revision: number; last_success_at: string | null; refreshing: boolean; error: string | null };
export type Catalog = Partial<Record<CatalogArea, CatalogSlice>>;
export const catalogAreas: CatalogArea[] = ['local', 'codex', 'hermes', 'pi'];
export const emptyCatalogSlice = (): CatalogSlice => ({ rows: [], revision: -1, last_success_at: null, refreshing: false, error: null });

export function mergeCatalog(current: Catalog, incoming: Catalog): Catalog {
  const next = { ...current };
  for (const area of catalogAreas) {
    const value = incoming[area];
    if (value && value.revision >= (current[area]?.revision ?? -1)) {
      next[area] = value.error && !value.last_success_at && !value.rows.length && current[area]?.rows.length
        ? { ...value, rows: current[area]!.rows, last_success_at: current[area]!.last_success_at }
        : value;
    }
  }
  return next;
}

export const catalogFeedback = (slice?: CatalogSlice) => slice?.refreshing ? '更新中…' : slice?.error ? '更新失败，保留上次列表' : slice?.last_success_at ? `最近同步 ${new Date(slice.last_success_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待同步';
