import { afterEach, describe, expect, it, vi } from 'vitest';

const CLONE_ORIGIN = 'https://bakautprofclient.canapetest.ru';
const SHOP_ORIGIN = 'https://bakautprof.ru';

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadCors() {
  vi.resetModules();
  return import('../src/cors.js');
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('resolveAllowedCorsOrigin', () => {
  it('echoes a configured clone origin for raw SSE responses', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGINS', `${SHOP_ORIGIN},${CLONE_ORIGIN}`);
    const { resolveAllowedCorsOrigin, sseCorsHeaders } = await loadCors();
    expect(resolveAllowedCorsOrigin(CLONE_ORIGIN)).toBe(CLONE_ORIGIN);
    expect(sseCorsHeaders(CLONE_ORIGIN)).toEqual({
      'Access-Control-Allow-Origin': CLONE_ORIGIN,
      Vary: 'Origin'
    });
  });

  it('denies origins outside the configured allowlist', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGINS', SHOP_ORIGIN);
    const { resolveAllowedCorsOrigin, sseCorsHeaders } = await loadCors();
    expect(resolveAllowedCorsOrigin('https://evil.example')).toBeNull();
    expect(sseCorsHeaders('https://evil.example')).toEqual({});
  });

  it('rejects malformed and non-string origins', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGINS', `${SHOP_ORIGIN},${CLONE_ORIGIN}`);
    const { resolveAllowedCorsOrigin } = await loadCors();
    expect(resolveAllowedCorsOrigin('not-a-url')).toBeNull();
    expect(resolveAllowedCorsOrigin('')).toBeNull();
    expect(resolveAllowedCorsOrigin(undefined)).toBeNull();
  });

  it('falls back to public and catalog origins in production without CORS_ORIGINS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGINS', '');
    setEnv({ PUBLIC_BASE_URL: 'https://chat.example.test', CATALOG_BASE_URL: SHOP_ORIGIN });
    const { resolveAllowedCorsOrigin } = await loadCors();
    expect(resolveAllowedCorsOrigin(SHOP_ORIGIN)).toBe(SHOP_ORIGIN);
    expect(resolveAllowedCorsOrigin(CLONE_ORIGIN)).toBeNull();
  });
});
