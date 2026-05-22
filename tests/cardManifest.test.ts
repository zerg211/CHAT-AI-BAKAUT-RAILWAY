import { describe, expect, it } from 'vitest';
import type { ExecutionContract, ProductCard } from '../src/shared/types.js';
import { buildCardManifest, enforceVisibleCardConstraints } from '../src/ai/cardManifest.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';

const gasolineTssCard: ProductCard = {
  id: 'tss-8',
  name: 'TSS SGG 8000EH бензиновый генератор 220 В',
  brand: 'TSS',
  category: 'Генераторы',
  price: 82000,
  currency: 'RUB',
  specs: {
    fuel: 'бензин',
    voltage: '220 В'
  },
  reasons: [],
  caveats: []
};

const dieselOtherCard: ProductCard = {
  id: 'other-8',
  name: 'Other DG 8000 дизельный генератор 380 В',
  brand: 'Other',
  category: 'Генераторы',
  price: 76000,
  currency: 'RUB',
  specs: {
    fuel: 'дизель',
    voltage: '380 В'
  },
  reasons: [],
  caveats: []
};

const petrolCompactVoltageCard: ProductCard = {
  id: 'petrol-compact-220',
  name: 'Compact petrol generator 230V 1-ф',
  brand: 'TSS',
  category: 'Generators',
  price: 91000,
  currency: 'RUB',
  specs: {
    fuel: 'petrol',
    voltage: '230V однофазный'
  },
  reasons: [],
  caveats: []
};

const threePhaseCard: ProductCard = {
  id: 'three-phase',
  name: 'TSS diesel generator 400V 3-ф',
  brand: 'TSS',
  category: 'Generators',
  price: 126000,
  currency: 'RUB',
  specs: {
    fuel: 'diesel',
    voltage: 'трёхфазный'
  },
  reasons: [],
  caveats: []
};

const plateCard: ProductCard = {
  id: 'plate-90',
  name: 'TSS виброплита 90 кг',
  brand: 'TSS',
  category: 'Виброплиты',
  price: 59000,
  currency: 'RUB',
  specs: {
    weight: '90 кг'
  },
  reasons: [],
  caveats: []
};

const manualStartGeneratorCard: ProductCard = {
  id: 'manual-start-generator',
  name: 'SUMEC SU7700 gasoline generator 5 kW',
  brand: 'SUMEC',
  category: 'Generators',
  price: 42490,
  currency: 'RUB',
  specs: {
    start: 'manual recoil starter'
  },
  reasons: [],
  caveats: []
};

const electricStartGeneratorCard: ProductCard = {
  id: 'electric-start-generator',
  name: 'DAEWOO GDA 6500E gasoline generator 5.5 kW',
  brand: 'DAEWOO',
  category: 'Generators',
  price: 67990,
  currency: 'RUB',
  specs: {
    start: 'manual / electric starter'
  },
  reasons: [],
  caveats: []
};

function executionContract(overrides: Partial<ExecutionContract> = {}): ExecutionContract {
  const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
    hardConstraints: {
      ...emptyNeedState().selectionState.hardConstraints,
      productIntent: 'generator',
      brandConstraint: 'TSS',
      fuel: 'gasoline',
      singlePhase220: true
    }
  });
  return {
    version: 1,
    source: 'agent_turn_contract',
    answerTask: 'product_selection',
    taskType: 'product_selection',
    catalogPolicy: 'find_matching_products',
    cardsPolicy: 'primary',
    leadPolicy: 'none',
    factPolicy: 'catalog_only',
    activeRequirementIds: ['req-generator', 'req-tss-gasoline-220'],
    activeConstraints: selectionState.hardConstraints,
    postconditions: [],
    warnings: [],
    ...overrides
  };
}

describe('card manifest', () => {
  it('records visible cards that satisfy hard constraints', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [gasolineTssCard],
      visibleProductIds: ['tss-8'],
      hiddenProductIds: []
    });

    expect(manifest.items[0]).toMatchObject({
      productId: 'tss-8',
      visible: true,
      role: 'primary',
      constraintStatus: 'satisfies_hard_constraints',
      violations: []
    });
    expect(manifest.warnings).toEqual([]);
  });

  it('surfaces visible-card hard constraint violations for audit metadata', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [dieselOtherCard],
      visibleProductIds: ['other-8'],
      hiddenProductIds: []
    });

    expect(manifest.items[0].constraintStatus).toBe('violates_hard_constraints');
    expect(manifest.items[0].violations).toEqual(expect.arrayContaining([
      'brandConstraint:TSS',
      'fuel:gasoline',
      'singlePhase220:true'
    ]));
    expect(manifest.warnings).toContain('visible_card_constraint_violation:other-8');
  });

  it('does not flag hidden cards as visible recommendation violations', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract({ cardsPolicy: 'supporting' }),
      cards: [gasolineTssCard, dieselOtherCard],
      visibleProductIds: ['tss-8'],
      hiddenProductIds: ['other-8']
    });

    expect(manifest.items[0].role).toBe('supporting');
    expect(manifest.items[1]).toMatchObject({
      productId: 'other-8',
      visible: false,
      role: 'hidden',
      constraintStatus: 'unchecked',
      violations: []
    });
    expect(manifest.warnings).toEqual([]);
  });

  it('removes visible cards that violate high-confidence hard constraints before rendering', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [dieselOtherCard, gasolineTssCard],
      visibleProductIds: ['other-8', 'tss-8'],
      hiddenProductIds: []
    });

    const enforced = enforceVisibleCardConstraints({
      manifest,
      cards: [dieselOtherCard, gasolineTssCard]
    });

    expect(enforced.enforced).toBe(true);
    expect(enforced.suppressedProductIds).toEqual(['other-8']);
    expect(enforced.cards.map((card) => card.id)).toEqual(['tss-8']);
  });

  it('keeps compact gasoline and 220/230 V phase signals compatible without regex', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [petrolCompactVoltageCard],
      visibleProductIds: ['petrol-compact-220'],
      hiddenProductIds: []
    });

    expect(manifest.items[0]).toMatchObject({
      productId: 'petrol-compact-220',
      constraintStatus: 'satisfies_hard_constraints',
      violations: []
    });
  });

  it('flags three-phase diesel cards against gasoline single-phase constraints without regex', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [threePhaseCard],
      visibleProductIds: ['three-phase'],
      hiddenProductIds: []
    });

    expect(manifest.items[0].violations).toEqual(expect.arrayContaining([
      'fuel:gasoline',
      'singlePhase220:true'
    ]));
  });

  it('flags product-class mismatches without regex classification', () => {
    const manifest = buildCardManifest({
      executionContract: executionContract(),
      cards: [plateCard],
      visibleProductIds: ['plate-90'],
      hiddenProductIds: []
    });

    expect(manifest.items[0].violations).toContain('productIntent:generator');
  });

  it('suppresses visible manual-start cards when electric start is an active hard constraint', () => {
    const baseConstraints = executionContract().activeConstraints;
    if (!baseConstraints) throw new Error('Expected active constraints in test fixture');
    const contract = executionContract({
      activeConstraints: {
        ...baseConstraints,
        brandConstraint: undefined,
        singlePhase220: undefined,
        startType: 'electric'
      }
    });
    const manifest = buildCardManifest({
      executionContract: contract,
      cards: [manualStartGeneratorCard, electricStartGeneratorCard],
      visibleProductIds: ['manual-start-generator', 'electric-start-generator'],
      hiddenProductIds: []
    });

    expect(manifest.items.find((item) => item.productId === 'manual-start-generator')?.violations).toContain('startType:electric');
    expect(manifest.items.find((item) => item.productId === 'electric-start-generator')?.violations).toEqual([]);

    const enforced = enforceVisibleCardConstraints({
      manifest,
      cards: [manualStartGeneratorCard, electricStartGeneratorCard]
    });

    expect(enforced.cards.map((card) => card.id)).toEqual(['electric-start-generator']);
  });
});
