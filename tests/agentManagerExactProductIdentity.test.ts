import { describe, expect, it } from 'vitest';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import {
  filterProductsByStructuredSelectionPolicy,
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
  it('keeps every unknown generator startup load while asking only one next question', () => {
    const missingStartingLoads = [
      'refrigerator:холодильник',
      'pump:циркуляционный_насос',
      'workshop_tool:инструмент'
    ];
    const result = {
      requestId: 'generator-load',
      tool: 'calculator.generatorLoad',
      status: 'ok',
      payload: {
        profile: {
          totalRunningKw: 2.9,
          runningOnlyNominalFloorKw: 3,
          missingStartingLoads
        }
      },
      warnings: ['generator_load_startup_unconfirmed']
    } as unknown as ToolResult;

    const clause = requiredResponseClausesForToolResults([result])
      .find((item) => item.code === 'generator_unconfirmed_load_stage_aware_selection');

    expect(clause?.instruction).toContain(JSON.stringify(missingStartingLoads));
    expect(clause?.instruction).toContain('Every listed load remains a blocker');
    expect(clause?.instruction).toContain('describe it only as the next step');
    expect(clause?.instruction).not.toContain('ask for the smallest fact needed before final_fit');
  });

  it('does not turn an unexecuted availability research request into buyer-facing failure guidance', () => {
    const failedWebResult = {
      requestId: 'stale-web-request',
      tool: 'web.researchProductFacts',
      status: 'timeout',
      payload: { searchDisposition: 'timed_out' },
      warnings: []
    } as unknown as ToolResult;
    expect(requiredResponseClausesForToolResults([
      failedWebResult
    ], exactTargetIntent('Wacker Neuson BPS 1550 Aw'))).toEqual([]);
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
