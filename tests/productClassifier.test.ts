import { describe, expect, it } from 'vitest';

import {
  extractWeightKg,
  oilViscosities,
  parseLoosePositiveNumber,
  productLiters,
  productMatchesIntent,
  productPowerSource,
  requestedLiters
} from '../src/ai/productClassifier.js';
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

  it('recognizes English gasoline and petrol catalog labels as fuel evidence', () => {
    expect(productPowerSource(product('Gasoline generator 5 kW'))).toBe('gasoline');
    expect(productPowerSource(product('Petrol generator 5 kW'))).toBe('gasoline');
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

describe('productClassifier oil and liter parsing without regex', () => {
  it('extracts and normalizes explicit oil viscosity tokens', () => {
    expect(oilViscosities('SAE 10W-40 для генератора, можно 5w30')).toEqual(['10w40', '5w30']);
  });

  it('keeps model-like embedded text from being treated as viscosity', () => {
    expect(oilViscosities('model x10w40y')).toEqual([]);
  });

  it('extracts requested oil package volume from Russian and English units', () => {
    expect(requestedLiters('нужно масло 1,5 л')).toBe(1.5);
    expect(requestedLiters('take 2l oil')).toBe(2);
    expect(requestedLiters('масло 4 литра')).toBe(4);
  });

  it('reads product volume through the stable productLiters API', () => {
    expect(productLiters(product('Масло SAE 10W-40 1 л'))).toBe(1);
  });
});
