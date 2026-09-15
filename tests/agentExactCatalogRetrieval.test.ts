import { describe, expect, it, vi } from 'vitest';
import { AgentManagerOrchestrator } from '../src/ai/agentManagerOrchestrator.js';
import { AgentManagerToolExecutor } from '../src/ai/agentManagerToolExecutor.js';
import { AgentManagerTurnBudget } from '../src/ai/agentManagerTurnBudget.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentIntentContract, ToolResult } from '../src/ai/agentManagerContracts.js';
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
  const search = (intent: AgentIntentContract, budgetMax?: number, toolResults: ToolResult[] = []) => (orchestrator as unknown as {
    searchCatalogProducts(input: { query: string; limit: number; productIntent: 'generator';
      intent: AgentIntentContract; budgetMax?: number; toolResults?: ToolResult[] }): Promise<{ products: Product[]; primaryExpansion?: unknown }>;
  }).searchCatalogProducts({ query: 'ACME GX5000', limit: 4, productIntent: 'generator', intent, budgetMax, toolResults });
  return { repository, search };
}

describe('exact catalog retrieval scope', () => {
  it('rejects an expired absolute catalog deadline before starting retrieval', async () => {
    const { repository } = setup([]);
    const orchestrator = new AgentManagerOrchestrator({} as never, repository as never, {} as never, {} as never);
    await expect((orchestrator as unknown as {
      searchCatalogProducts(input: { query: string; limit: number; productIntent: 'generator'; deadlineAtMs: number }): Promise<unknown>;
    }).searchCatalogProducts({ query: 'generator', limit: 4, productIntent: 'generator', deadlineAtMs: Date.now() - 1 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(repository.searchProducts).not.toHaveBeenCalled();
  });

  it('does not retry catalog work after its absolute deadline crosses before the abort timer ticks', async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const neverAborted = new AbortController();
    let scheduledTimeoutMs = 0;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      scheduledTimeoutMs = milliseconds;
      return neverAborted.signal;
    });
    const searchProducts = vi.fn(async () => {
      now += scheduledTimeoutMs + 1;
      return [] as Product[];
    });
    const saveToolArtifact = vi.fn(async () => undefined);
    const trace = vi.fn(async () => undefined);
    const request = {
      id: 'catalog-deadline', tool: 'catalog.search' as const,
      args: { query: 'generator', productIntent: 'generator', canonicalProductIntent: 'generator' as const },
      required: true, rationale: 'find generators', coversRequirementIds: []
    };
    const intent = { ...intentFor(['generator']), toolRequests: [request] };
    const executor = new AgentManagerToolExecutor(
      { saveToolArtifact } as never,
      { searchProducts } as never,
      {} as never,
      {} as never,
      async () => null,
      (async () => { throw new Error('unexpected price read'); }) as never,
      trace
    );
    try {
      const result = await (executor as unknown as { executeTools(input: Record<string, unknown>): Promise<{
        toolResults: ToolResult[];
      }> }).executeTools({
        session: { id: 'session' }, turnId: 'turn', executionOwner: 'test', userMessage: 'generator', history: [],
        intent, toolRequests: [request], needState: emptyNeedState(), pendingLeadCaptureDraft: null,
        persistedToolResults: new Map(), budget: new AgentManagerTurnBudget()
      });

      expect(searchProducts).toHaveBeenCalledOnce();
      expect(result.toolResults[0]).toMatchObject({ status: 'timeout', warnings: expect.arrayContaining(['attempts:1']) });
      expect(saveToolArtifact).toHaveBeenCalledOnce();
    } finally {
      timeoutSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('emits authoritative load-order metadata for the exact returned candidate scope', async () => {
    const candidates = [8, 4, 3.4, 6.6, 7].map((power) => ({
      ...exact,
      id: `generator-${power}`,
      name: `Generator ${power} kW`,
      specs: { 'Nominal power': `${power} kW` }
    }));
    const repository = {
      searchProductsByModelTokens: vi.fn(async () => []),
      searchProducts: vi.fn(async () => candidates),
      vectorSearch: vi.fn(async () => []),
      getEmbeddingCoverage: vi.fn(async () => ({ target: 'products', total: 5, embedded: 5, usable: 5, coverage: 1 }))
    };
    const saveToolArtifact = vi.fn(async () => undefined);
    const trace = vi.fn(async () => undefined);
    const loadRequest = {
      id: 'load', tool: 'calculator.generatorLoad' as const, args: { loads: [] },
      required: true, rationale: 'reuse proven workshop load', coversRequirementIds: []
    };
    const catalogRequest = {
      id: 'catalog', tool: 'catalog.search' as const,
      args: { query: 'generator', productIntent: 'generator', canonicalProductIntent: 'generator' as const, limit: 4 },
      required: true, rationale: 'find preliminary candidates', coversRequirementIds: []
    };
    const intent = { ...intentFor(['generator']), toolRequests: [loadRequest, catalogRequest] };
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.selectionGoal = 'preliminary_fit';
    intent.selectionPolicy!.maxCards = 4;
    const loadResult: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: ['generator_load_startup_unconfirmed'],
      payload: { profile: { totalRunningKw: 2.9, runningOnlyNominalFloorKw: 3, missingStartingLoads: ['pump:насос'] } }
    };
    const executor = new AgentManagerToolExecutor(
      { saveToolArtifact } as never,
      repository as never,
      {} as never,
      {} as never,
      async () => null,
      (async () => { throw new Error('unexpected price read'); }) as never,
      trace
    );

    const result = await (executor as unknown as { executeTools(input: Record<string, unknown>): Promise<{
      toolResults: ToolResult[];
    }> }).executeTools({
      session: { id: 'session' }, turnId: 'turn', executionOwner: 'test', userMessage: 'workshop generator', history: [],
      intent, toolRequests: [loadRequest, catalogRequest], needState: emptyNeedState(), pendingLeadCaptureDraft: null,
      persistedToolResults: new Map([['load', loadResult]]), budget: new AgentManagerTurnBudget()
    });
    const catalog = result.toolResults.find((toolResult) => toolResult.requestId === 'catalog');

    expect(catalog?.payload).toMatchObject({
      productIds: ['generator-3.4', 'generator-4', 'generator-6.6', 'generator-7'],
      generatorLoadFit: {
        filterMinimumKw: 3,
        basis: 'running_only_floor',
        ranking: {
          scope: 'returned_eligible_candidates',
          metric: 'nominal_power_kw',
          referenceKw: 3,
          orderedProductIds: ['generator-3.4', 'generator-4', 'generator-6.6', 'generator-7'],
          candidates: [
            { productId: 'generator-3.4', nominalKw: 3.4, deltaAboveMinimumKw: 0.4 },
            { productId: 'generator-4', nominalKw: 4, deltaAboveMinimumKw: 1 },
            { productId: 'generator-6.6', nominalKw: 6.6, deltaAboveMinimumKw: 3.6 },
            { productId: 'generator-7', nominalKw: 7, deltaAboveMinimumKw: 4 }
          ]
        }
      }
    });
  });

  it('keeps closer preliminary generators ahead of oversized cards with more complete attributes', async () => {
    const candidate = (id: string, power: number, phaseKnown: boolean): Product => ({
      ...exact,
      id,
      name: `Generator ${power} kW`,
      specs: {
        'Nominal power': `${power} kW`,
        ...(phaseKnown ? { 'число фаз': 'однофазные' } : {})
      }
    });
    const candidates = [
      candidate('confirmed-6', 6, true),
      candidate('confirmed-12', 12, true),
      candidate('preliminary-4', 4, false),
      candidate('preliminary-5', 5, false)
    ];
    const repository = {
      searchProductsByModelTokens: vi.fn(async () => []),
      searchProducts: vi.fn(async () => candidates),
      vectorSearch: vi.fn(async () => []),
      getEmbeddingCoverage: vi.fn(async () => ({ target: 'products', total: 4, embedded: 4, usable: 4, coverage: 1 }))
    };
    const loadRequest = {
      id: 'load', tool: 'calculator.generatorLoad' as const, args: { loads: [] },
      required: true, rationale: 'reuse workshop load', coversRequirementIds: []
    };
    const catalogRequest = {
      id: 'catalog', tool: 'catalog.search' as const,
      args: { query: 'generator', productIntent: 'generator', canonicalProductIntent: 'generator' as const, limit: 3 },
      required: true, rationale: 'find three preliminary candidates', coversRequirementIds: []
    };
    const intent = { ...intentFor(['generator']), toolRequests: [loadRequest, catalogRequest] };
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.selectionGoal = 'preliminary_fit';
    intent.selectionPolicy!.maxCards = 3;
    intent.selectionPolicy!.phase = 'single_phase';
    const loadResult: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: ['generator_load_startup_unconfirmed'],
      payload: { profile: { totalRunningKw: 2.9, runningOnlyNominalFloorKw: 3, missingStartingLoads: ['pump:насос'] } }
    };
    const executor = new AgentManagerToolExecutor(
      { saveToolArtifact: vi.fn(async () => undefined) } as never,
      repository as never,
      {} as never,
      {} as never,
      async () => null,
      (async () => { throw new Error('unexpected price read'); }) as never,
      vi.fn(async () => undefined)
    );

    const result = await (executor as unknown as { executeTools(input: Record<string, unknown>): Promise<{
      toolResults: ToolResult[];
    }> }).executeTools({
      session: { id: 'session' }, turnId: 'turn', executionOwner: 'test', userMessage: 'workshop generator', history: [],
      intent, toolRequests: [loadRequest, catalogRequest], needState: emptyNeedState(), pendingLeadCaptureDraft: null,
      persistedToolResults: new Map([['load', loadResult]]), budget: new AgentManagerTurnBudget()
    });
    const catalog = result.toolResults.find((toolResult) => toolResult.requestId === 'catalog');

    expect(catalog?.payload).toMatchObject({
      productIds: ['preliminary-4', 'preliminary-5', 'confirmed-6'],
      generatorLoadFit: {
        ranking: {
          orderedProductIds: ['preliminary-4', 'preliminary-5', 'confirmed-6']
        }
      }
    });
    expect(catalog?.warnings).toContain('answer_products_preliminary:unknown_evidence_kept:2');
    expect(catalog?.payload).not.toMatchObject({ productIds: expect.arrayContaining(['confirmed-12']) });
  });
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

  it('applies a proven running-only floor before broad-candidate ranking and slicing', async () => {
    const low = Array.from({ length: 8 }, (_, index) => ({
      ...exact,
      id: `low-${index}`,
      name: `Generator LOW-${index}`,
      specs: { 'Nominal power': `${0.65 + index * 0.13} kW` }
    }));
    const above = [3, 3.5, 5].map((power) => ({
      ...exact,
      id: `fit-${power}`,
      name: `Generator FIT-${power}`,
      specs: { 'Nominal power': `${power} kW` }
    }));
    const unknown = { ...exact, id: 'unknown-power', name: 'Generator UNKNOWN', specs: {} };
    const repository = {
      searchProductsByModelTokens: vi.fn(async () => []),
      searchProducts: vi.fn()
        .mockResolvedValueOnce(low)
        .mockResolvedValueOnce([...low, above[2]!, unknown, above[1]!, above[0]!]),
      getProductsByIds: vi.fn(async (ids: string[]) => [...above, unknown].filter((product) => ids.includes(product.id))),
      vectorSearch: vi.fn(async () => []),
      getEmbeddingCoverage: vi.fn(async () => ({ target: 'products', total: 1, embedded: 1, usable: 1, coverage: 1 }))
    };
    const orchestrator = new AgentManagerOrchestrator({} as never, repository as never, {} as never, {} as never);
    const intent = intentFor(['generator']);
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.selectionGoal = 'preliminary_fit';
    intent.selectionPolicy!.maxCards = 4;
    const load: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: ['generator_load_startup_unconfirmed'],
      payload: { profile: { totalRunningKw: 2.9, runningOnlyNominalFloorKw: 3, missingStartingLoads: ['pump:насос'] } }
    };
    const result = await (orchestrator as unknown as {
      searchCatalogProducts(input: { query: string; limit: number; productIntent: 'generator'; intent: AgentIntentContract;
        toolResults: ToolResult[] }): Promise<{ products: Product[]; primaryExpansion?: unknown }>;
    }).searchCatalogProducts({ query: 'generator', limit: 4, productIntent: 'generator', intent, toolResults: [load] });

    expect(result.products.map((product) => product.id)).toEqual(['fit-3', 'fit-3.5', 'fit-5', 'unknown-power']);
    expect(repository.searchProducts.mock.calls[1]?.[2]).toMatchObject({ compact: true });
    expect(repository.getProductsByIds).toHaveBeenCalledWith(
      ['fit-3', 'fit-3.5', 'fit-5', 'unknown-power'],
      expect.objectContaining({ signal: undefined })
    );
  });

  it('reproduces the production workshop order from the running-only floor before the top-four slice', async () => {
    const powers = [8, 7, 17, 4, 7.1, 10, 6.6, 3.4];
    const shuffled = powers.map((power, index) => ({
      ...exact,
      id: `generator-${index}-${power}`,
      name: `Generator ${power} kW`,
      specs: { 'Nominal power': `${power} kW` }
    }));
    const { search } = setup([], shuffled);
    const intent = intentFor(['generator']);
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.selectionGoal = 'preliminary_fit';
    intent.selectionPolicy!.maxCards = 4;
    const load: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: ['generator_load_startup_unconfirmed'],
      payload: { profile: { totalRunningKw: 2.9, runningOnlyNominalFloorKw: 3, missingStartingLoads: ['pump:насос'] } }
    };

    const result = await search(intent, undefined, [load]);

    expect(result.products.map((product) => product.specs['Nominal power'])).toEqual([
      '3.4 kW', '4 kW', '6.6 kW', '7 kW'
    ]);
  });

  it.each([
    ['price objective', 'price_rub', 'minimize', 'high-power-cheap'],
    ['nominal objective', 'nominal_power_kw', 'maximize', 'high-power-cheap']
  ] as const)('does not override an explicit %s with the default load order', async (_label, attribute, direction, firstId) => {
    const candidates: Product[] = [
      { ...exact, id: 'low-power-expensive', name: 'Generator 3.4 kW', price: 90_000, specs: { 'Nominal power': '3.4 kW' } },
      { ...exact, id: 'high-power-cheap', name: 'Generator 8 kW', price: 50_000, specs: { 'Nominal power': '8 kW' } }
    ];
    const { search } = setup([], candidates);
    const intent = intentFor(['generator']);
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.requirements = [{
      id: 'preference', kind: 'buyer_preference', value: true, unit: null,
      relation: 'preferred', role: 'preference', strictness: 'preferred',
      evidence: 'planner-bound preference', verification: { mode: 'product_attribute' }
    }];
    intent.selectionPolicy!.rankingObjectives = [{ requirementId: 'preference', attribute, direction }];
    const load: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
      payload: { profile: { requiredNominalKw: 3 } }
    };

    const result = await search(intent, undefined, [load]);

    expect(result.products[0]?.id).toBe(firstId);
  });

  it('keeps remote-start preference ahead of the default minimum-nominal order', async () => {
    const candidates: Product[] = [
      { ...exact, id: 'small-manual', name: 'Generator 3.4 kW', specs: { 'Nominal power': '3.4 kW', 'remote start': false } },
      { ...exact, id: 'remote-eight', name: 'Generator 8 kW remote', specs: { 'Nominal power': '8 kW', запуск: 'дистанционный' } }
    ];
    const { search } = setup([], candidates);
    const intent = intentFor(['generator']);
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.requirements = [{
      id: 'prefer-remote', kind: 'remote_start', value: true, unit: null,
      relation: 'preferred', role: 'preference', strictness: 'preferred',
      evidence: 'buyer prefers remote start', verification: { mode: 'product_attribute' }
    }];
    const load: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
      payload: { profile: { requiredNominalKw: 3 } }
    };

    const result = await search(intent, undefined, [load]);

    expect(result.products.map((product) => product.id)).toEqual(['remote-eight', 'small-manual']);
  });

  it('keeps fully proven hard-constraint candidates ahead of lower-power unconfirmed candidates', async () => {
    const candidates: Product[] = [
      { ...exact, id: 'unconfirmed-3.1', name: 'Generator 3.1 kW', specs: { 'Nominal power': '3.1 kW' } },
      { ...exact, id: 'confirmed-3.4', name: 'Generator 3.4 kW 220 V', specs: { 'Nominal power': '3.4 kW', Voltage: '220 V' } }
    ];
    const { search } = setup([], candidates);
    const intent = intentFor(['generator']);
    intent.selectionPolicy!.alternativePolicy = 'same_class_only';
    intent.selectionPolicy!.phase = 'single_phase';
    const load: ToolResult = {
      requestId: 'load', tool: 'calculator.generatorLoad', status: 'ok', warnings: [],
      payload: { profile: { requiredNominalKw: 3 } }
    };

    const result = await search(intent, undefined, [load]);

    expect(result.products.map((product) => product.id)).toEqual(['confirmed-3.4', 'unconfirmed-3.1']);
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
