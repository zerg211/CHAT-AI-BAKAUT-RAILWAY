import { describe, expect, it } from 'vitest';

import {
  detectProductAttributeConflicts,
  extractAttributesFromProductName,
  extractStructuredProductAttributes,
  normalizeAttributeValue
} from '../src/ai/productAttributeExtraction.js';
import type { Product } from '../src/shared/types.js';

function product(overrides: Partial<Product>): Product {
  return {
    id: 'p1',
    name: 'Товар',
    category: 'Виброплиты',
    price: 1000,
    currency: 'RUB',
    specs: {},
    ...overrides
  };
}

describe('productAttributeExtraction', () => {
  it('extracts weight from product name and structured specs', () => {
    const item = product({
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP60TH (60 кг, 10,5 кН, 500х360) 207192',
      specs: {
        'Рабочая масса, кг': '72',
        'Центробежная сила, кН': '10,5',
        'Длина основания, мм': '500',
        'Ширина основания, мм': '360'
      }
    });

    expect(extractAttributesFromProductName(item)).toMatchObject({
      weightKg: { value: 60, raw: '60 кг' },
      centrifugalForceKn: { value: 10.5, raw: '10,5 кН' },
      plateSizeMm: { value: '500x360', raw: '500х360' }
    });

    expect(extractStructuredProductAttributes(item)).toMatchObject({
      weightKg: { value: 72, raw: '72' },
      centrifugalForceKn: { value: 10.5, raw: '10,5' },
      plateSizeMm: { value: '500x360' }
    });
  });

  it('detects buyer-critical conflicts between name and specs', () => {
    const item = product({
      id: 'tss-wp60th',
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/tss_wp60th/',
      name: 'Виброплита ТСС TSS-WP60TH (60 кг, 10,5 кН, 500х360) 207192',
      specs: {
        'рабочая масса, кг': '72',
        'центробежная сила, кН': '10,5'
      }
    });

    expect(detectProductAttributeConflicts(item, ['weightKg', 'centrifugalForceKn'])).toEqual([
      {
        productId: 'tss-wp60th',
        productName: item.name,
        productUrl: item.sourceUrl,
        attribute: 'weightKg',
        nameValue: 60,
        specsValue: 72,
        nameRaw: '60 кг',
        specsRaw: '72'
      }
    ]);
  });

  it('normalizes numeric values with comma decimals and compatible units', () => {
    expect(normalizeAttributeValue('centrifugalForceKn', '10,5 кН')).toEqual(10.5);
    expect(normalizeAttributeValue('weightKg', '60 кг')).toEqual(60);
    expect(normalizeAttributeValue('voltageV', '220 В')).toEqual(220);
  });

  it('preserves numeric, unit-boundary, whitespace, and alternate size-separator behavior', () => {
    const item = product({
      name: 'Установка 220V; 10.5KN) основание 500 X 360, ложное значение 60кгс',
      specs: {
        'V, номинальное': '220',
        'Тип запуска': '  электрический\n   стартер  ',
        'Размер основания, мм': '500 × 360'
      }
    });

    expect(extractAttributesFromProductName(item)).toMatchObject({
      voltageV: { value: 220, raw: '220V' },
      centrifugalForceKn: { value: 10.5, raw: '10.5KN' },
      plateSizeMm: { value: '500x360', raw: '500 X 360' }
    });
    expect(extractAttributesFromProductName(item).weightKg).toBeUndefined();
    expect(extractStructuredProductAttributes(item)).toMatchObject({
      voltageV: { value: 220 },
      starterType: { value: 'электрический стартер', raw: 'электрический стартер' },
      plateSizeMm: { value: '500x360', raw: '500 × 360' }
    });
  });
});
