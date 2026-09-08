// Verified public token rates, distinct from preflight reservation ceilings.
// These are usage-derived estimates, not invoices or account-specific quotes.
export const lunaPricing = {
  version: '2026-09-08',
  verifiedAt: '2026-09-08T00:00:00Z',
  source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  model: 'gpt-5.6-luna',
  serviceTier: 'default',
  inputUsdPerMillion: 0.20,
  cachedInputUsdPerMillion: 0.02,
  outputUsdPerMillion: 1.20,
  longContextThreshold: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
  cacheWriteMultiplier: 1.25
} as const;

export function isPricingStale(verifiedAt: string, now = Date.now(), maxAgeDays = 30) {
  const verified = Date.parse(verifiedAt);
  return !Number.isFinite(verified) || verified > now ||
    now - verified > maxAgeDays * 86_400_000;
}

export function estimateLunaStandardTokenCost(input: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
}) {
  const writes = input.cacheWriteTokens ?? 0;
  const values = [input.inputTokens, input.cachedInputTokens, input.outputTokens, writes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      input.cachedInputTokens + writes > input.inputTokens) return null;
  const long = input.inputTokens > lunaPricing.longContextThreshold;
  const inputMultiplier = long ? lunaPricing.longContextInputMultiplier : 1;
  const outputMultiplier = long ? lunaPricing.longContextOutputMultiplier : 1;
  const uncached = input.inputTokens - input.cachedInputTokens - writes;
  return ((uncached + writes * lunaPricing.cacheWriteMultiplier) * lunaPricing.inputUsdPerMillion * inputMultiplier +
    input.cachedInputTokens * lunaPricing.cachedInputUsdPerMillion * inputMultiplier +
    input.outputTokens * lunaPricing.outputUsdPerMillion * outputMultiplier) / 1_000_000;
}
