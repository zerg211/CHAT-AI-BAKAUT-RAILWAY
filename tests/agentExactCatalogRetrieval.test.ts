import { describe, expect, it, vi } from 'vitest';
import { AgentManagerOrchestrator } from '../src/ai/agentManagerOrchestrator.js';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import type { Product } from '../src/shared/types.js';

const exact: Product = { id: 'exact', name: 'Generator ACME GX5000', brand: 'ACME', category: 'Generators',
  price: 50000, currency: 'RUB', sourceUrl: 'https://example.test/gx5000', specs: {} };
const other: Product = { ...exact, id: 'other', name: 'Generator ACME GX6000', sourceUrl: 'https://example.test/gx6000' };

function intentFor(names = ['ACME GX5000']): AgentIntentContract {
  return { userMessageSummary: 'Consult named models', dialogueUnderstanding: 'Exact model consultation',
    nextStepRationale: 'Identify catalog models', requiresTools: true, toolRequests: [], policyRuleIds: [],
    mustNotAskQuestionIds: [], riskFlags: [],
    productMentions: names.map(name => ({ name, role: 'target_product', productClass: 'generator', evidence: name })),
    selectionPolicy: { targetProductClass: 'generator', canonicalProductClass: 'generator',
      needAction: 'none', alternativePolicy: 'exact_only', reusePreviousCards: false,
      maxCards: null, powerSource: 'any', phase: 'any', requirements: [], rationale: 'Exact model consultation' } };
}

function setup(lookup: Product[], text: Product[] = [exact, other]) {
  const repository = { searchProductsByModelTokens: vi.fn(async () => lookup),
    searchProducts: vi.fn(async () => text), vectorSearch: vi.fn(async () => []),
    getEmbeddingCoverage: vi.fn(async () => ({ target: 'products', total: 1, embedded: 1, usable: 1, coverage: 1 })) };
  const orchestrator = new AgentManagerOrchestrator({} as never, repository as never, {} as never, {} as never,
    async () => [0.1, 0.2]);
  const search = (intent: AgentIntentContract, budgetMax?: number) => (orchestrator as unknown as {
    searchCatalogProducts(input: { query: string; limit: number; productIntent: 'generator';
      intent: AgentIntentContract; budgetMax?: number }): Promise<{ products: Product[]; primaryExpansion?: unknown }>;
  }).searchCatalogProducts({ query: 'ACME GX5000', limit: 4, productIntent: 'generator', intent, budgetMax });
  return { repository, search };
}

describe('exact catalog retrieval scope', () => {
  it('uses exact identity lookup without unrelated text, embedding or category expansion', async () => {
    const { repository, search } = setup([exact, other]);
    const result = await search(intentFor());
    expect(result.products.map(product => product.id)).toEqual(['exact']);
    expect(repository.searchProductsByModelTokens).toHaveBeenCalledWith(['gx5000'], 20, expect.any(Object));
    expect(repository.searchProducts).not.toHaveBeenCalled();
    expect(repository.getEmbeddingCoverage).not.toHaveBeenCalled();
    expect(result.primaryExpansion).toBeUndefined();
  });

  it('stops expansion after text fallback identifies every exact target', async () => {
    const { repository, search } = setup([]);
    const result = await search(intentFor());
    expect(result.products.map(product => product.id)).toEqual(['exact']);
    expect(repository.searchProducts).toHaveBeenCalledTimes(1);
    expect(repository.getEmbeddingCoverage).not.toHaveBeenCalled();
    expect(result.primaryExpansion).toBeUndefined();
  });

  it('continues discovery if another requested model is missing or lookup returns a suffix variant', async () => {
    const variant = { ...exact, id: 'variant', name: 'Generator ACME GX5000E', sourceUrl: 'https://example.test/gx5000e' };
    const { repository, search } = setup([variant], [other]);
    const result = await search(intentFor(['ACME GX5000', 'ACME GX6000']));
    expect(result.products.map(product => product.id)).toEqual(['other']);
    expect(repository.searchProducts).toHaveBeenCalledWith(expect.any(String), 1000, expect.any(Object));
    expect(result.primaryExpansion).toBeDefined();
  });

  it('does not treat multiple catalog identities for a model name as an unambiguous resolution', async () => {
    const ambiguous = { ...exact, id: 'another-brand', brand: 'OTHER', name: 'Generator OTHER GX5000' };
    const { repository, search } = setup([exact, ambiguous], [exact, ambiguous]);
    const result = await search(intentFor(['GX5000']));
    expect(repository.searchProducts).toHaveBeenCalledWith(expect.any(String), 1000, expect.any(Object));
    expect(result.products).toHaveLength(2);
    expect(result.primaryExpansion).toBeDefined();
  });

  it('falls back when the token lookup has the model code under a different brand', async () => {
    const wrong = { ...exact, id: 'wrong-brand', brand: 'OTHER', name: 'Generator OTHER GX5000',
      sourceUrl: 'https://example.test/other-gx5000' };
    const { repository, search } = setup([wrong], [exact]);
    const result = await search(intentFor());
    expect(repository.searchProducts).toHaveBeenCalled();
    expect(result.products.map(product => product.id)).toEqual(['exact']);
  });

  it('does not certify uniqueness from a saturated token lookup before filtering variants', async () => {
    const variants = Array.from({ length: 19 }, (_, index) => ({ ...exact, id: `variant-${index}`,
      name: `Generator ACME GX5000E${index}`, sourceUrl: `https://example.test/gx5000e${index}` }));
    const { repository, search } = setup([exact, ...variants], [exact]);
    const result = await search(intentFor());
    expect(repository.searchProducts).toHaveBeenCalledWith(expect.any(String), 1000, expect.any(Object));
    expect(result.primaryExpansion).toBeDefined();
  });

  it.each(['generic', 'alternatives'] as const)('retains broad discovery for %s requests', async mode => {
    const intent = intentFor(mode === 'generic' ? ['generator'] : undefined);
    if (mode === 'alternatives') intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    const { repository, search } = setup([exact]);
    const result = await search(intent);
    expect(repository.searchProductsByModelTokens).not.toHaveBeenCalled();
    expect(repository.searchProducts).toHaveBeenCalledWith(expect.any(String), 1000, expect.any(Object));
    expect(result.primaryExpansion).toBeDefined();
  });

  it('keeps proven hard constraints after exact identification without searching disallowed alternatives', async () => {
    const intent = intentFor();
    intent.selectionPolicy!.requirements = [{ id: 'budget', kind: 'budget_max_rub', value: 10000, unit: 'RUB',
      relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'Under 10000',
      verification: { mode: 'product_attribute' } }];
    const { repository, search } = setup([exact]);
    const result = await search(intent, 10000);
    expect(result.products).toEqual([]);
    expect(repository.searchProducts).not.toHaveBeenCalled();
    expect(result.primaryExpansion).toBeUndefined();
  });
});
