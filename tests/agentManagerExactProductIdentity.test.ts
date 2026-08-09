import { describe, expect, it } from 'vitest';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import { filterProductsByStructuredSelectionPolicy } from '../src/ai/agentManagerOrchestrator.js';
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
