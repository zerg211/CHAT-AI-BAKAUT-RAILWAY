import { describe, expect, it } from 'vitest';
import type { CardManifest, ExecutionContract, ProductCard } from '../src/shared/types.js';
import { answerProductReferenceViolations, buildProductEvidenceRegistry } from '../src/ai/productEvidenceRegistry.js';

const executionContract: ExecutionContract = {
  version: 1,
  source: 'agent_turn_contract',
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogPolicy: 'find_matching_products',
  cardsPolicy: 'primary',
  leadPolicy: 'none',
  factPolicy: 'catalog_only',
  activeRequirementIds: [],
  postconditions: [],
  warnings: []
};

const cards: ProductCard[] = [
  {
    id: 'ok',
    name: 'TSS SGG 10000EH gasoline generator',
    category: 'Generators',
    specs: {},
    reasons: [],
    caveats: []
  },
  {
    id: 'bad',
    name: 'Other 2 kW generator',
    category: 'Generators',
    specs: {},
    reasons: [],
    caveats: []
  }
];

const manifest: CardManifest = {
  version: 1,
  source: 'execution_contract',
  cardsPolicy: 'primary',
  visibleProductIds: ['ok', 'bad'],
  hiddenProductIds: [],
  warnings: ['visible_card_constraint_violation:bad'],
  items: [
    {
      productId: 'ok',
      name: cards[0].name,
      rank: 1,
      visible: true,
      role: 'primary',
      constraintStatus: 'satisfies_hard_constraints',
      violations: []
    },
    {
      productId: 'bad',
      name: cards[1].name,
      rank: 2,
      visible: true,
      role: 'alternative',
      constraintStatus: 'violates_hard_constraints',
      violations: ['powerKw']
    }
  ]
};

describe('product evidence registry', () => {
  it('allows answer text only for visible cards that satisfy constraints', () => {
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: manifest,
      cards
    });

    expect(registry.visibleProductIds).toEqual(['ok']);
    expect(registry.allowedProductIdsForText).toEqual(['ok']);
    expect(registry.rejectedProductIds).toContain('bad');
    expect(registry.warnings).toContain('visible_product_not_allowed:bad');
  });

  it('detects answer references to disallowed products', () => {
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: manifest,
      cards
    });

    expect(answerProductReferenceViolations({
      answer: 'The best option is Other 2 kW generator.',
      registry
    })).toEqual(['bad']);
  });

  it('uses catalog product names for rejected products that were not rendered as cards', () => {
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: {
        ...manifest,
        visibleProductIds: ['ok'],
        items: [manifest.items[0]]
      },
      cards: [cards[0]],
      catalogProducts: [
        {
          id: 'catalog-bad',
          name: 'Catalog Bad 2 kW generator',
          category: 'Generators',
          sourceUrl: 'https://example.test/catalog-bad',
          specs: {}
        }
      ],
      rejectedProducts: [{
        productId: 'catalog-bad',
        reason: 'power below hard constraint'
      }]
    });

    expect(registry.items.find((item) => item.productId === 'catalog-bad')?.name).toBe('Catalog Bad 2 kW generator');
    expect(answerProductReferenceViolations({
      answer: 'Catalog Bad 2 kW generator is the best option.',
      registry
    })).toEqual(['catalog-bad']);
  });

  it('allows answer text for hidden show-more cards that satisfy constraints', () => {
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: {
        ...manifest,
        visibleProductIds: ['ok'],
        hiddenProductIds: ['hidden'],
        items: [
          manifest.items[0],
          {
            productId: 'hidden',
            name: 'TSS hidden generator',
            rank: 2,
            visible: false,
            role: 'hidden',
            constraintStatus: 'satisfies_hard_constraints',
            violations: []
          }
        ]
      },
      cards: [
        cards[0],
        {
          id: 'hidden',
          name: 'TSS hidden generator',
          category: 'Generators',
          specs: {},
          reasons: [],
          caveats: []
        }
      ]
    });

    expect(registry.allowedProductIdsForText).toEqual(['ok', 'hidden']);
    expect(answerProductReferenceViolations({
      answer: 'More options include TSS hidden generator.',
      registry
    })).toEqual([]);
  });
});
