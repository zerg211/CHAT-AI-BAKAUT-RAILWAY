/** Explicit structured decision: the catalog filters cover every required condition. */
export const ALL_CATALOG_MATCHES = '__ALL_CATALOG_MATCHES__';

export function selectsAllCatalogMatches(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    return Array.isArray(data.selected) && data.selected.length === 1 && data.selected[0] === ALL_CATALOG_MATCHES &&
      Array.isArray(data.rejected) && data.rejected.length === 0 && Array.isArray(data.uncertain) && data.uncertain.length === 0;
  } catch { return false; }
}
