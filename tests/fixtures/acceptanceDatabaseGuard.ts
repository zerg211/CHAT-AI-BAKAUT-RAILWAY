export function acceptanceDatabaseUrl(testUrl: string | undefined, databaseUrl: string | undefined, confirmed: string | undefined): URL | null {
  if (!testUrl) return null;
  let url: URL;
  try { url = new URL(testUrl); } catch { throw new Error('Invalid acceptance database URL'); }
  let database: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error('Invalid acceptance database name'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^bakaut_acceptance_[a-z0-9_]+$/.test(database) || confirmed !== database ||
      url.search || url.hash || databaseUrl !== testUrl) {
    throw new Error('Acceptance database must be explicitly confirmed and local');
  }
  return url;
}

export function assertAcceptanceDatabaseEndpoint(row: { db: unknown; address: unknown }, expected: string): void {
  if (row.db !== expected || !['127.0.0.1/32', '127.0.0.1', '::1/128', '::1'].includes(String(row.address))) {
    throw new Error('Acceptance database endpoint mismatch');
  }
}
