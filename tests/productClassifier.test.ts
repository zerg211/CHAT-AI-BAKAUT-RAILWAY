import { describe, expect, it } from 'vitest';

import { productMatchesIntent } from '../src/ai/productClassifier.js';
import type { Product } from '../src/shared/types.js';

function product(name: string): Product {
  return {
    id: name,
    name,
    brand: 'TSS',
    category: '',
    price: 0,
    currency: 'RUB',
    specs: {}
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
