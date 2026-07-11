import { describe, expect, it } from 'vitest';
import {
  ProviderBudgetEstimationError,
  estimateEmbeddingProviderCall,
  estimateResponsesProviderCall
} from '../src/ai/openaiRequestBudget.js';

function serializedUtf8Bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('OpenAI request budget estimation', () => {
  it('uses a conservative UTF-8 input estimate for ASCII and Cyrillic requests', () => {
    const asciiRequest = {
      model: 'gpt-5.4',
      max_output_tokens: 120,
      input: [{ role: 'user', content: 'Select a generator' }]
    };
    const cyrillicRequest = {
      model: 'gpt-5.4',
      max_output_tokens: 120,
      input: [{ role: 'user', content: 'Подбери генератор' }]
    };

    const asciiEstimate = estimateResponsesProviderCall(asciiRequest);
    const cyrillicEstimate = estimateResponsesProviderCall(cyrillicRequest);

    expect(asciiEstimate.estimatedInputTokens)
      .toBe(serializedUtf8Bytes(asciiRequest) + 512);
    expect(cyrillicEstimate.estimatedInputTokens)
      .toBe(serializedUtf8Bytes(cyrillicRequest) + 512);
    expect(cyrillicEstimate.estimatedInputTokens)
      .toBeGreaterThan(serializedUtf8Bytes(cyrillicRequest));
  });

  it('prices GPT-5.4 with the configured ceiling for input and reserved output', () => {
    const request = {
      model: 'gpt-5.4',
      max_output_tokens: 2_000,
      input: 'Budget this request'
    };

    const estimate = estimateResponsesProviderCall(request);
    const expectedCost = (estimate.estimatedInputTokens * 5.5 / 1_000_000) +
      (2_000 * 33 / 1_000_000);

    expect(estimate.reservedOutputTokens).toBe(2_000);
    expect(estimate.estimatedTotalTokens)
      .toBe(estimate.estimatedInputTokens + estimate.reservedOutputTokens);
    expect(estimate.hostedToolCostUsd).toBe(0);
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 12);
  });

  it('reserves external input tokens and tool cost for web_search_preview', () => {
    const request = {
      model: 'gpt-5.4',
      max_output_tokens: 600,
      input: 'Verify the current product fact',
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }]
    };

    const estimate = estimateResponsesProviderCall(request);
    const expectedInputTokens = serializedUtf8Bytes(request) + 512 + 16_000;
    const expectedCost = (expectedInputTokens * 5.5 / 1_000_000) +
      (600 * 33 / 1_000_000) +
      0.01;

    expect(estimate.estimatedInputTokens).toBe(expectedInputTokens);
    expect(estimate.hostedToolCostUsd).toBe(0.01);
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 12);
  });

  it('assigns non-zero input tokens and cost to embedding calls', () => {
    const values = ['бензиновый генератор', 'single phase'];

    const estimate = estimateEmbeddingProviderCall({
      model: 'text-embedding-3-small',
      values
    });
    const expectedInputTokens = serializedUtf8Bytes(values) + 128;

    expect(estimate.kind).toBe('embedding');
    expect(estimate.estimatedInputTokens).toBe(expectedInputTokens);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.reservedOutputTokens).toBe(0);
    expect(estimate.estimatedTotalTokens).toBe(expectedInputTokens);
    expect(estimate.estimatedCostUsd)
      .toBeCloseTo(expectedInputTokens * 0.022 / 1_000_000, 12);
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('fails closed when the model has no pricing ceiling', () => {
    expect(() => estimateResponsesProviderCall({
      model: 'unpriced-future-model',
      max_output_tokens: 100,
      input: 'hello'
    })).toThrowError(new ProviderBudgetEstimationError('provider_pricing_unknown'));

    expect(() => estimateEmbeddingProviderCall({
      model: 'unpriced-embedding-model',
      values: ['hello']
    })).toThrowError(new ProviderBudgetEstimationError('provider_pricing_unknown'));
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('fails closed for a %s max_output_tokens value', (_label, maxOutputTokens) => {
    const request: Record<string, unknown> = {
      model: 'gpt-5.4',
      input: 'hello'
    };
    if (maxOutputTokens !== undefined) request.max_output_tokens = maxOutputTokens;

    expect(() => estimateResponsesProviderCall(request))
      .toThrowError(new ProviderBudgetEstimationError('provider_output_limit_missing'));
  });
});
