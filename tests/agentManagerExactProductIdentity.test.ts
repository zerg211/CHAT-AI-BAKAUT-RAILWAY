import { describe, expect, it } from 'vitest';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import {
  exactModelNamesFromUserMessage,
  filterProductsByStructuredSelectionPolicy,
  repairIntentForExactModelEvidence,
  requiredResponseClausesForToolResults
} from '../src/ai/agentManagerOrchestrator.js';
import type { Product } from '../src/shared/types.js';

function exactTargetIntent(targetName: string): AgentIntentContract {
  return {
    userMessageSummary: `Сравнить ${targetName}`,
    dialogueUnderstanding: 'Покупатель указал точную модель.',
    nextStepRationale: 'Использовать только точную модель.',
    requiresTools: false,
    toolRequests: [],
    grounding: {
      taskType: 'comparison',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      requiredToolKinds: [],
      technicalAttributes: [],
      rationale: 'Сначала точная карточка каталога.'
    },
    productMentions: [{
      name: targetName,
      role: 'target_product',
      evidence: targetName
    }],
    selectionPolicy: {
      targetProductClass: 'бензорез',
      canonicalProductClass: null,
      selectionGoal: 'browse_catalog',
      needAction: 'continue',
      alternativePolicy: 'exact_only',
      reusePreviousCards: false,
      maxCards: 1,
      powerSource: 'any',
      phase: null,
      requirements: [],
      rankingObjectives: [],
      rationale: 'Запрошена точная модель.'
    },
    policyRuleIds: [],
    mustNotAskQuestionIds: [],
    riskFlags: []
  };
}

function product(input: Partial<Product> & Pick<Product, 'id' | 'name'>): Product {
  return {
    id: input.id,
    externalId: input.externalId ?? null,
    slug: input.slug ?? null,
    sourceUrl: input.sourceUrl ?? null,
    name: input.name,
    brand: input.brand ?? 'Husqvarna',
    category: input.category ?? 'Бензорезы',
    price: input.price ?? 100_000,
    currency: input.currency ?? 'RUB',
    imageUrl: input.imageUrl ?? null,
    description: input.description ?? null,
    specs: input.specs ?? {},
    raw: input.raw ?? {},
    lastSeenAt: input.lastSeenAt ?? null,
    lastSyncedAt: input.lastSyncedAt ?? null,
    isActive: input.isActive ?? true,
    sourceContentHash: input.sourceContentHash ?? null
  };
}

describe('structured exact-product identity', () => {
  it('does not add external research for a pure catalog-availability question', () => {
    const targetName = 'Wacker Neuson BPS 1550 Aw';
    const intent: AgentIntentContract = {
      ...exactTargetIntent(targetName),
      userMessageSummary: `Is ${targetName} available?`,
      dialogueUnderstanding: 'The buyer asks only whether the named model is in the BAKAUT catalog.',
      nextStepRationale: 'Answer catalog presence from the catalog; do not research technical facts.',
      grounding: {
        taskType: 'availability_or_delivery',
        sourcePolicy: 'catalog_required',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['catalog.search'],
        technicalAttributes: [],
        buyerQuestion: `Is ${targetName} available?`,
        rationale: 'Catalog presence is sufficient for this question.'
      },
      toolRequests: [{
        id: 'catalog-availability',
        tool: 'catalog.search',
        args: { query: targetName },
        rationale: 'Find the exact catalog card.',
        required: true
      }]
    };

    const repaired = repairIntentForExactModelEvidence(intent, `Is ${targetName} available?`);

    expect(repaired.toolRequests.some((request) => request.tool === 'web.researchProductFacts')).toBe(false);
    expect(repaired.toolRequests.map((request) => request.tool)).toEqual([
      'catalog.search',
      'catalog.getProductDetails'
    ]);
    expect(repaired.toolRequests.at(-1)?.args.productNames).toEqual([targetName]);
    expect(repaired.toolRequests.at(-1)?.args.comparisonAttributes).toEqual([]);
    expect(repaired.grounding?.requiredToolKinds).toEqual([
      'catalog.search',
      'catalog.getProductDetails'
    ]);

    const staleWebPlannedIntent: AgentIntentContract = {
      ...intent,
      requiresTools: true,
      toolRequests: [
        ...intent.toolRequests,
        {
          id: 'stale-web-request',
          tool: 'web.researchProductFacts',
          args: { productNames: [targetName], comparisonAttributes: ['current buyer question'] },
          rationale: 'An inconsistent planner request that must not run for catalog presence.',
          required: true
        }
      ],
      grounding: {
        ...intent.grounding!,
        requiredToolKinds: ['catalog.search', 'web.researchProductFacts']
      }
    };
    const cleaned = repairIntentForExactModelEvidence(staleWebPlannedIntent, `Is ${targetName} available?`);
    expect(cleaned.toolRequests.some((request) => request.tool === 'web.researchProductFacts')).toBe(false);
    expect(cleaned.grounding?.requiredToolKinds).toEqual([
      'catalog.search',
      'catalog.getProductDetails'
    ]);

    const failedWebResult = {
      requestId: 'stale-web-request',
      tool: 'web.researchProductFacts',
      status: 'timeout',
      payload: { searchDisposition: 'timed_out' },
      warnings: []
    } as unknown as ToolResult;
    expect(requiredResponseClausesForToolResults([failedWebResult], intent)).toEqual([]);
  });

  it('recovers split model names even when the planner omitted product mentions', () => {
    const userMessage = 'Нужна виброплита Wacker Neuson BPS 1550 Aw с двигателем Honda GX160 QX2.';
    expect(exactModelNamesFromUserMessage(userMessage)).toEqual(['bps 1550 aw', 'gx160 qx2']);

    const intent = {
      toolRequests: [],
      productMentions: [],
      riskFlags: [],
      requiresTools: false
    } as unknown as AgentIntentContract;
    const repaired = repairIntentForExactModelEvidence(intent, userMessage);
    expect(repaired.toolRequests).toHaveLength(1);
    expect(repaired.toolRequests[0]?.tool).toBe('web.researchProductFacts');
    expect(repaired.toolRequests[0]?.args.productNames).toEqual(['bps 1550 aw', 'gx160 qx2']);
    expect(repaired.riskFlags).toContain('planner_repaired_exact_model_evidence');
  });

  it('does not treat a generic product class as an exact model when the planner labels it target_product', () => {
    const userMessage = 'Нужна бензиновая виброплита для работы одному: вес 60–90 кг, бюджет до 90 000 ₽.';
    const intent = {
      toolRequests: [{
        id: 'catalog-search',
        tool: 'catalog.search',
        args: { query: userMessage },
        rationale: 'Find suitable catalog products.',
        required: true
      }],
      productMentions: [{
        name: 'виброплита',
        role: 'target_product',
        productClass: 'виброплита',
        evidence: 'бензиновая виброплита'
      }],
      riskFlags: [],
      requiresTools: true
    } as unknown as AgentIntentContract;

    const repaired = repairIntentForExactModelEvidence(intent, userMessage);

    expect(repaired.toolRequests.some((request) => request.tool === 'web.researchProductFacts')).toBe(false);
  });

  it('does not convert an unverified refresh failure into catalog absence', () => {
    const result = {
      requestId: 'exact-bps-refresh',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        researchOutcome: 'partial',
        sourcesExhausted: false,
        searchDisposition: 'failed',
        targetProductNames: ['BPS 1550 Aw'],
        comparisonAttributes: ['oil'],
        unconfirmedFacts: [{ attribute: 'oil', status: 'not_confirmed' }],
        catalogPresence: [{ productName: 'BPS 1550 Aw', status: 'unknown', exactProductIds: [] }],
        nearbyCatalogProducts: [],
        facts: []
      },
      warnings: []
    } as unknown as ToolResult;

    const clauses = requiredResponseClausesForToolResults([result]);
    expect(clauses.map((clause) => clause.code)).toContain('catalog_presence_unverified');
    expect(clauses.map((clause) => clause.code)).not.toContain('state_exact_catalog_absence');
    expect(clauses.map((clause) => clause.instruction).join('\n')).toContain('Do not say that BPS 1550 Aw is absent');
  });

  it('does not turn a neighbouring model blade dimension into the requested model code', () => {
    const requested = product({
      id: 'k770',
      name: 'Husqvarna K 770',
      slug: 'husqvarna-k-770',
      sourceUrl: 'https://bakautprof.ru/catalog/benzorezy/husqvarna-k-770/'
    });
    const neighbour = product({
      id: 'k970',
      name: 'Husqvarna K 970',
      slug: 'husqvarna-k-970',
      sourceUrl: 'https://bakautprof.ru/catalog/benzorezy/husqvarna-k-970/',
      specs: { 'Максимальный диаметр диска': '770 мм' }
    });

    const result = filterProductsByStructuredSelectionPolicy({
      products: [requested, neighbour],
      intent: exactTargetIntent('Husqvarna K 770'),
      toolResults: []
    });

    expect(result.products.map((item) => item.id)).toEqual(['k770']);
    expect(result.droppedProductIds).toEqual(['k970']);
  });
});
