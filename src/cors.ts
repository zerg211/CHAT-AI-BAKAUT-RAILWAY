import { config } from './config.js';

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * Mirrors the @fastify/cors allowlist from app.ts for responses that bypass
 * Fastify hooks (raw SSE streams via reply.raw.writeHead).
 * Returns the origin to echo in Access-Control-Allow-Origin, or null.
 */
export function resolveAllowedCorsOrigin(requestOrigin: unknown): string | null {
  if (typeof requestOrigin !== 'string') return null;
  const origin = normalizeOrigin(requestOrigin);
  if (!origin) return null;
  if (config.CORS_ORIGINS) {
    const allowed = config.CORS_ORIGINS.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return allowed.includes(origin) ? origin : null;
  }
  if (config.NODE_ENV !== 'production') return origin;
  const defaults = [normalizeOrigin(config.PUBLIC_BASE_URL), normalizeOrigin(config.CATALOG_BASE_URL)]
    .filter((entry): entry is string => entry !== null);
  return defaults.includes(origin) ? origin : null;
}

export function sseCorsHeaders(requestOrigin: unknown): Record<string, string> {
  const allowed = resolveAllowedCorsOrigin(requestOrigin);
  if (!allowed) return {};
  return { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' };
}
