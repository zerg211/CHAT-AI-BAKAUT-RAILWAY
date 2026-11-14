import { describe, expect, it } from 'vitest';
import { acceptanceDatabaseUrl, assertAcceptanceDatabaseEndpoint } from './fixtures/acceptanceDatabaseGuard.js';

describe('isolated acceptance database boundary', () => {
  const url = 'postgresql://test@127.0.0.1:55432/bakaut_acceptance_offline';
  it('accepts only an explicitly confirmed loopback database', () => {
    expect(acceptanceDatabaseUrl(undefined, undefined, undefined)).toBeNull();
    expect(acceptanceDatabaseUrl(url, url, 'bakaut_acceptance_offline')?.hostname).toBe('127.0.0.1');
    expect(() => assertAcceptanceDatabaseEndpoint({ db: 'bakaut_acceptance_offline', address: '127.0.0.1/32' }, 'bakaut_acceptance_offline')).not.toThrow();
  });
  it('rejects remote, ambiguous, mismatched, and unconfirmed targets before connecting', () => {
    for (const target of ['postgresql://test@example.com/bakaut_acceptance_offline',
      'postgresql://test@localhost/bakaut_acceptance_offline', 'postgresql://test@127.0.0.1/production',
      `${url}?host=example.com`, `${url}#fragment`, 'not-a-url']) {
      expect(() => acceptanceDatabaseUrl(target, target, 'bakaut_acceptance_offline')).toThrow();
    }
    expect(() => acceptanceDatabaseUrl(url, url, 'other')).toThrow();
    expect(() => acceptanceDatabaseUrl(url, 'postgresql://test@example.com/production', 'bakaut_acceptance_offline')).toThrow();
    expect(() => assertAcceptanceDatabaseEndpoint({ db: 'bakaut_acceptance_offline', address: '10.0.0.1' }, 'bakaut_acceptance_offline')).toThrow();
    expect(() => assertAcceptanceDatabaseEndpoint({ db: 'production', address: '127.0.0.1' }, 'bakaut_acceptance_offline')).toThrow();
  });
});
