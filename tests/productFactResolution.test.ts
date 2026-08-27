import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import { productCards } from '../src/ai/agentManagerCardSelection.js';
import { resolveProductsForEvidence } from '../src/ai/productFactResolution.js';
import type { Product } from '../src/shared/types.js';

function product(specs: Record<string, unknown>): Product {
  return {
    id: 'cimar-cpc-1550',
    name: 'Виброплита прямоходная бензиновая CIMAR CPC-1550 (98 кг) ВИБ203',
    brand: 'CIMAR',
    category: 'Виброплиты',
    sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/cimar-cpc-1550/',
    specs
  };
}

function webResult(input: {
  productName: string;
  attribute: string;
  value: string;
  warnings?: string[];
  conflicts?: unknown[];
}): ToolResult {
  return {
    requestId: 'web:cimar',
    tool: 'web.researchProductFacts',
    status: 'ok',
    payload: {
      searchDisposition: 'memory_hit',
      facts: [{
        productName: input.productName,
        attribute: input.attribute,
        value: input.value,
        sourceType: 'web',
        confidence: 'high',
        sourceUrl: 'https://www.cimar.com.cn/product/cpc-1550/'
      }],
      conflicts: input.conflicts ?? []
    },
    warnings: input.warnings ?? []
  };
}

describe('product fact resolution', () => {
  it('uses one exact source-backed value for duplicate catalog aliases', () => {
    const item = product({
      вес: '90 кг',
      центробежнаяСила: '15 кН',
      'центробежная сила, кн': '24',
      'мощность двигателя, квт': '4.8',
      'мощность двигателя, л.с.': '5.5'
    });

    const resolution = resolveProductsForEvidence({
      products: [item],
      toolResults: [webResult({
        productName: item.name,
        attribute: 'центробежнаяСила',
        value: '15 кН'
      })]
    });

    expect(resolution.products[0]?.specs).toEqual({
      вес: '90 кг',
      центробежнаяСила: '15 кН',
      'мощность двигателя, квт': '4.8',
      'мощность двигателя, л.с.': '5.5'
    });
    expect(productCards(
      resolution.products,
      [],
      resolution.caveatsByProductId
    )[0]?.specs).toEqual(resolution.products[0]?.specs);
    expect(resolution.conflictsByProductId).toEqual({});
    expect(resolution.warnings).toEqual([]);
  });

  it('uses a checked exact fact to replace a stale single catalog value', () => {
    const item = product({ 'центробежная сила, кн': '24' });
    const resolution = resolveProductsForEvidence({
      products: [item],
      toolResults: [webResult({
        productName: item.name,
        attribute: 'центробежнаяСила',
        value: '15 кН'
      })]
    });

    expect(resolution.products[0]?.specs).toEqual({ 'центробежная сила, кн': '15 кН' });
    expect(resolution.products[0]?.evidenceConflicts).toBeUndefined();
  });

  it('removes unresolved duplicate values instead of selecting by object order', () => {
    const item = product({
      центробежнаяСила: '15 кН',
      'центробежная сила, кн': '24'
    });
    const resolution = resolveProductsForEvidence({ products: [item] });

    expect(resolution.products[0]?.specs).toEqual({});
    expect(resolution.products[0]?.evidenceConflicts).toEqual([{
      attribute: 'центробежнаяСила',
      keys: ['центробежнаяСила', 'центробежная сила, кн'],
      values: ['15 кН', '24']
    }]);
    expect(resolution.caveatsByProductId[item.id]).toEqual([
      'Характеристика «центробежнаяСила» указана в нескольких вариантах; точное значение нужно уточнить.'
    ]);
  });

  it('does not bind a fact for a different product and does not hide the conflict', () => {
    const item = product({
      центробежнаяСила: '15 кН',
      'центробежная сила, кн': '24'
    });
    const resolution = resolveProductsForEvidence({
      products: [item],
      toolResults: [webResult({
        productName: 'CIMAR CPC-1700',
        attribute: 'центробежнаяСила',
        value: '15 кН'
      })]
    });

    expect(resolution.products[0]?.specs).toEqual({});
    expect(resolution.conflictsByProductId[item.id]).toHaveLength(1);
  });

  it('keeps an unresolved source conflict fail-closed even when one web value exists', () => {
    const item = product({ 'центробежнаяСила': '15 кН' });
    const resolution = resolveProductsForEvidence({
      products: [item],
      toolResults: [webResult({
        productName: item.name,
        attribute: 'центробежнаяСила',
        value: '15 кН',
        conflicts: [{
          productName: item.name,
          attribute: 'центробежнаяСила',
          catalogValue: '15 кН',
          webValues: ['24 кН'],
          resolution: 'sources disagree'
        }]
      })]
    });

    expect(resolution.products[0]?.specs).toEqual({});
    expect(resolution.products[0]?.evidenceConflicts).toHaveLength(1);
  });
});
