import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Product } from '../src/shared/types.js';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

const { researchProductComparisonFacts } = await import('../src/ai/productComparisonResearch.js');

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'rd3910e',
    name: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт',
    brand: 'FIRMAN',
    category: 'Бензиновые генераторы',
    price: 1000,
    currency: 'RUB',
    sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd3910e_2_5_kvt/',
    specs: { starter: 'ручной стартер / электростартер' },
    description: 'Запуск двигателя осуществляется поворотом ключа электростартера. Также предусмотрен ручной стартер.',
    ...overrides
  };
}

function result(overrides: Record<string, unknown>) {
  return {
    usedWebSearch: false,
    facts: [],
    conflicts: [],
    answerGuidance: {
      directAnswer: '',
      completeness: 'not_answered',
      coverage: []
    },
    summaryForAnswer: '',
    warnings: [],
    ...overrides
  };
}

describe('product comparison research', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
  });

  it('answers from exact catalog description before opening web search', async () => {
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: result({
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          value: 'запуск поворотом ключа электростартера; также есть ручной стартер',
          sourceType: 'catalog',
          confidence: 'high',
          evidence: 'catalog.description: запуск двигателя осуществляется поворотом ключа электростартера',
          sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd3910e_2_5_kvt/',
          sourceTitle: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт'
        }],
        answerGuidance: {
          directAnswer: 'RD3910E запускается с ключа электростартера, плюс есть ручной запуск. Кнопочный запуск не подтвержден.',
          completeness: 'answered',
          coverage: [{
            attribute: 'key start',
            status: 'confirmed',
            value: 'поворот ключа электростартера',
            evidence: 'catalog.description',
            sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd3910e_2_5_kvt/',
            sourceTitle: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт'
          }]
        },
        summaryForAnswer: 'Catalog description confirms key electric start and manual start.'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или с кнопки?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(actual.usedWebSearch).toBe(false);
    expect(actual.answerGuidance.directAnswer).toContain('ключа электростартера');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_extraction_used',
      'exact_catalog_description_extracted'
    ]));
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    const catalogCall = createStructuredJsonResponse.mock.calls[0][0];
    expect(catalogCall.stage).toBe('catalog_product_fact_extraction');
    expect(catalogCall.request.tools).toBeUndefined();
    expect(JSON.stringify(catalogCall.request.input)).toContain('поворотом ключа электростартера');
  });

  it('broadens to web only when exact catalog extraction is incomplete', async () => {
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          answerGuidance: {
            directAnswer: '',
            completeness: 'not_answered',
            coverage: [{
              attribute: 'button start',
              status: 'not_found',
              value: '',
              evidence: 'catalog.description/specs do not answer',
              sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd3910e_2_5_kvt/',
              sourceTitle: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт'
            }]
          },
          warnings: ['catalog_fact_missing_needs_web_research']
        })
      })
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD3910E',
            attribute: 'start control',
            value: 'manufacturer page confirms electrostarter; button control not confirmed',
            sourceType: 'web',
            confidence: 'medium',
            evidence: 'official page names exact model and electrostarter',
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }],
          answerGuidance: {
            directAnswer: 'По найденным источникам у RD3910E есть электростартер; кнопочный запуск не подтвержден.',
            completeness: 'answered',
            coverage: [{
              attribute: 'electric start',
              status: 'confirmed',
              value: 'electrostarter',
              evidence: 'official exact model page',
              sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
              sourceTitle: 'FIRMAN RD3910E'
            }]
          },
          summaryForAnswer: 'Web research filled missing start-control evidence.'
        })
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или с кнопки?',
      products: [product({ description: 'В описании есть только общие преимущества генератора.' })],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(actual.usedWebSearch).toBe(true);
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'web', productName: 'FIRMAN RD3910E' }),
      expect.objectContaining({ sourceType: 'catalog', attribute: 'manual starter', value: 'есть' })
    ]));
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'manual starter', status: 'confirmed', value: 'есть' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_missing_needs_web_research',
      'catalog_fact_extraction_used',
      'catalog_fact_extraction_needed_web_research',
      'catalog_starter_specs_extracted'
    ]));
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    const webCall = createStructuredJsonResponse.mock.calls[1][0];
    expect(webCall.stage).toBe('product_comparison_research');
    expect(webCall.request.tools).toEqual([{ type: 'web_search_preview', search_context_size: 'high' }]);
    expect(JSON.stringify(webCall.request.input)).toContain('catalogExtraction');
  });
});
