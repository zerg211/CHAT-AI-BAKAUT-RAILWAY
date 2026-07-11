export type ProviderBudgetEstimationStopReason =
  | 'provider_pricing_unknown'
  | 'provider_input_estimation_failed'
  | 'provider_output_limit_missing';

export class ProviderBudgetEstimationError extends Error {
  constructor(readonly stopReason: ProviderBudgetEstimationStopReason) {
    super(stopReason);
    this.name = 'ProviderBudgetEstimationError';
  }
}

export interface ProviderCallEstimate {
  kind: 'responses' | 'embedding';
  model: string;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  hostedToolCostUsd: number;
}

interface PricingCeiling {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

// Versioned ceiling from the official OpenAI API pricing table checked on 2026-07-11.
// It uses Priority rates plus the documented 10% regional-processing uplift and
// deliberately ignores cached-input discounts.
const pricingCeilings: Array<[prefix: string, pricing: PricingCeiling]> = [
  ['gpt-5.6-sol', { inputUsdPerMillion: 11, outputUsdPerMillion: 66 }],
  ['gpt-5.6-terra', { inputUsdPerMillion: 5.5, outputUsdPerMillion: 33 }],
  ['gpt-5.6-luna', { inputUsdPerMillion: 2.2, outputUsdPerMillion: 13.2 }],
  ['gpt-5.5-pro', { inputUsdPerMillion: 33, outputUsdPerMillion: 198 }],
  ['gpt-5.5', { inputUsdPerMillion: 13.75, outputUsdPerMillion: 82.5 }],
  ['gpt-5.4-mini', { inputUsdPerMillion: 1.65, outputUsdPerMillion: 9.9 }],
  ['gpt-5.4-nano', { inputUsdPerMillion: 0.22, outputUsdPerMillion: 1.375 }],
  ['gpt-5.4-pro', { inputUsdPerMillion: 33, outputUsdPerMillion: 198 }],
  ['gpt-5.4', { inputUsdPerMillion: 5.5, outputUsdPerMillion: 33 }],
  ['text-embedding-3-small', { inputUsdPerMillion: 0.022, outputUsdPerMillion: 0 }],
  ['text-embedding-3-large', { inputUsdPerMillion: 0.143, outputUsdPerMillion: 0 }]
];

function pricingForModel(model: string) {
  return pricingCeilings.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))?.[1];
}

function serializedUtf8ByteUpperBound(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new ProviderBudgetEstimationError('provider_input_estimation_failed');
  }
}

function responseHostedToolCount(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.filter((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const type = (tool as { type?: unknown }).type;
    return type === 'web_search' || type === 'web_search_preview';
  }).length;
}

function priceEstimate(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  hostedToolCostUsd: number;
}) {
  const pricing = pricingForModel(input.model);
  if (!pricing) throw new ProviderBudgetEstimationError('provider_pricing_unknown');
  return (input.inputTokens * pricing.inputUsdPerMillion / 1_000_000) +
    (input.outputTokens * pricing.outputUsdPerMillion / 1_000_000) +
    input.hostedToolCostUsd;
}

export function estimateResponsesProviderCall(body: Record<string, unknown>): ProviderCallEstimate {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || !pricingForModel(model)) {
    throw new ProviderBudgetEstimationError('provider_pricing_unknown');
  }
  const reservedOutputTokens = Number(body.max_output_tokens);
  if (!Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens <= 0) {
    throw new ProviderBudgetEstimationError('provider_output_limit_missing');
  }
  const hostedToolCount = responseHostedToolCount(body);
  const externalContextReserve = body.previous_response_id || body.conversation ? 64_000 : 0;
  const estimatedInputTokens = serializedUtf8ByteUpperBound(body) +
    512 +
    externalContextReserve +
    hostedToolCount * 16_000;
  const hostedToolCostUsd = hostedToolCount * 0.01;
  const estimatedCostUsd = priceEstimate({
    model,
    inputTokens: estimatedInputTokens,
    outputTokens: reservedOutputTokens,
    hostedToolCostUsd
  });
  return {
    kind: 'responses',
    model,
    estimatedInputTokens,
    reservedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + reservedOutputTokens,
    estimatedCostUsd,
    hostedToolCostUsd
  };
}

export function estimateEmbeddingProviderCall(input: {
  model: string;
  values: string[];
}): ProviderCallEstimate {
  const model = input.model.trim();
  if (!model || !pricingForModel(model)) {
    throw new ProviderBudgetEstimationError('provider_pricing_unknown');
  }
  const estimatedInputTokens = serializedUtf8ByteUpperBound(input.values) + 128;
  const estimatedCostUsd = priceEstimate({
    model,
    inputTokens: estimatedInputTokens,
    outputTokens: 0,
    hostedToolCostUsd: 0
  });
  return {
    kind: 'embedding',
    model,
    estimatedInputTokens,
    reservedOutputTokens: 0,
    estimatedTotalTokens: estimatedInputTokens,
    estimatedCostUsd,
    hostedToolCostUsd: 0
  };
}
