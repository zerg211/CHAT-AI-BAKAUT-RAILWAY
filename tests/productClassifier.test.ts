import { describe, expect, it } from 'vitest';

import { extractWeightKg, parseLoosePositiveNumber, productMatchesIntent } from '../src/ai/productClassifier.js';
import type { Product } from '../src/shared/types.js';

function product(name: string, overrides: Partial<Product> = {}): Product {
  return {
    id: name,
    name,
    brand: 'TSS',
    category: '',
    price: 0,
    currency: 'RUB',
    specs: {},
    ...overrides
  };
}

describe('productClassifier core title prefix parsing', () => {
  it('keeps core generator prefixes stronger than accessory words without regex', () => {
    const item = product('Generator filter kit 5 kW');

    expect(productMatchesIntent(item, 'generator')).toBe(true);
    expect(productMatchesIntent(item, 'generatorAccessory')).toBe(false);
  });

  it('keeps separator boundaries equivalent to the legacy title prefix check', () => {
    const item = product('Generator-Filter kit 5 kW');

    expect(productMatchesIntent(item, 'generator')).toBe(true);
    expect(productMatchesIntent(item, 'generatorAccessory')).toBe(false);
  });
});

describe('productClassifier weight parsing without regex', () => {
  it('extracts the first loose positive number from spec text', () => {
    expect(parseLoosePositiveNumber('mass: 62,5 kg')).toBe(62.5);
    expect(parseLoosePositiveNumber('about 70.25 kg')).toBe(70.25);
    expect(parseLoosePositiveNumber('no numeric value')).toBeUndefined();
  });

  it('prefers structured mass specs before scanning title text', () => {
    const item = product('Vibroplita model 100 88 kg', {
      specs: { weight: '64,5 kg' }
    });

    expect(extractWeightKg(item)).toBe(64.5);
  });

  it('extracts English and Russian weight units from product text', () => {
    expect(extractWeightKg(product('Vibroplita model 100 88 kg'))).toBe(88);
    expect(extractWeightKg(product('Виброплита WP60L 60 кг'))).toBe(60);
  });

  it('ignores model digits not followed by a weight unit', () => {
    expect(extractWeightKg(product('Vibroplita WP60L compact model'))).toBeUndefined();
  });
});
