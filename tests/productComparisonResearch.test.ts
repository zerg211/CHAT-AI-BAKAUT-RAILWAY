import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Product } from '../src/shared/types.js';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

vi.mock('undici', () => ({
  fetch: fetchMock
}));

const { researchProductComparisonFacts } = await import('../src/ai/productComparisonResearch.js');

function sourceResponse(body: string, contentType = 'text/html; charset=utf-8') {
  return {
    ok: true,
    headers: {
      get: (name: string) => name.toLocaleLowerCase('en-US') === 'content-type' ? contentType : null
    },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  };
}

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
    fetchMock.mockReset();
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
    fetchMock.mockResolvedValueOnce(sourceResponse('FIRMAN RD3910E ignition key electric starter manual starter.'));
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
            value: 'manufacturer page confirms electric starter through an ignition key; button control not confirmed',
            sourceType: 'web',
            confidence: 'medium',
            evidence: 'official page names exact model, electrostarter, and ignition key start',
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }],
          answerGuidance: {
            directAnswer: 'По найденным источникам RD3910E запускается электростартером с ключа; кнопочный запуск не подтвержден.',
            completeness: 'answered',
            coverage: [{
              attribute: 'key start',
              status: 'confirmed',
              value: 'ignition key electric start',
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

  it('does a dedicated control search when electric starter is found but key/button control is unresolved', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E manual starter electric starter.'))
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E control panel: ignition key START switch, electric starter, manual starter.'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'starting method',
            value: 'manual starter / electric starter',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'official exact model page lists manual starter and electric starter',
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/generator-benzinovyy-FIRMAN-RD4910E',
            sourceTitle: 'FIRMAN RD4910E'
          }],
          answerGuidance: {
            directAnswer: 'RD4910E has electric starter and manual start. Key/button control is not confirmed.',
            completeness: 'answered',
            coverage: [
              {
                attribute: 'electric start',
                status: 'confirmed',
                value: 'electric starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/generator-benzinovyy-FIRMAN-RD4910E',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                attribute: 'key start',
                status: 'not_confirmed',
                value: '',
                evidence: 'first pass found electric starter but not the control',
                sourceUrl: null,
                sourceTitle: null
              },
              {
                attribute: 'button start',
                status: 'not_confirmed',
                value: '',
                evidence: 'first pass found electric starter but not the control',
                sourceUrl: null,
                sourceTitle: null
              }
            ]
          },
          summaryForAnswer: 'Electric starter is confirmed but the control is not yet confirmed.'
        })
      })
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'key start',
            value: 'ignition key / START switch',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'control panel photo and manual label the ignition key switch for exact model RD4910E',
            sourceUrl: 'https://example.test/firman-rd4910e-control-panel',
            sourceTitle: 'FIRMAN RD4910E control panel'
          }],
          answerGuidance: {
            directAnswer: 'RD4910E запускается электростартером с ключа. Ручной запуск тоже есть; кнопочный запуск не подтвержден.',
            completeness: 'answered',
            coverage: [
              {
                attribute: 'key start',
                status: 'confirmed',
                value: 'ignition key / START switch',
                evidence: 'control panel photo and manual label the ignition key switch for exact model RD4910E',
                sourceUrl: 'https://example.test/firman-rd4910e-control-panel',
                sourceTitle: 'FIRMAN RD4910E control panel'
              },
              {
                attribute: 'button start',
                status: 'not_confirmed',
                value: '',
                evidence: 'dedicated control search did not find a push button',
                sourceUrl: null,
                sourceTitle: null
              }
            ]
          },
          summaryForAnswer: 'Dedicated control search confirmed key start.'
        })
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD4910E заводится с ключа или с кнопки?',
      products: [product({ name: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт' })],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(createStructuredJsonResponse.mock.calls[1][0].stage).toBe('product_comparison_research_exact_retry');
    expect(JSON.stringify(createStructuredJsonResponse.mock.calls[0][0].request.input)).toContain('control panel photo');
    expect(createStructuredJsonResponse.mock.calls[1][0].request.input[0].content).toContain('dedicated control search');
    expect(actual.answerGuidance.directAnswer).toContain('с ключа');
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'key start', status: 'confirmed' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'exact_target_external_retry_used',
      'electric_start_control_retry_used'
    ]));
    expect(actual.warnings).not.toContain('electric_start_control_not_confirmed_after_retry');
  });

  it('rejects invented key-start evidence when the cited source only proves electric starter', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E. Starting system: manual starter, electric starter. Kit: spark plug wrench.'))
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E PDF. Starting system: manual starter, electric starter. Kit: spark plug wrench.'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [
            {
              productName: 'FIRMAN RD4910E',
              attribute: 'starting method',
              value: 'manual starter / electric starter',
              sourceType: 'web',
              confidence: 'high',
              evidence: 'official exact model page lists manual starter and electric starter',
              sourceUrl: 'https://example.test/firman-rd4910e',
              sourceTitle: 'FIRMAN RD4910E'
            },
            {
              productName: 'FIRMAN RD4910E',
              attribute: 'key start',
              value: 'starts with an ignition key',
              sourceType: 'web',
              confidence: 'high',
              evidence: 'research result claimed the source says to turn the key',
              sourceUrl: 'https://example.test/firman-rd4910e',
              sourceTitle: 'FIRMAN RD4910E'
            }
          ],
          answerGuidance: {
            directAnswer: 'RD4910E starts with a key and also has manual start.',
            completeness: 'answered',
            coverage: [
              {
                attribute: 'electric start',
                status: 'confirmed',
                value: 'electric starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                attribute: 'manual starter',
                status: 'confirmed',
                value: 'manual starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                attribute: 'key start',
                status: 'confirmed',
                value: 'ignition key',
                evidence: 'research result claimed the source says to turn the key',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E'
              }
            ]
          },
          summaryForAnswer: 'Electric and manual starter are real; key start was overclaimed.'
        })
      })
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'key start',
            value: 'starts with an ignition key',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'retry claimed key start from the PDF',
            sourceUrl: 'https://example.test/firman-rd4910e.pdf',
            sourceTitle: 'FIRMAN RD4910E PDF'
          }],
          answerGuidance: {
            directAnswer: 'RD4910E starts with a key.',
            completeness: 'answered',
            coverage: [{
              attribute: 'key start',
              status: 'confirmed',
              value: 'ignition key',
              evidence: 'retry claimed key start from the PDF',
              sourceUrl: 'https://example.test/firman-rd4910e.pdf',
              sourceTitle: 'FIRMAN RD4910E PDF'
            }]
          },
          summaryForAnswer: 'Retry still overclaimed key start.'
        })
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(actual.answerGuidance.coverage.some((item) =>
      item.attribute === 'key start' && item.status === 'confirmed'
    )).toBe(false);
    expect(actual.answerGuidance.directAnswer).not.toContain('starts with a key');
    expect(actual.answerGuidance.directAnswer).toContain('источники');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_evidence_validation_failed:key_start',
      'answer_guidance_rewritten_after_source_validation',
      'electric_start_control_not_confirmed_after_retry'
    ]));
  });

  it('keeps key-start evidence when the cited source text actually supports it', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E. Start procedure: turn the key to START. Electric starter and manual starter are available.'));
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD4910E',
          attribute: 'key start',
          value: 'turn the key to START',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'source says turn the key to START',
          sourceUrl: 'https://example.test/firman-rd4910e-manual',
          sourceTitle: 'FIRMAN RD4910E manual'
        }],
        answerGuidance: {
          directAnswer: 'RD4910E starts with a key; manual start is also available.',
          completeness: 'answered',
          coverage: [{
            attribute: 'key start',
            status: 'confirmed',
            value: 'turn the key to START',
            evidence: 'source says turn the key to START',
            sourceUrl: 'https://example.test/firman-rd4910e-manual',
            sourceTitle: 'FIRMAN RD4910E manual'
          }]
        },
        summaryForAnswer: 'Source-backed key start.'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'key start', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.directAnswer).toContain('starts with a key');
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:key_start');
  });

  it('uses exact-source product images as visual evidence for key start when text only confirms electric start', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse(`
        <html>
          <head><title>FIRMAN RD4910E generator</title></head>
          <body>
            <h1>FIRMAN RD4910E</h1>
            <p>Starting system: manual starter, electric starter.</p>
            <figure>
              <img src="/images/rd4910e-key-panel.jpg" alt="Electric starter and battery included">
              <figcaption>Electric starter / battery included</figcaption>
            </figure>
          </body>
        </html>
      `))
      .mockResolvedValueOnce(sourceResponse('fake image bytes', 'image/jpeg'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'starting method',
            value: 'manual starter / electric starter',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'official page lists manual starter and electric starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E generator'
          }],
          answerGuidance: {
            directAnswer: 'Electric starter and manual start are confirmed. Key or button control is not confirmed.',
            completeness: 'partially_answered',
            coverage: [
              {
                attribute: 'electric start',
                status: 'confirmed',
                value: 'electric starter',
                evidence: 'official page lists electric starter',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E generator'
              },
              {
                attribute: 'manual starter',
                status: 'confirmed',
                value: 'manual starter',
                evidence: 'official page lists manual starter',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E generator'
              },
              {
                attribute: 'key start',
                status: 'not_confirmed',
                value: '',
                evidence: 'text source does not name the control',
                sourceUrl: null,
                sourceTitle: null
              }
            ]
          },
          summaryForAnswer: 'Text confirms electric/manual start only.'
        })
      })
      .mockResolvedValueOnce({
        parsed: {
          confirmedControls: [{
            kind: 'key_start',
            confidence: 'high',
            evidence: 'The exact source image visibly shows a keyed ignition/key switch on the generator panel.',
            imageUrl: 'https://example.test/images/rd4910e-key-panel.jpg',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E generator'
          }],
          warnings: []
        }
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(createStructuredJsonResponse.mock.calls[1][0].stage).toBe('source_visual_start_control_validation');
    expect(JSON.stringify(createStructuredJsonResponse.mock.calls[1][0].request.input)).toContain('input_image');
    expect(JSON.stringify(createStructuredJsonResponse.mock.calls[1][0].request.input)).toContain('data:image/jpeg;base64');
    expect(JSON.stringify(createStructuredJsonResponse.mock.calls[1][0].request.input)).toContain('rd4910e-key-panel.jpg');
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'key start', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.directAnswer).toContain('ключ');
    expect(actual.answerGuidance.directAnswer).not.toContain('не подтвердили');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_visual_start_control_evidence_used',
      'answer_guidance_rewritten_after_source_validation'
    ]));
  });

  it('does not convert generic electric-starter images into key or button evidence', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse(`
        <html>
          <head><title>FIRMAN RD4910E generator</title></head>
          <body>
            <h1>FIRMAN RD4910E</h1>
            <p>Starting system: manual starter, electric starter.</p>
            <figure>
              <img src="/images/rd4910e-electric-starter-icon.jpg" alt="Electric starter">
              <figcaption>Electric starter</figcaption>
            </figure>
          </body>
        </html>
      `))
      .mockResolvedValueOnce(sourceResponse('fake image bytes', 'image/jpeg'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'starting method',
            value: 'manual starter / electric starter',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'official page lists manual starter and electric starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E generator'
          }],
          answerGuidance: {
            directAnswer: 'Electric starter and manual start are confirmed. Key or button control is not confirmed.',
            completeness: 'partially_answered',
            coverage: [{
              attribute: 'electric start',
              status: 'confirmed',
              value: 'electric starter',
              evidence: 'official page lists electric starter',
              sourceUrl: 'https://example.test/firman-rd4910e',
              sourceTitle: 'FIRMAN RD4910E generator'
            }]
          },
          summaryForAnswer: 'Text confirms electric/manual start only.'
        })
      })
      .mockResolvedValueOnce({
        parsed: {
          confirmedControls: [],
          warnings: ['generic_electric_starter_image_only']
        }
      })
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          answerGuidance: {
            directAnswer: '',
            completeness: 'not_answered',
            coverage: []
          },
          warnings: ['exact_target_external_fact_not_found']
        })
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(3);
    expect(createStructuredJsonResponse.mock.calls[1][0].stage).toBe('source_visual_start_control_validation');
    expect(actual.answerGuidance.coverage.some((item) =>
      item.attribute === 'key start' && item.status === 'confirmed'
    )).toBe(false);
    expect(actual.answerGuidance.directAnswer).toContain('не подтвердили');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_visual_start_control_not_confirmed',
      'generic_electric_starter_image_only',
      'electric_start_control_not_confirmed_after_retry'
    ]));
  });

  it('treats manual/electric source wording as electric start evidence without inventing the control', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E. Способ запуска: Ручной/электро.'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'starting method',
            value: 'ручной / электрический стартер',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'source says Способ запуска: Ручной/электро',
            sourceUrl: 'https://example.test/firman-rd4910e-manual-electric',
            sourceTitle: 'FIRMAN RD4910E manual'
          }],
          answerGuidance: {
            directAnswer: 'Ручной запуск есть. Электрозапуск и его управление источники не подтвердили.',
            completeness: 'partially_answered',
            coverage: [
              {
                attribute: 'starting method',
                status: 'confirmed',
                value: 'ручной / электрический стартер',
                evidence: 'source says Способ запуска: Ручной/электро',
                sourceUrl: 'https://example.test/firman-rd4910e-manual-electric',
                sourceTitle: 'FIRMAN RD4910E manual'
              },
              {
                attribute: 'key start',
                status: 'not_confirmed',
                value: '',
                evidence: 'source does not identify key actuation',
                sourceUrl: null,
                sourceTitle: null
              },
              {
                attribute: 'button start',
                status: 'not_confirmed',
                value: '',
                evidence: 'source does not identify button actuation',
                sourceUrl: null,
                sourceTitle: null
              }
            ]
          },
          summaryForAnswer: 'Manual/electric start is supported, control is unresolved.'
        })
      })
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          answerGuidance: {
            directAnswer: '',
            completeness: 'not_answered',
            coverage: []
          },
          warnings: ['exact_target_external_fact_not_found']
        })
      });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(actual.answerGuidance.directAnswer).toContain('Электростартер есть');
    expect(actual.answerGuidance.directAnswer).toContain('ручной запуск тоже есть');
    expect(actual.answerGuidance.directAnswer).toContain('источники не подтвердили');
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:electric_start');
  });
});
