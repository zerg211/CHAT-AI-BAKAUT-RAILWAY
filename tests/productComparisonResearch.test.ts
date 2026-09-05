import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Product } from '../src/shared/types.js';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const extractPdfTextMock = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

vi.mock('../src/ai/pdfTextExtraction.js', () => ({
  extractPdfText: extractPdfTextMock,
  PdfTextExtractionError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
}));

vi.mock('undici', () => ({
  fetch: fetchMock,
  Agent: class {
    async close() {}
  }
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}));

const {
  boundedResearchStageDeadline,
  classifyProductResearchSource,
  researchWarningsPreventSourceExhaustion,
  researchProductComparisonFacts
} = await import('../src/ai/productComparisonResearch.js');
import type { ProductResearchTraceEvent } from '../src/ai/productComparisonResearch.js';
import { validateToolResultOutput } from '../src/ai/agentManagerToolRegistry.js';

const queuedResearchResponses: Array<{ parsed: Record<string, unknown>; response?: unknown }> = [];

function sourceResponse(body: string, contentType = 'text/html; charset=utf-8') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
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
    sourceAttempts: [],
    summaryForAnswer: '',
    warnings: [],
    ...overrides
  };
}

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function normalized(value: unknown) {
  return String(value ?? '').toLocaleLowerCase('ru-RU');
}

function includesAny(text: string, fragments: string[]) {
  return fragments.some((fragment) => text.includes(normalized(fragment)));
}

function sourceSupportedStartKinds(sourceText: unknown) {
  const source = normalized(sourceText);
  const supportedKinds: string[] = [];
  if (includesAny(source, ['ignition key', 'turn the key', 'starts with key', 'starts with a key', ru('\\u043a\\u043b\\u044e\\u0447')])) {
    supportedKinds.push('key_start');
  }
  if (includesAny(source, ['push button', 'button start', ru('\\u043a\\u043d\\u043e\\u043f')])) {
    supportedKinds.push('button_start');
  }
  if (includesAny(source, ['start switch', 'engine switch', 'starter switch', 'start position'])) {
    supportedKinds.push('switch_start');
  }
  if (includesAny(source, ['electric starter', 'electric start', ru('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e')])) {
    supportedKinds.push('electric_start');
  }
  if (includesAny(source, ['manual starter', 'recoil starter', ru('\\u0440\\u0443\\u0447')])) {
    supportedKinds.push('manual_starter');
  }
  return supportedKinds;
}

function semanticValidationResponse(call: { request: { input?: Array<{ role?: string; content?: string }> } }) {
  const userInput = call.request.input?.find((item) => item.role === 'user');
  const payload = userInput?.content
    ? JSON.parse(userInput.content) as {
        sourceText?: string;
        sources?: Array<{ sourceId: string; sourceText: string }>;
        claim?: { attribute?: string; value?: string; evidence?: string };
        claims?: Array<{
          itemIndex: number;
          sourceText?: string;
          sourceId?: string;
          claim?: { attribute?: string; value?: string; evidence?: string };
        }>;
      }
    : {};
  const validation = (entry: {
    sourceText?: string;
    claim?: { attribute?: string; value?: string; evidence?: string };
  }) => {
    const claimText = normalized([
      entry.claim?.attribute,
      entry.claim?.value,
      entry.claim?.evidence
    ].filter(Boolean).join(' '));
    const claimStartKinds = sourceSupportedStartKinds(claimText)
      .filter((kind) => kind !== 'button_start' || !includesAny(claimText, [
        'button control not confirmed',
        'button start not confirmed',
        'push button not confirmed'
      ]));
    const supportedStartKinds = sourceSupportedStartKinds(entry.sourceText);
    const claimSupported = claimStartKinds.length
      ? claimStartKinds.every((kind) => supportedStartKinds.includes(kind))
      : Boolean(
          entry.sourceText &&
          entry.claim?.value &&
          entry.claim?.evidence &&
          normalized(entry.sourceText).includes(normalized(entry.claim.value)) &&
          normalized(entry.sourceText).includes(normalized(entry.claim.evidence))
        );
    const sourceText = String(entry.sourceText ?? '');
    const claimEvidence = String(entry.claim?.evidence ?? '');
    const exactEvidence = claimEvidence && normalized(sourceText).includes(normalized(claimEvidence))
      ? claimEvidence
      : sourceText.slice(0, 320);
    return {
      claimSupported,
      targetApplicability: 'exact_model',
      scopeQuote: '',
      claimStartKinds,
      supportedStartKinds,
      publisherAuthority: 'unknown',
      publisherEvidence: '',
      evidence: exactEvidence,
      warnings: []
    };
  };
  if (payload.claims) {
    return {
      parsed: {
        validations: payload.claims.map((entry) => ({
          itemIndex: entry.itemIndex,
          ...validation({ ...entry, sourceText: payload.sources?.find((source) => source.sourceId === entry.sourceId)?.sourceText ?? entry.sourceText })
        }))
      }
    };
  }
  return {
    parsed: validation(payload)
  };
}

function semanticValidationResponseWith(
  call: { request: { input?: Array<{ role?: string; content?: string }> } },
  overrides: Record<string, unknown>
) {
  const response = semanticValidationResponse(call);
  const validations = (response.parsed as { validations?: Array<Record<string, unknown>> }).validations;
  return validations
    ? { parsed: { validations: validations.map((validation) => ({ ...validation, ...overrides })) } }
    : { parsed: { ...response.parsed, ...overrides } };
}

function researchCalls() {
  return createStructuredJsonResponse.mock.calls
    .map((call) => call[0])
    .filter((call) => call.stage !== 'source_evidence_semantic_validation');
}

function compactCatalogResult(overrides: Record<string, unknown> = {}) {
  return {
    facts: [],
    conflicts: [],
    missing: [],
    directAnswer: '',
    completeness: 'not_answered',
    ...overrides
  };
}

function queueResearchResponse(response: { parsed: Record<string, unknown>; response?: unknown }) {
  queuedResearchResponses.push(response);
}

describe('product comparison research', () => {
  it('reserves time for fallback instead of giving the primary stage the whole deadline', () => {
    expect(boundedResearchStageDeadline({
      overallDeadlineAtMs: 100_000,
      maxDurationMs: 24_000,
      reserveMs: 16_000,
      nowMs: 1_000
    })).toBe(25_000);
    expect(boundedResearchStageDeadline({
      overallDeadlineAtMs: 30_000,
      maxDurationMs: 24_000,
      reserveMs: 16_000,
      nowMs: 1_000
    })).toBe(14_000);
  });

  it('derives manufacturer/manual authority from the actual host and document URL', () => {
    expect(classifyProductResearchSource({
      sourceUrl: 'https://www.firman.biz/manuals/RD3910E-manual.pdf',
      sourceTitle: 'FIRMAN RD3910E instruction manual',
      product: product()
    })).toMatchObject({
      host: 'firman.biz',
      documentKind: 'manual_or_specification',
      tier: 'official_manual',
      authority: 'manufacturer'
    });
    expect(classifyProductResearchSource({
      sourceUrl: 'https://marketplace.example/firman-rd3910e',
      sourceTitle: 'Marketplace listing',
      product: product()
    })).toMatchObject({
      tier: 'reliable_secondary',
      authority: 'secondary'
    });
    expect(classifyProductResearchSource({
      sourceUrl: 'https://firman-reviews.example/manuals/RD3910E-manual.pdf',
      sourceTitle: 'Unofficial FIRMAN review manual mirror',
      product: product()
    })).toMatchObject({
      tier: 'reliable_secondary',
      authority: 'secondary'
    });
    expect(classifyProductResearchSource({
      sourceUrl: 'https://sunreka.example/products/G7000iS',
      sourceTitle: 'SUNREKA G7000iS product page',
      product: product({ name: 'SUNREKA G7000iS', brand: 'SUNREKA' })
    })).toMatchObject({
      tier: 'reliable_secondary',
      authority: 'secondary'
    });
  });

  it('downgrades an uncorroborated secondary-source claim from high to medium confidence', async () => {
    const quote = 'FIRMAN RD3910E service interval is 100 hours.';
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote}</body></html>`));
    const secondaryResult = result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'service interval',
        value: '100 hours',
        sourceType: 'web',
        confidence: 'high',
        evidence: quote,
        sourceUrl: 'https://equipment-shop.example/firman-rd3910e-service',
        sourceTitle: 'FIRMAN RD3910E service listing'
      }],
      answerGuidance: {
        directAnswer: 'Межсервисный интервал 100 моточасов.',
        completeness: 'answered',
        coverage: [{
          attribute: 'service interval',
          status: 'confirmed',
          value: '100 hours',
          evidence: quote,
          sourceUrl: 'https://equipment-shop.example/firman-rd3910e-service',
          sourceTitle: 'FIRMAN RD3910E service listing'
        }]
      }
    });
    queueResearchResponse({ parsed: secondaryResult });
    queueResearchResponse({ parsed: secondaryResult });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой межсервисный интервал у FIRMAN RD3910E?',
      products: [],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['service interval']
    });

    expect(actual.facts).toContainEqual(expect.objectContaining({
      confidence: 'medium',
      sourceTier: 'reliable_secondary',
      sourceAuthority: 'secondary'
    }));
  });

  it('accepts an absent target official page only when source text proves manufacturer ownership', async () => {
    const quote = 'ACME X1 rated power is 5 kW.';
    const publisherEvidence = 'ACME Power Systems is the manufacturer and publisher of this website.';
    const sourceUrl = 'https://acme-power.invalid/products/acme-x1';
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote} ${publisherEvidence}</body></html>`));
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponseWith(call, {
          claimSupported: true,
          publisherAuthority: 'manufacturer',
          publisherEvidence,
          evidence: quote
        });
      }
      const tier = call.stage === 'product_comparison_research_official_page'
        ? 'official_page'
        : 'official_manual';
      const query = `ACME X1 ${tier} rated power`;
      const hasFact = tier === 'official_page';
      return {
        parsed: result({
          usedWebSearch: true,
          sourceAttempts: [{ tier, query, outcome: hasFact ? 'confirmed' : 'not_found' }],
          facts: hasFact ? [{
            productName: 'ACME X1',
            attribute: 'rated power',
            value: '5 kW',
            sourceType: 'web',
            confidence: 'high',
            evidence: quote,
            sourceUrl,
            sourceTitle: 'ACME X1 product page'
          }] : [],
          answerGuidance: {
            directAnswer: hasFact ? 'ACME X1 has 5 kW rated power.' : '',
            completeness: hasFact ? 'answered' : 'not_answered',
            coverage: hasFact ? [{
              attribute: 'rated power',
              status: 'confirmed',
              value: '5 kW',
              evidence: quote,
              sourceUrl,
              sourceTitle: 'ACME X1 product page'
            }] : []
          }
        }),
        response: {
          output: [{
            type: 'web_search_call',
            status: 'completed',
            action: {
              query,
              sources: hasFact ? [{ url: sourceUrl, title: 'ACME X1 product page' }] : []
            }
          }]
        }
      };
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какая мощность у ACME X1?',
      products: [],
      targetProductNames: ['ACME X1'],
      comparisonAttributes: ['rated power'],
      missingFactSlots: [{ productName: 'ACME X1', attribute: 'rated power' }],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.facts).toContainEqual(expect.objectContaining({
      productName: 'ACME X1',
      sourceTier: 'official_page',
      sourceAuthority: 'manufacturer',
      confidence: 'high'
    }));
    expect(actual.warnings).toContain('source_publisher_manufacturer_verified');
    expect(actual.sourceAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'official_page', outcome: 'confirmed' })
    ]));
    expect(researchCalls().map((call) => call.stage)).toEqual([
      'product_comparison_research_official_page',
      'product_comparison_research_official_manual'
    ]);
  });

  it('starts independent official tiers together and cancels manual work after official-page coverage', async () => {
    const quote = 'FIRMAN RD3910E rated power is 5 kW.';
    let resolveOfficialPage!: (value: unknown) => void;
    let manualStarted = false;
    let manualAborted = false;
    const traces: ProductResearchTraceEvent[] = [];
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote}</body></html>`));
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponseWith(call, {
          claimSupported: true,
          evidence: quote
        });
      }
      if (call.stage === 'product_comparison_research_official_page') {
        return new Promise((resolve) => {
          resolveOfficialPage = resolve;
        });
      }
      if (call.stage === 'product_comparison_research_official_manual') {
        manualStarted = true;
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            manualAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected stage ${call.stage}`);
    });

    const researchPromise = researchProductComparisonFacts({
      userMessage: 'Какая мощность у FIRMAN RD3910E?',
      products: [],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['rated power'],
      missingFactSlots: [{ productName: 'FIRMAN RD3910E', attribute: 'rated power' }],
      catalogSearchAttempted: true,
      catalogProductsFound: false,
      onTrace: (event) => {
        traces.push(event);
      }
    });
    await vi.waitFor(() => expect(manualStarted).toBe(true));
    const query = 'FIRMAN RD3910E official rated power';
    resolveOfficialPage({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: [{ tier: 'official_page', query, outcome: 'confirmed' }],
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'rated power',
          value: '5 kW',
          sourceType: 'web',
          confidence: 'high',
          evidence: quote,
          sourceUrl: 'https://manufacturer.example/products/FIRMAN-RD3910E',
          sourceTitle: 'FIRMAN RD3910E official product page'
        }],
        answerGuidance: {
          directAnswer: 'Мощность FIRMAN RD3910E составляет 5 кВт.',
          completeness: 'answered',
          coverage: [{
            attribute: 'rated power',
            status: 'confirmed',
            value: '5 kW',
            evidence: quote,
            sourceUrl: 'https://manufacturer.example/products/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E official product page'
          }]
        }
      }),
      response: {
        output: [{
          type: 'web_search_call',
          status: 'completed',
          action: {
            query,
            sources: [{
              url: 'https://manufacturer.example/products/FIRMAN-RD3910E',
              title: 'FIRMAN RD3910E official product page'
            }]
          }
        }]
      }
    });

    const actual = await researchPromise;
    expect(actual.facts).toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'rated power',
      sourceTier: 'official_page',
      sourceAuthority: 'manufacturer'
    }));
    expect(manualAborted).toBe(true);
    expect(researchCalls().map((call) => call.stage)).toEqual([
      'product_comparison_research_official_page',
      'product_comparison_research_official_manual'
    ]);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ tiers: ['official_page'], outcome: 'completed' }),
      expect.objectContaining({ tiers: ['official_manual'], outcome: 'aborted' })
    ]));
  });

  it('cancels slow official-page work when the manual finishes first with complete evidence', async () => {
    const quote = 'FIRMAN RD3910E rated power is 5 kW.';
    let pageStarted = false;
    let pageAborted = false;
    const traces: ProductResearchTraceEvent[] = [];
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote}</body></html>`));
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponse(call);
      }
      if (call.stage === 'product_comparison_research_official_page') {
        pageStarted = true;
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            pageAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (call.stage === 'product_comparison_research_official_manual') {
        const query = 'FIRMAN RD3910E official manual rated power';
        return {
          parsed: result({
            usedWebSearch: true,
            sourceAttempts: [{ tier: 'official_manual', query, outcome: 'confirmed' }],
            facts: [{
              productName: 'FIRMAN RD3910E',
              attribute: 'rated power',
              value: '5 kW',
              sourceType: 'web',
              confidence: 'high',
              evidence: quote,
              sourceUrl: 'https://manufacturer.example/manuals/FIRMAN-RD3910E',
              sourceTitle: 'FIRMAN RD3910E official manual'
            }],
            answerGuidance: {
              directAnswer: 'Мощность FIRMAN RD3910E составляет 5 кВт.',
              completeness: 'answered',
              coverage: [{
                attribute: 'rated power',
                status: 'confirmed',
                value: '5 kW',
                evidence: quote,
                sourceUrl: 'https://manufacturer.example/manuals/FIRMAN-RD3910E',
                sourceTitle: 'FIRMAN RD3910E official manual'
              }]
            }
          }),
          response: {
            output: [{
              type: 'web_search_call',
              status: 'completed',
              action: {
                query,
                sources: [{
                  url: 'https://manufacturer.example/manuals/FIRMAN-RD3910E',
                  title: 'FIRMAN RD3910E official manual'
                }]
              }
            }]
          }
        };
      }
      throw new Error(`Unexpected stage ${call.stage}`);
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какая мощность у FIRMAN RD3910E?',
      products: [],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['rated power'],
      missingFactSlots: [{ productName: 'FIRMAN RD3910E', attribute: 'rated power' }],
      catalogSearchAttempted: true,
      catalogProductsFound: false,
      onTrace: (event) => { traces.push(event); }
    });

    expect(pageStarted).toBe(true);
    expect(pageAborted).toBe(true);
    expect(actual.facts).toContainEqual(expect.objectContaining({ sourceTier: 'official_manual' }));
    expect(researchCalls().map((call) => call.stage)).toEqual([
      'product_comparison_research_official_page',
      'product_comparison_research_official_manual'
    ]);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ tiers: ['official_manual'], outcome: 'completed' }),
      expect.objectContaining({ tiers: ['official_page'], outcome: 'aborted' })
    ]));
  });

  it('uses reliable secondary only after both official tiers leave typed slots unresolved', async () => {
    const stageTiers = new Map([
      ['product_comparison_research_official_page', 'official_page'],
      ['product_comparison_research_official_manual', 'official_manual'],
      ['product_comparison_research_reliable_secondary', 'reliable_secondary']
    ]);
    createStructuredJsonResponse.mockImplementation(async (call) => {
      const tier = stageTiers.get(call.stage);
      if (!tier) throw new Error(`Unexpected stage ${call.stage}`);
      const query = `ACME X1 ${tier} rated power`;
      return {
        parsed: result({
          usedWebSearch: true,
          sourceAttempts: [{ tier, query, outcome: 'not_found' }],
          answerGuidance: {
            directAnswer: '',
            completeness: 'not_answered',
            coverage: [{
              attribute: 'rated power',
              status: 'not_found',
              value: '',
              evidence: 'not confirmed',
              sourceUrl: null,
              sourceTitle: null
            }]
          }
        }),
        response: {
          output: [{
            type: 'web_search_call',
            status: 'completed',
            action: { query, sources: [] }
          }]
        }
      };
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какая мощность у ACME X1?',
      products: [],
      targetProductNames: ['ACME X1'],
      comparisonAttributes: ['rated power'],
      missingFactSlots: [{ productName: 'ACME X1', attribute: 'rated power' }],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(researchCalls().map((call) => call.stage)).toEqual([
      'product_comparison_research_official_page',
      'product_comparison_research_official_manual',
      'product_comparison_research_reliable_secondary'
    ]);
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual([
      'catalog',
      'official_page',
      'official_manual',
      'reliable_secondary'
    ]);
    expect(actual.sourcesExhausted).toBe(true);
  });

  it('does not let secondary evidence returned by an official-page attempt short-circuit the manual tier', async () => {
    const secondaryQuote = 'FIRMAN RD3910E rated power is 4 kW.';
    const manualQuote = 'FIRMAN RD3910E rated power is 5 kW.';
    fetchMock.mockImplementation(async () => sourceResponse(`${secondaryQuote} ${manualQuote}`));
    const stagedResponse = (input: {
      tier: 'official_page' | 'official_manual';
      query: string;
      quote: string;
      value: string;
      url: string;
      title: string;
    }) => ({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: [{ tier: input.tier, query: input.query, outcome: 'confirmed' }],
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'rated power',
          value: input.value,
          sourceType: 'web',
          confidence: 'high',
          evidence: input.quote,
          sourceUrl: input.url,
          sourceTitle: input.title
        }],
        conflicts: input.tier === 'official_page' ? [{
          productName: 'FIRMAN RD3910E',
          attribute: 'rated power',
          catalogValue: undefined,
          webValues: ['4 kW', '6 kW'],
          resolution: 'unresolved secondary-source conflict'
        }] : [],
        answerGuidance: {
          directAnswer: `Мощность ${input.value}.`,
          completeness: 'answered',
          coverage: [{
            attribute: 'rated power',
            status: 'confirmed',
            value: input.value,
            evidence: input.quote,
            sourceUrl: input.url,
            sourceTitle: input.title
          }]
        }
      }),
      response: {
        output: [{
          type: 'web_search_call',
          status: 'completed',
          action: { query: input.query, sources: [{ url: input.url, title: input.title }] }
        }]
      }
    });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponse(call);
      }
      if (call.stage === 'product_comparison_research_official_page') {
        return stagedResponse({
          tier: 'official_page',
          query: 'FIRMAN RD3910E official rated power',
          quote: secondaryQuote,
          value: '4 kW',
          url: 'https://equipment-shop.example/firman-rd3910e',
          title: 'FIRMAN RD3910E reseller listing'
        });
      }
      if (call.stage === 'product_comparison_research_official_manual') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return stagedResponse({
          tier: 'official_manual',
          query: 'FIRMAN RD3910E official manual rated power',
          quote: manualQuote,
          value: '5 kW',
          url: 'https://manufacturer.example/manuals/FIRMAN-RD3910E',
          title: 'FIRMAN RD3910E official manual'
        });
      }
      throw new Error(`Unexpected stage ${call.stage}`);
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какая мощность у FIRMAN RD3910E?',
      products: [],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['rated power'],
      missingFactSlots: [{ productName: 'FIRMAN RD3910E', attribute: 'rated power' }],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.facts).toEqual([expect.objectContaining({
      value: '5 kW',
      sourceTier: 'official_manual',
      sourceAuthority: 'manufacturer'
    })]);
    expect(researchCalls().map((call) => call.stage)).toEqual([
      'product_comparison_research_official_page',
      'product_comparison_research_official_manual'
    ]);
    expect(actual.warnings).toContain('source_tier_conflict_rejected:official_page');
    expect(actual.conflicts).toEqual([]);
    expect(actual.sourceAttempts).not.toContainEqual(expect.objectContaining({
      tier: 'official_page',
      outcome: 'confirmed'
    }));
  });

  it('rejects a fact labeled as one requested model when its source only names another requested model', async () => {
    const quote = 'TSS SGG 6000 EH rated power is 6 kW.';
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote}</body></html>`));
    const wrongTarget = result({
      usedWebSearch: true,
      facts: [{
        productName: 'TSS SGG 5000 EH',
        attribute: 'rated power',
        value: '6 kW',
        sourceType: 'web',
        confidence: 'high',
        evidence: quote,
        sourceUrl: 'https://equipment.example/TSS-SGG-6000-EH',
        sourceTitle: 'TSS SGG 6000 EH specification'
      }],
      answerGuidance: {
        directAnswer: 'У TSS SGG 5000 EH мощность 6 кВт.',
        completeness: 'answered',
        coverage: [{
          attribute: 'rated power',
          status: 'confirmed',
          value: '6 kW',
          evidence: quote,
          sourceUrl: 'https://equipment.example/TSS-SGG-6000-EH',
          sourceTitle: 'TSS SGG 6000 EH specification'
        }]
      }
    });
    queueResearchResponse({ parsed: wrongTarget });
    queueResearchResponse({ parsed: wrongTarget });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Сравните мощность двух моделей.',
      products: [],
      targetProductNames: ['TSS SGG 5000 EH', 'TSS SGG 6000 EH'],
      comparisonAttributes: ['rated power']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.warnings).toContain('source_evidence_exact_target_not_found');
  });

  it('turns unknown targeted coverage ownership into conservative exact-target gaps', async () => {
    const quote = 'MODEL A rated power is 6 kW.';
    fetchMock.mockResolvedValue(sourceResponse(`<html><body>${quote}</body></html>`));
    const malformedCoverage = result({
      usedWebSearch: true,
      facts: [{
        productName: 'MODEL A',
        attribute: 'rated power',
        value: '6 kW',
        sourceType: 'web',
        confidence: 'medium',
        evidence: quote,
        sourceUrl: 'https://equipment.example/model-a',
        sourceTitle: 'MODEL A specification'
      }],
      answerGuidance: {
        directAnswer: 'MODEL A has 6 kW rated power.',
        completeness: 'partially_answered',
        coverage: [{
          productName: 'UNKNOWN MODEL',
          attribute: 'rated power',
          status: 'not_confirmed',
          value: '',
          evidence: 'ownership is malformed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: malformedCoverage });
    queueResearchResponse({ parsed: malformedCoverage });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Compare rated power for MODEL A and MODEL B.',
      products: [],
      targetProductNames: ['MODEL A', 'MODEL B'],
      comparisonAttributes: ['rated power']
    });

    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'MODEL A', attribute: 'rated power', status: 'confirmed' }),
      expect.objectContaining({ productName: 'MODEL B', attribute: 'rated power', status: 'not_confirmed' })
    ]));
    expect(actual.answerGuidance.coverage).not.toContainEqual(expect.objectContaining({
      productName: 'UNKNOWN MODEL'
    }));
    expect(actual.warnings).toContain('source_coverage_target_mismatch');
    expect(actual.sourcesExhausted).toBe(false);
  });

  it('does not short-circuit mandatory staged web when exact catalog facts cover every typed slot', async () => {
    queueResearchResponse({
      parsed: result({
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          value: 'key start',
          sourceType: 'catalog',
          confidence: 'high',
          evidence: 'catalog.description: FIRMAN RD3910E starts with an ignition key',
          sourceUrl: product().sourceUrl,
          sourceTitle: product().name
        }],
        answerGuidance: {
          directAnswer: 'FIRMAN RD3910E запускается ключом.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start control',
            status: 'confirmed',
            value: 'key start',
            evidence: 'catalog.description: FIRMAN RD3910E starts with an ignition key',
            sourceUrl: product().sourceUrl,
            sourceTitle: product().name
          }]
        }
      })
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      queueResearchResponse({ parsed: result({ usedWebSearch: true }) });
    }
    const actual = await researchProductComparisonFacts({
      userMessage: 'Как запускается FIRMAN RD3910E?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start control'],
      missingFactSlots: [{ productName: 'FIRMAN RD3910E', attribute: 'start control' }],
      catalogSearchAttempted: true,
      catalogProductsFound: true
    });

    expect(researchCalls().map((call) => call.stage)).toEqual([
      'catalog_product_fact_extraction', 'product_comparison_research_official_page',
      'product_comparison_research_official_manual', 'product_comparison_research_reliable_secondary'
    ]);
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.searchDisposition).toBe('completed');
    expect(actual.warnings).not.toContain('web_research_not_needed:catalog_extraction_answered');
  });

  it.each(['supported', 'unread_source', 'reader_timeout'] as const)('reads a discovered manual with source validation: %s', async (mode) => {
    const manualUrl = 'https://www.firman.biz/manuals/RD3910E.pdf';
    const quote = 'FIRMAN RD3910E: first oil change after 20 hours.';
    fetchMock.mockImplementation(async () => sourceResponse('%PDF-mocked', 'application/pdf'));
    extractPdfTextMock.mockResolvedValue({ text: quote, totalPages: 1, parsedPages: 1, truncated: false });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') return semanticValidationResponse(call);
      if (call.stage === 'product_research_document_read') {
        const payload = JSON.parse(call.request.input.find((item: { role: string }) => item.role === 'user').content);
        expect(payload.documents).toEqual([expect.objectContaining({ sourceUrl: manualUrl, text: quote })]);
        expect(call.request.tools).toBeUndefined();
        if (mode === 'reader_timeout') throw Object.assign(new Error('deadline'), { code: 'structured_json_deadline_exceeded' });
        return { parsed: result({ facts: [{ productName: 'FIRMAN RD3910E', attribute: 'first_oil_change', value: '20 hours',
          sourceType: 'web', confidence: 'high', evidence: quote, sourceUrl: mode === 'unread_source' ? 'https://www.firman.biz/unread.pdf' : manualUrl,
          sourceTitle: 'FIRMAN RD3910E manual' }] }) };
      }
      const manual = call.stage === 'product_comparison_research_official_manual';
      const tier = manual ? 'official_manual' : 'official_page';
      const query = `FIRMAN RD3910E ${tier}`;
      return { parsed: result({ sourceAttempts: [{ tier, query, outcome: manual ? 'unreadable' : 'not_found' }] }),
        response: { output: [{ type: 'web_search_call', status: 'completed', action: {
          query, sources: manual ? [{ url: manualUrl, title: 'FIRMAN RD3910E manual' }] : []
        } }] } };
    });
    const actual = await researchProductComparisonFacts({ userMessage: 'Когда первая замена масла?', products: [product()],
      targetProductNames: ['FIRMAN RD3910E'], comparisonAttributes: ['first_oil_change'],
      missingFactSlots: [{ productName: 'FIRMAN RD3910E', attribute: 'first_oil_change' }],
      precomputedCatalogResult: null, catalogSearchAttempted: true, catalogProductsFound: true });
    if (mode === 'supported') {
      expect(actual.facts).toContainEqual(expect.objectContaining({ attribute: 'first_oil_change', value: '20 hours',
        sourceTier: 'official_manual', sourceUrl: manualUrl }));
    } else {
      expect(actual.facts).toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createStructuredJsonResponse.mock.calls.some(([call]) => call.stage === 'product_research_document_read')).toBe(true);
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceCandidates).toContainEqual(expect.objectContaining({ url: manualUrl }));
    // Exercise the real producer/consumer boundary, not just the research leaf.
    expect(validateToolResultOutput({ requestId: 'manual', tool: 'web.researchProductFacts',
      status: 'ok', payload: actual as unknown as Record<string, unknown>, warnings: actual.warnings }).payload).toMatchObject({
      sourceCandidates: expect.arrayContaining([expect.objectContaining({ url: manualUrl })])
    });
    if (mode === 'reader_timeout') expect(actual.warnings).toContain('document_read_timed_out');
  });

  beforeEach(() => {
    queuedResearchResponses.length = 0;
    createStructuredJsonResponse.mockReset();
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponse(call);
      }
      const next = queuedResearchResponses.shift();
      if (!next) throw new Error(`No queued structured response for stage ${call.stage}`);
       return {
          ...next,
          response: next.response ?? {
            output: next.parsed.usedWebSearch === true ? [{ type: 'web_search_call', status: 'completed' }] : []
          }
       };
    });
    createStructuredJsonResponse.mockResolvedValueOnce = ((value: { parsed: Record<string, unknown> }) => {
      queueResearchResponse(value);
      return createStructuredJsonResponse;
    }) as typeof createStructuredJsonResponse.mockResolvedValueOnce;
    fetchMock.mockReset();
    extractPdfTextMock.mockReset();
    extractPdfTextMock.mockRejectedValue(new Error('invalid test PDF'));
  });

  it('runs web research for a general technical question without catalog products or an exact model', async () => {
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'generator THD recommendation for sensitive electronics',
            status: 'not_found',
            value: '',
            evidence: 'no sufficiently specific source found',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      })
    });
    const sourceTierQueries = {
      official_page: 'generator THD official manufacturer guidance',
      official_manual: 'generator THD official manual PDF',
      reliable_secondary: 'generator THD reliable technical distributor guidance'
    };
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          tier,
          query,
          outcome: 'not_found'
        })),
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'generator THD recommendation for sensitive electronics',
            status: 'not_found',
            value: '',
            evidence: 'the requested fact was not confirmed after all source tiers',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      }),
      response: {
        output: Object.values(sourceTierQueries).map((query) => ({
          type: 'web_search_call',
          status: 'completed',
          action: { query, sources: [] }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой THD допустим для питания чувствительной электроники от генератора?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['generator THD recommendation for sensitive electronics'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(researchCalls()).toHaveLength(2);
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.searchDisposition).toBe('completed');
    expect(actual.sourcesExhausted).toBe(true);
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual([
      'catalog',
      'official_page',
      'official_manual',
      'reliable_secondary'
    ]);
    expect(actual.warnings).not.toContain('not_enough_products_for_comparison');
  });

  it('keeps source tiers untrusted when a completed search omits requested source provenance', async () => {
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'generator THD recommendation for sensitive electronics',
            status: 'not_found',
            value: '',
            evidence: 'no sufficiently specific source found',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      })
    });
    const sourceTierQueries = {
      official_page: 'generator THD official manufacturer guidance',
      official_manual: 'generator THD official manual PDF',
      reliable_secondary: 'generator THD reliable technical distributor guidance'
    };
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          tier,
          query,
          outcome: 'not_found'
        })),
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'generator THD recommendation for sensitive electronics',
            status: 'not_found',
            value: '',
            evidence: 'the requested fact was not confirmed after all source tiers',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      }),
      response: {
        output: Object.values(sourceTierQueries).map((query) => ({
          type: 'web_search_call',
          status: 'completed',
          action: { query }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой THD допустим для питания чувствительной электроники от генератора?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['generator THD recommendation for sensitive electronics'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual(['catalog']);
    expect(actual.warnings).toContain('source_tier_attempts_incomplete_after_retry');
  });

  it('does not accept self-reported official tiers when completed searches only returned marketplace sources', async () => {
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'service interval',
            status: 'not_found',
            value: '',
            evidence: 'not confirmed',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      })
    });
    const sourceTierQueries = {
      official_page: 'FIRMAN RD3910E official service interval',
      official_manual: 'FIRMAN RD3910E official manual service interval PDF',
      reliable_secondary: 'FIRMAN RD3910E reliable service interval'
    };
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          tier,
          query,
          outcome: 'not_found'
        })),
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'service interval',
            status: 'not_found',
            value: '',
            evidence: 'not confirmed',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      }),
      response: {
        output: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          type: 'web_search_call',
          status: 'completed',
          action: {
            query,
            sources: [{
              type: 'url',
              url: `https://marketplace.example/${tier}/firman-rd3910e`,
              title: 'Marketplace listing'
            }]
          }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Как проверять межсервисный интервал генератора?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).not.toContain('official_page');
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).not.toContain('official_manual');
  });

  it('keeps sources unexhausted when decisive HTML evidence is beyond the safe text limit', async () => {
    const decisiveEvidence = 'GENERATOR TEST 1000 service interval is 100 hours';
    fetchMock.mockResolvedValueOnce(sourceResponse(
      `<html><body>${'padding '.repeat(32_000)}${decisiveEvidence}</body></html>`
    ));
    const unresolved = result({
      usedWebSearch: true,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'service interval',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: unresolved });
    const sourceTierQueries = {
      official_page: 'GENERATOR TEST 1000 official service interval',
      official_manual: 'GENERATOR TEST 1000 official manual service interval PDF',
      reliable_secondary: 'GENERATOR TEST 1000 reliable service interval'
    };
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          tier,
          query,
          outcome: 'not_found'
        })),
        facts: [{
          productName: 'GENERATOR TEST 1000',
          attribute: 'service interval',
          value: '100 hours',
          sourceType: 'web',
          confidence: 'high',
          evidence: decisiveEvidence,
          sourceUrl: 'https://example.test/generator-test-1000-service',
          sourceTitle: 'GENERATOR TEST 1000 service information'
        }],
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: []
        }
      }),
      response: {
        output: Object.values(sourceTierQueries).map((query) => ({
          type: 'web_search_call',
          status: 'completed',
          action: { query }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval for GENERATOR TEST 1000?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(actual.facts).toEqual([]);
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_evidence_text_truncated_to_safe_limit');
  });

  it('keeps sources unexhausted when semantic review sees only a capped prefix', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse(
      `<html><body>${'padding '.repeat(2_500)}GENERATOR TEST 2000 maintenance must be completed every 100 hours</body></html>`
    ));
    const unresolved = result({
      usedWebSearch: true,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'service interval',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: unresolved });
    const sourceTierQueries = {
      official_page: 'GENERATOR TEST 2000 official service interval',
      official_manual: 'GENERATOR TEST 2000 official manual service interval PDF',
      reliable_secondary: 'GENERATOR TEST 2000 reliable service interval'
    };
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        sourceAttempts: Object.entries(sourceTierQueries).map(([tier, query]) => ({
          tier,
          query,
          outcome: 'not_found'
        })),
        facts: [{
          productName: 'GENERATOR TEST 2000',
          attribute: 'service interval',
          value: '100 hours',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'GENERATOR TEST 2000 service interval is 100 hours',
          sourceUrl: 'https://example.test/generator-test-2000-service',
          sourceTitle: 'GENERATOR TEST 2000 service information'
        }],
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: []
        }
      }),
      response: {
        output: Object.values(sourceTierQueries).map((query) => ({
          type: 'web_search_call',
          status: 'completed',
          action: { query }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval for GENERATOR TEST 2000?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(createStructuredJsonResponse.mock.calls.some(([call]) =>
      call.stage === 'source_evidence_semantic_validation'
    )).toBe(true);
    expect(actual.facts).toEqual([]);
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_evidence_semantic_text_truncated_to_safe_limit');
    expect(actual.warnings).not.toContain('source_evidence_text_truncated_to_safe_limit');
  });

  it('does not declare generic sources exhausted when the retry did not execute every source tier', async () => {
    const unresolved = result({
      usedWebSearch: true,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'service interval',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: unresolved });
    queueResearchResponse({
      parsed: result({
        ...unresolved,
        sourceAttempts: [{
          tier: 'official_page',
          query: 'official generator service interval',
          outcome: 'not_found'
        }, {
          tier: 'official_manual',
          query: 'official generator manual service interval PDF',
          outcome: 'not_found'
        }, {
          tier: 'reliable_secondary',
          query: 'reliable generator service interval',
          outcome: 'not_found'
        }]
      }),
      response: {
        output: [{
          type: 'web_search_call',
          status: 'completed',
          action: { query: 'official generator service interval', sources: [] }
        }]
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_tier_attempts_incomplete_after_retry');
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual([
      'catalog',
      'official_page'
    ]);
  });

  it('downgrades a generic confirmed source attempt when validation rejects every claimed fact', async () => {
    const query = 'GENERATOR TEST 2000 service interval';
    const sourceUrl = 'https://equipment.example/generator-test-2000';
    const unsupported = result({
      usedWebSearch: true,
      sourceAttempts: [{ tier: 'reliable_secondary', query, outcome: 'confirmed' }],
      facts: [{
        productName: 'GENERATOR TEST 2000',
        attribute: 'service interval',
        value: '100 hours',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'GENERATOR TEST 2000 service interval is 100 hours',
        sourceUrl,
        sourceTitle: 'GENERATOR TEST 2000 specification'
      }],
      answerGuidance: {
        directAnswer: 'Service interval is 100 hours.',
        completeness: 'answered',
        coverage: [{
          attribute: 'service interval',
          status: 'confirmed',
          value: '100 hours',
          evidence: 'GENERATOR TEST 2000 service interval is 100 hours',
          sourceUrl,
          sourceTitle: 'GENERATOR TEST 2000 specification'
        }]
      }
    });
    const response = {
      output: [{
        type: 'web_search_call',
        status: 'completed',
        action: { query, sources: [{ url: sourceUrl, title: 'GENERATOR TEST 2000 specification' }] }
      }]
    };
    fetchMock.mockResolvedValue(sourceResponse('GENERATOR TEST 2000 product page without a service interval.'));
    queueResearchResponse({ parsed: unsupported, response });
    queueResearchResponse({ parsed: unsupported, response });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.sourceAttempts).toContainEqual(expect.objectContaining({
      tier: 'reliable_secondary',
      outcome: 'unreadable'
    }));
    expect(actual.sourceAttempts).not.toContainEqual(expect.objectContaining({ outcome: 'confirmed' }));
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_attempt_confirmation_rejected');
  });

  it('does not count failed web search calls or their reported queries toward exhaustion', async () => {
    const sourceAttempts = [{
      tier: 'official_page',
      query: 'official generator service interval',
      outcome: 'not_found'
    }, {
      tier: 'official_manual',
      query: 'official generator manual service interval PDF',
      outcome: 'not_found'
    }, {
      tier: 'reliable_secondary',
      query: 'reliable generator service interval',
      outcome: 'not_found'
    }];
    const failedResponse = {
      output: sourceAttempts.map((attempt) => ({
        type: 'web_search_call',
        status: 'failed',
        action: { query: attempt.query }
      }))
    };
    const unresolved = result({
      usedWebSearch: true,
      sourceAttempts,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'service interval',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: unresolved, response: failedResponse });
    queueResearchResponse({ parsed: unresolved, response: failedResponse });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.usedWebSearch).toBe(false);
    expect(actual.searchDisposition).toBe('failed');
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceAttempts).toEqual([{ tier: 'catalog', outcome: 'not_found' }]);
  });

  it('does not declare exhaustion without a completed catalog lookup tier', async () => {
    const sourceAttempts = [{
      tier: 'official_page',
      query: 'official generator service interval',
      outcome: 'not_found'
    }, {
      tier: 'official_manual',
      query: 'official generator manual service interval PDF',
      outcome: 'not_found'
    }, {
      tier: 'reliable_secondary',
      query: 'reliable generator service interval',
      outcome: 'not_found'
    }];
    const completedResponse = {
      output: sourceAttempts.map((attempt) => ({
        type: 'web_search_call',
        status: 'completed',
        action: { query: attempt.query, sources: [] }
      }))
    };
    const unresolved = result({
      usedWebSearch: true,
      sourceAttempts,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'service interval',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: unresolved, response: completedResponse });
    queueResearchResponse({ parsed: unresolved, response: completedResponse });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the service interval?',
      products: [],
      targetProductNames: [],
      comparisonAttributes: ['service interval'],
      catalogSearchAttempted: false,
      catalogProductsFound: false
    });

    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual([
      'official_page',
      'official_manual',
      'reliable_secondary'
    ]);
  });

  it('checks exact catalog description with external exact-target research', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('<html><body>FIRMAN RD3910E ignition key electric starter manual starter.</body></html>'));
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
    }).mockResolvedValueOnce({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'key start',
          value: 'ignition key electric starter and manual starter',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'official exact model page says FIRMAN RD3910E has ignition key electric starter and manual starter',
          sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
          sourceTitle: 'FIRMAN RD3910E'
        }],
        answerGuidance: {
          directAnswer: 'RD3910E Р·Р°РїСѓСЃРєР°РµС‚СЃСЏ СЃ РєР»СЋС‡Р° СЌР»РµРєС‚СЂРѕСЃС‚Р°СЂС‚РµСЂР°, РїР»СЋСЃ РµСЃС‚СЊ СЂСѓС‡РЅРѕР№ Р·Р°РїСѓСЃРє. РљРЅРѕРїРѕС‡РЅС‹Р№ Р·Р°РїСѓСЃРє РЅРµ РїРѕРґС‚РІРµСЂР¶РґРµРЅ.',
          completeness: 'answered',
          coverage: [{
            attribute: 'key start',
            status: 'confirmed',
            value: 'ignition key electric starter',
            evidence: 'official exact model page says FIRMAN RD3910E has ignition key electric starter',
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }]
        },
        summaryForAnswer: 'Catalog description and external exact-target source both confirm key electric start.'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или с кнопки?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['key start', 'push-button start']
    });

    expect(actual.usedWebSearch).toBe(true);
    expect(actual.answerGuidance.directAnswer).toContain('ключ');
    expect(actual.answerGuidance.directAnswer).toContain('электростартер');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_extraction_used',
      'exact_catalog_description_extracted',
      'exact_catalog_description_requires_external_adjudication',
      'catalog_fact_extraction_needed_web_research'
    ]));
    expect(researchCalls()).toHaveLength(2);
    const catalogCall = researchCalls()[0];
    expect(catalogCall.stage).toBe('catalog_product_fact_extraction');
    expect(catalogCall.request.tools).toBeUndefined();
    expect(catalogCall.request.reasoning).toEqual({ effort: 'low' });
    expect(catalogCall.request.max_output_tokens).toBeGreaterThanOrEqual(1800);
    const webCall = researchCalls()[1];
    expect(webCall.stage).toBe('product_comparison_research');
    expect(webCall.request.reasoning).toEqual({ effort: 'low' });
    expect(webCall.request.max_output_tokens).toBeGreaterThanOrEqual(1800);
    expect(webCall.request.tools).toEqual([{
      type: 'web_search',
      search_context_size: 'low',
      return_token_budget: 'default'
    }]);
    expect(webCall.request.tool_choice).toEqual({ type: 'web_search' });
    expect(webCall.request.include).toEqual(['web_search_call.action.sources']);
    expect(JSON.stringify(webCall.request.input)).toContain('catalogExtraction');
    expect(webCall.request.input[0].content).toContain('still run exact-target external research');
    expect(JSON.stringify(catalogCall.request.input)).toContain('поворотом ключа электростартера');
  });

  it('returns a complete exact catalog extraction without starting web when catalog-only is allowed under a deadline', async () => {
    queueResearchResponse({
      parsed: compactCatalogResult({
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          value: 'запуск поворотом ключа электростартера; также есть ручной стартер',
          evidence: 'запуск двигателя осуществляется поворотом ключа электростартера'
        }],
        directAnswer: 'RD3910E запускается с ключа электростартера, плюс есть ручной запуск.',
        completeness: 'answered'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или с кнопки?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start control'],
      allowCatalogOnlyAnswer: true,
      deadlineAtMs: Date.now() + 60_000
    });

    expect(researchCalls().map((call) => call.stage)).toEqual(['catalog_product_fact_extraction_compact']);
    const catalogCall = researchCalls()[0];
    expect(catalogCall.request.tools).toBeUndefined();
    expect(catalogCall.request.text.verbosity).toBe('low');
    expect(catalogCall.request.max_output_tokens).toBeLessThanOrEqual(1500);
    expect(catalogCall.request.text.format.schema.properties).toHaveProperty('missing');
    expect(catalogCall.request.text.format.schema.properties).not.toHaveProperty('answerGuidance');
    expect(catalogCall.request.text.format.schema.properties).not.toHaveProperty('sourceAttempts');
    expect(actual.usedWebSearch).toBe(false);
    expect(actual.searchDisposition).toBe('not_needed');
    expect(actual.answerGuidance.completeness).toBe('answered');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_extraction_used',
      'exact_catalog_description_extracted',
      'web_research_not_needed:catalog_extraction_answered'
    ]));
  });

  it('continues to web when conditional catalog extraction remains incomplete', async () => {
    const exactQuote = 'FIRMAN RD3910E starting system: ignition key electric starter.';
    fetchMock.mockResolvedValueOnce(sourceResponse(`<html><body>${exactQuote}</body></html>`));
    queueResearchResponse({
      parsed: compactCatalogResult({
        missing: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start_control_mechanism',
          reason: 'Карточка указывает электростартер, но не описывает орган управления.'
        }],
        directAnswer: 'В карточке подтверждён электростартер, но не ключ или кнопка.',
        completeness: 'partially_answered'
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start_control_mechanism',
          value: 'ignition key electric starter',
          sourceType: 'web',
          confidence: 'high',
          evidence: exactQuote,
          sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
          sourceTitle: 'FIRMAN RD3910E'
        }],
        answerGuidance: {
          directAnswer: 'RD3910E запускается ключом электростартера.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'ignition key electric starter',
            evidence: exactQuote,
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }]
        }
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или с кнопки?',
      products: [product({ description: 'В карточке указан только электростартер.' })],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start_control_mechanism'],
      allowCatalogOnlyAnswer: true,
      deadlineAtMs: Date.now() + 60_000
    });

    expect(researchCalls().map((call) => call.stage)).toEqual([
      'catalog_product_fact_extraction_compact',
      'product_comparison_research'
    ]);
    expect(researchCalls()[0].request.tools).toBeUndefined();
    expect(researchCalls()[1].request.tool_choice).toEqual({ type: 'web_search' });
    expect(JSON.stringify(researchCalls()[1].request.input)).toContain('catalogExtraction');
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.answerGuidance.completeness).toBe('answered');
  });

  it('replaces a catalog gap with accepted non-start web fact coverage', async () => {
    const exactQuote = 'FIRMAN RD3910E rated power is 5 kW.';
    const retryQuote = 'FIRMAN RD3910E output voltage is 230 V.';
    fetchMock.mockResolvedValue(sourceResponse(`${exactQuote} ${retryQuote}`));
    queueResearchResponse({
      parsed: compactCatalogResult({
        missing: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'rated_power',
          reason: 'Номинальная мощность в карточке не указана.'
        }, {
          productName: 'FIRMAN RD3910E',
          attribute: 'output_voltage',
          reason: 'Выходное напряжение в карточке не указано.'
        }],
        directAnswer: '',
        completeness: 'not_answered'
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'rated_power',
          value: '5 kW',
          sourceType: 'web',
          confidence: 'high',
          evidence: exactQuote,
          sourceUrl: 'https://manufacturer.example/product/firman-rd3910e',
          sourceTitle: 'FIRMAN RD3910E specifications'
        }],
        answerGuidance: {
          directAnswer: 'Номинальная мощность составляет 5 кВт.',
          completeness: 'answered',
          coverage: [{
            productName: 'FIRMAN RD3910E',
            attribute: 'output_voltage',
            status: 'not_confirmed',
            value: '',
            evidence: 'The primary pass did not confirm output voltage.',
            sourceUrl: null,
            sourceTitle: null
          }]
        }
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'output_voltage',
          value: '230 V',
          sourceType: 'web',
          confidence: 'high',
          evidence: retryQuote,
          sourceUrl: 'https://manufacturer.example/product/firman-rd3910e',
          sourceTitle: 'FIRMAN RD3910E specifications'
        }],
        answerGuidance: {
          directAnswer: 'Выходное напряжение составляет 230 В.',
          completeness: 'answered',
          coverage: []
        }
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какие номинальная мощность и выходное напряжение у FIRMAN RD3910E?',
      products: [product({ specs: {}, description: 'Мощность и напряжение не указаны.' })],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['rated_power', 'output_voltage'],
      allowCatalogOnlyAnswer: true,
      deadlineAtMs: Date.now() + 60_000
    });

    expect(actual.facts).toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'rated_power',
      value: '5 kW',
      sourceType: 'web'
    }));
    expect(actual.facts).toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'output_voltage',
      value: '230 V',
      sourceType: 'web'
    }));
    expect(actual.answerGuidance.coverage).toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'rated_power',
      status: 'confirmed'
    }));
    expect(actual.answerGuidance.coverage).not.toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'rated_power',
      status: 'not_confirmed'
    }));
    expect(actual.answerGuidance.coverage).toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD3910E',
      attribute: 'output_voltage',
      status: 'confirmed'
    }));
  });

  it('keeps a complete generic comparison backed by validated exact catalog facts for every target', async () => {
    const champion = product({
      id: 'champion-pc5332f',
      name: 'Виброплита CHAMPION PC5332F',
      brand: 'CHAMPION',
      category: 'Виброплиты',
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/champion-pc5332f/',
      specs: { mass: '43 кг', transport: 'складная ручка' },
      description: 'Масса 43 кг. Складная ручка упрощает перевозку.'
    });
    const redverg = product({
      id: 'redverg-rd-29140',
      name: 'Виброплита REDVERG RD-29140',
      brand: 'REDVERG',
      category: 'Виброплиты',
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/redverg-rd-29140/',
      specs: { mass: '60 кг', transport: 'транспортировочные колёса' },
      description: 'Масса 60 кг. Есть транспортировочные колёса.'
    });
    queueResearchResponse({
      parsed: compactCatalogResult({
        facts: [
          {
            productName: 'CHAMPION PC5332F',
            attribute: 'mass',
            value: '43 кг',
            evidence: 'Масса 43 кг'
          },
          {
            productName: 'REDVERG RD-29140',
            attribute: 'mass',
            value: '60 кг',
            evidence: 'Масса 60 кг'
          }
        ],
        directAnswer: 'CHAMPION легче на 17 кг, поэтому для погрузки в одиночку он удобнее.',
        completeness: 'answered'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Сравните эти две модели по массе: какую проще грузить одному?',
      products: [champion, redverg],
      targetProductNames: ['CHAMPION PC5332F', 'REDVERG RD-29140'],
      comparisonAttributes: ['масса'],
      allowCatalogOnlyAnswer: true,
      deadlineAtMs: Date.now() + 60_000
    });

    expect(researchCalls().map((call) => call.stage)).toEqual(['catalog_product_fact_extraction_compact']);
    const semanticCalls = createStructuredJsonResponse.mock.calls.filter((call) =>
      call[0].stage === 'source_evidence_semantic_validation'
    );
    expect(semanticCalls).toHaveLength(1);
    const semanticPayload = JSON.parse(
      semanticCalls[0][0].request.input.find((item: { role?: string }) => item.role === 'user').content
    );
    expect(semanticPayload.claims).toHaveLength(4);
    expect(semanticCalls[0][0].request.max_output_tokens).toBeGreaterThanOrEqual(1200);
    expect(actual.answerGuidance.completeness).toBe('answered');
    expect(actual.answerGuidance.directAnswer).toContain('17 кг');
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: expect.stringContaining('CHAMPION PC5332F'), sourceType: 'catalog' }),
      expect.objectContaining({ productName: expect.stringContaining('REDVERG RD-29140'), sourceType: 'catalog' })
    ]));
    expect(actual.usedWebSearch).toBe(false);
  });

  it('does not accept an allegedly complete comparison when one exact target has no validated fact', async () => {
    const champion = product({
      id: 'champion-pc5332f',
      name: 'Виброплита CHAMPION PC5332F',
      brand: 'CHAMPION',
      category: 'Виброплиты',
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/champion-pc5332f/',
      specs: { mass: '43 кг' },
      description: 'Масса 43 кг.'
    });
    const redverg = product({
      id: 'redverg-rd-29140',
      name: 'Виброплита REDVERG RD-29140',
      brand: 'REDVERG',
      category: 'Виброплиты',
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/redverg-rd-29140/',
      specs: {},
      description: 'Описание без массы.'
    });
    queueResearchResponse({
      parsed: compactCatalogResult({
        facts: [{
          productName: 'CHAMPION PC5332F',
          attribute: 'mass',
          value: '43 кг',
          evidence: 'Масса 43 кг'
        }],
        directAnswer: 'CHAMPION весит 43 кг.',
        completeness: 'answered'
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        answerGuidance: { directAnswer: '', completeness: 'not_answered', coverage: [] }
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Сравните массу CHAMPION PC5332F и REDVERG RD-29140.',
      products: [champion, redverg],
      targetProductNames: ['CHAMPION PC5332F', 'REDVERG RD-29140'],
      comparisonAttributes: ['масса'],
      allowCatalogOnlyAnswer: true,
      deadlineAtMs: Date.now() + 5_000
    });

    expect(researchCalls()).toHaveLength(0);
    expect(actual.searchDisposition).toBe('skipped_budget');
    expect(actual.sourcesExhausted).toBe(false);
  });

  it('retains compact exact-catalog evidence before a deadline-bound web pass', async () => {
    const exactQuote = 'FIRMAN RD3910E starting system: ignition key electric starter.';
    fetchMock.mockResolvedValueOnce(sourceResponse(`<html><body>${exactQuote}</body></html>`));
    queueResearchResponse({
      parsed: compactCatalogResult({
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          value: 'запуск поворотом ключа электростартера',
          evidence: 'Запуск двигателя осуществляется поворотом ключа электростартера.'
        }],
        directAnswer: 'RD3910E запускается поворотом ключа электростартера.',
        completeness: 'answered'
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          value: 'ignition key electric starter',
          sourceType: 'web',
          confidence: 'high',
          evidence: exactQuote,
          sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
          sourceTitle: 'FIRMAN RD3910E'
        }],
        answerGuidance: {
          directAnswer: 'RD3910E запускается с ключа через электростартер.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start control',
            status: 'confirmed',
            value: 'ignition key electric starter',
            evidence: exactQuote,
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }]
        }
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или кнопки?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start control'],
      allowCatalogOnlyAnswer: false,
      deadlineAtMs: Date.now() + 60_000
    });

    expect(researchCalls()).toHaveLength(2);
    expect(researchCalls()[0]).toMatchObject({
      stage: 'catalog_product_fact_extraction_compact',
      transportMaxRetries: 0,
      minRetryRemainingMs: 6_000
    });
    expect(researchCalls()[1]).toMatchObject({
      stage: 'product_comparison_research',
      transportMaxRetries: 0,
      minRetryRemainingMs: 6_000
    });
    expect(researchCalls()[1].request.max_output_tokens).toBeGreaterThanOrEqual(2_600);
    expect(researchCalls()[0].request.reasoning).toEqual({ effort: 'low' });
    expect(researchCalls()[1].request.reasoning).toEqual({ effort: 'low' });
    expect(researchCalls()[1].request.tools).toEqual([{
      type: 'web_search',
      search_context_size: 'low',
      return_token_budget: 'default'
    }]);
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'catalog', productName: expect.stringContaining('FIRMAN RD3910E') }),
      expect.objectContaining({ sourceType: 'web', productName: 'FIRMAN RD3910E' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_extraction_used',
      'source_evidence_exact_quote_verified'
    ]));
    expect(actual.warnings).not.toContain('catalog_fact_extraction_skipped_for_web_deadline');
  });

  it('returns a typed partial with catalog facts and exact missing coverage when deadline-bound web times out', async () => {
    const traces: ProductResearchTraceEvent[] = [];
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'catalog_product_fact_extraction_compact') {
        return {
          parsed: compactCatalogResult({
            facts: [{
              productName: 'FIRMAN RD3910E',
              attribute: 'electric starter',
              value: 'электростартер',
              evidence: 'ручной стартер / электростартер'
            }],
            missing: [{
              productName: 'FIRMAN RD3910E',
              attribute: 'start control',
              reason: 'Карточка не уточняет орган управления электростартером.'
            }],
            directAnswer: 'В карточке подтверждён электростартер, но не орган управления.',
            completeness: 'partially_answered'
          }),
          response: { output: [] }
        };
      }
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponse(call);
      }
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или кнопки?',
      products: [product({ description: 'В карточке указан электростартер без органа управления.' })],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start control'],
      allowCatalogOnlyAnswer: false,
      catalogSearchAttempted: true,
      catalogProductsFound: true,
      deadlineAtMs: Date.now() + 45_000,
      onTrace: (event) => { traces.push(event); }
    });

    expect(researchCalls().map((call) => call.stage)).toEqual([
      'catalog_product_fact_extraction_compact',
      'product_comparison_research',
      'product_comparison_research_exact_retry'
    ]);
    const webCalls = researchCalls().filter((call) => call.stage.includes('product_comparison_research'));
    expect(webCalls[1].deadlineAtMs).toBeGreaterThan(webCalls[0].deadlineAtMs);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'primary_web', attemptNumber: 1, outcome: 'timed_out' }),
      expect.objectContaining({ stage: 'tier_fallback', attemptNumber: 2, outcome: 'timed_out' })
    ]));
    expect(actual).toMatchObject({
      usedWebSearch: false,
      searchDisposition: 'timed_out',
      sourcesExhausted: false
    });
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productName: expect.stringContaining('FIRMAN RD3910E'),
        sourceType: 'catalog',
        value: 'электростартер'
      })
    ]));
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attribute: 'start control',
        status: 'not_confirmed',
        sourceTitle: 'FIRMAN RD3910E'
      })
    ]));
    expect(actual.sourceAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ tier: 'catalog', outcome: 'confirmed' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_extraction_used',
      'web_research_timed_out_after_catalog_extraction'
    ]));
  });

  it('does not reopen a catalog-confirmed exact target attribute when web times out', async () => {
    const unresolvedProduct = product({
      id: 'rd4910e',
      name: 'Генератор бензиновый FIRMAN RD4910E 3.2 кВт',
      sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd4910e_3_2_kvt/',
      specs: {},
      description: 'Карточка не уточняет орган управления электростартером.'
    });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'catalog_product_fact_extraction_compact') {
        return {
          parsed: compactCatalogResult({
            facts: [{
              productName: 'FIRMAN RD3910E',
              attribute: 'start control',
              value: 'поворот ключа электростартера',
              evidence: 'Запуск двигателя осуществляется поворотом ключа электростартера.'
            }],
            missing: [{
              productName: 'FIRMAN RD4910E',
              attribute: 'start control',
              reason: 'Карточка не уточняет орган управления электростартером.'
            }],
            directAnswer: 'Для RD3910E подтверждён запуск ключом; по RD4910E орган управления не указан.',
            completeness: 'partially_answered'
          }),
          response: { output: [] }
        };
      }
      if (call.stage === 'source_evidence_semantic_validation') {
        return semanticValidationResponse(call);
      }
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    const targets = ['FIRMAN RD3910E', 'FIRMAN RD4910E'];
    const actual = await researchProductComparisonFacts({
      userMessage: 'Сравните управление запуском FIRMAN RD3910E и FIRMAN RD4910E.',
      products: [product(), unresolvedProduct],
      targetProductNames: targets,
      comparisonAttributes: ['start control'],
      catalogSearchAttempted: true,
      catalogProductsFound: true,
      deadlineAtMs: Date.now() + 45_000
    });

    const catalogCall = researchCalls()[0];
    const compactItemProperties = catalogCall.request.text.format.schema.properties.facts.items.properties;
    expect(compactItemProperties.productName.enum).toEqual(targets);
    expect(compactItemProperties.attribute.enum).toEqual(['start control']);
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productName: expect.stringContaining('FIRMAN RD3910E'),
        attribute: 'start control',
        sourceType: 'catalog'
      })
    ]));
    const unresolvedCoverage = actual.answerGuidance.coverage.filter((item) =>
      item.attribute === 'start control' && item.status === 'not_confirmed'
    );
    expect(unresolvedCoverage).toEqual([
      expect.objectContaining({ sourceTitle: 'FIRMAN RD4910E' })
    ]);
    expect(unresolvedCoverage[0]?.evidence).toContain('FIRMAN RD4910E');
    expect(unresolvedCoverage[0]?.evidence).not.toContain('FIRMAN RD3910E');
  });

  it('preserves exact target and requested attribute gaps when web times out without catalog evidence', async () => {
    createStructuredJsonResponse.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError')
    );

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какова прижимная сила отсутствующей модели?',
      products: [],
      targetProductNames: ['EXACT MODEL 9000', 'EXACT MODEL 8000'],
      comparisonAttributes: ['прижимная сила'],
      catalogSearchAttempted: true,
      catalogProductsFound: false,
      deadlineAtMs: Date.now() + 45_000
    });

    expect(actual).toMatchObject({
      usedWebSearch: false,
      searchDisposition: 'timed_out',
      sourcesExhausted: false,
      facts: []
    });
    expect(actual.answerGuidance.coverage).toEqual([
      expect.objectContaining({
        productName: 'EXACT MODEL 9000',
        attribute: 'прижимная сила',
        status: 'not_confirmed',
        sourceTitle: 'EXACT MODEL 9000'
      }),
      expect.objectContaining({
        productName: 'EXACT MODEL 8000',
        attribute: 'прижимная сила',
        status: 'not_confirmed',
        sourceTitle: 'EXACT MODEL 8000'
      })
    ]);
    expect(actual.answerGuidance.coverage[0]?.evidence).toContain('EXACT MODEL 9000');
    expect(actual.answerGuidance.coverage[1]?.evidence).toContain('EXACT MODEL 8000');
    expect(actual.sourceAttempts).toEqual([
      expect.objectContaining({ tier: 'catalog', outcome: 'not_found' })
    ]);
  });

  it('does not start a deep exact-target retry when less than the reserved retry window remains', async () => {
    queueResearchResponse({
      parsed: compactCatalogResult({
        missing: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start_control_mechanism',
          reason: 'The catalog does not confirm the requested control.'
        }],
        completeness: 'not_answered'
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'start control',
            status: 'not_found',
            value: '',
            evidence: 'No exact-target source found.',
            sourceUrl: null,
            sourceTitle: null
          }]
        },
        warnings: ['exact_target_external_fact_not_found']
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD3910E заводится с ключа или кнопки?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start control'],
      deadlineAtMs: Date.now() + 5_000
    });

    expect(researchCalls()).toHaveLength(0);
    expect(actual.warnings).toContain('web_research_skipped_insufficient_budget');
    expect(actual.sourcesExhausted).toBe(false);
  });

  it('adjudicates catalog conflicts with corroborated exact-target external sources', async () => {
    const manufacturerQuote = 'SUNREKA G7000iS. Starting system: manual starter, electric starter. Start with START push button.';
    const independentQuote = 'SUNREKA G7000iS inverter generator. Manual starter and electric starter, START push button.';
    const secondIndependentQuote = 'SUNREKA G7000iS. Electric start by START push button, manual recoil starter also available.';
    fetchMock
      .mockResolvedValueOnce(sourceResponse(`<html><body>${manufacturerQuote}</body></html>`))
      .mockResolvedValueOnce(sourceResponse(`<html><body>${independentQuote}</body></html>`))
      .mockResolvedValueOnce(sourceResponse(`<html><body>${secondIndependentQuote}</body></html>`));
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: result({
        facts: [{
          productName: 'SUNREKA G7000iS',
          attribute: 'start_control_mechanism',
          value: 'manual starter',
          sourceType: 'catalog',
          confidence: 'high',
          evidence: 'Starter: manual starter.',
          sourceUrl: 'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g7000is_6_0_kvt/',
          sourceTitle: 'SUNREKA G7000iS'
        }],
        answerGuidance: {
          directAnswer: 'G7000iS has manual starter. Electric start is not confirmed.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'manual starter',
            evidence: 'Starter: manual starter.',
            sourceUrl: 'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g7000is_6_0_kvt/',
            sourceTitle: 'SUNREKA G7000iS'
          }]
        },
        summaryForAnswer: 'Catalog extraction says manual starter only.'
      })
    }).mockResolvedValueOnce({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'SUNREKA G7000iS',
          attribute: 'start_control_mechanism',
          value: 'manual starter, electric starter, START push button',
          sourceType: 'web',
          confidence: 'high',
          evidence: manufacturerQuote,
          sourceUrl: 'https://sunreka.group/market/invertornye-generatory/invertornyj-benzinovyj-generator-7-kvt-sunreko-g7000is/',
          sourceTitle: 'SUNREKA G7000iS manufacturer'
        }],
        conflicts: [{
          productName: 'SUNREKA G7000iS',
          attribute: 'start_control_mechanism',
          catalogValue: 'manual starter only',
          webValues: ['manual starter, electric starter, START push button'],
          resolution: 'manufacturer exact-target source conflicts with catalog, needs independent corroboration'
        }],
        answerGuidance: {
          directAnswer: 'G7000iS starts from the START button; manual starter is also available.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'START push button plus manual starter',
            evidence: manufacturerQuote,
            sourceUrl: 'https://sunreka.group/market/invertornye-generatory/invertornyj-benzinovyj-generator-7-kvt-sunreko-g7000is/',
            sourceTitle: 'SUNREKA G7000iS manufacturer'
          }]
        },
        summaryForAnswer: 'Manufacturer conflicts with catalog and confirms button electric start.'
      })
    }).mockResolvedValueOnce({
      parsed: result({
        usedWebSearch: true,
        facts: [
          {
            productName: 'SUNREKA G7000iS',
            attribute: 'start_control_mechanism',
            value: 'manual starter, electric starter, START push button',
            sourceType: 'web',
            confidence: 'medium',
            evidence: independentQuote,
            sourceUrl: 'https://masterts.ru/products/683477/',
            sourceTitle: 'SUNREKA G7000iS listing'
          },
          {
            productName: 'SUNREKA G7000iS',
            attribute: 'start_control_mechanism',
            value: 'electric start by START push button and manual recoil starter',
            sourceType: 'web',
            confidence: 'medium',
            evidence: secondIndependentQuote,
            sourceUrl: 'https://sunreka-tools.ru/product/sunreka-g7000is',
            sourceTitle: 'SUNREKA G7000iS tools listing'
          }
        ],
        conflicts: [{
          productName: 'SUNREKA G7000iS',
          attribute: 'start_control_mechanism',
          catalogValue: 'manual starter only',
          webValues: [
            'manufacturer: manual starter, electric starter, START push button',
            'listing: manual starter, electric starter, START push button',
            'listing: electric start by START push button and manual recoil starter'
          ],
          resolution: 'external exact-target sources corroborate electric/button start, so catalog manual-only value is incomplete'
        }],
        answerGuidance: {
          directAnswer: 'G7000iS запускается нажатием кнопки START, ручной стартер тоже есть.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'START push button plus manual starter',
            evidence: independentQuote,
            sourceUrl: 'https://masterts.ru/products/683477/',
            sourceTitle: 'SUNREKA G7000iS listing'
          }]
        },
        summaryForAnswer: 'External exact-target corroboration resolves the catalog conflict toward START button electric start plus manual starter.',
        warnings: ['source_conflict_adjudicated']
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'G7000iS нужно каждый раз дергать шнуром или он с кнопки заводится?',
      products: [product({
        id: 'sunreka-g7000is',
        name: 'SUNREKA G7000iS inverter generator',
        brand: 'SUNREKA',
        category: 'Inverter generators',
        sourceUrl: 'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g7000is_6_0_kvt/',
        specs: { starter: 'manual starter' },
        description: 'Starter: manual starter. Autostart: no autostart. Battery: not included.'
      })],
      targetProductNames: ['SUNREKA G7000iS'],
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(3);
    expect(researchCalls()[2].stage).toBe('product_comparison_research_exact_retry');
    expect(researchCalls()[2].request.input[0].content).toContain('source adjudication');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.answerGuidance.completeness).toBe('answered');
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attribute: 'start_control_mechanism',
        status: 'confirmed',
        value: expect.stringContaining('START push button')
      })
    ]));
    expect(actual.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'SUNREKA G7000iS', attribute: 'start_control_mechanism' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'missing_fact_deep_search_retry_used',
      'exact_target_external_retry_used',
      'source_conflict_adjudicated'
    ]));
    expect(actual.warnings).not.toContain('missing_fact_deep_search_still_unresolved');
  });

  it('broadens to web only when exact catalog extraction is incomplete', async () => {
    const exactQuote = 'FIRMAN RD3910E ignition key electric starter manual starter.';
    fetchMock.mockResolvedValueOnce(sourceResponse(`<html><body>${exactQuote}</body></html>`));
    queueResearchResponse({
        parsed: result({
          answerGuidance: {
            directAnswer: '',
            completeness: 'not_answered',
            coverage: [{
              attribute: 'start_control_mechanism',
              status: 'not_found',
              value: '',
              evidence: 'catalog.description/specs do not answer',
              sourceUrl: 'https://bakautprof.ru/catalog/benzinovye_generatory/generator_benzinovyy_firman_rd3910e_2_5_kvt/',
              sourceTitle: 'Генератор бензиновый FIRMAN RD3910E 2.5 кВт'
            }]
          },
          warnings: ['catalog_fact_missing_needs_web_research']
        })
      });
    queueResearchResponse({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD3910E',
            attribute: 'start_control_mechanism',
            value: 'ignition key electric start',
            sourceType: 'web',
            confidence: 'medium',
            evidence: exactQuote,
            sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/FIRMAN-RD3910E',
            sourceTitle: 'FIRMAN RD3910E'
          }],
          answerGuidance: {
            directAnswer: 'По найденным источникам RD3910E запускается ключом электростартера; кнопочный запуск не подтвержден.',
            completeness: 'answered',
            coverage: [{
              attribute: 'start_control_mechanism',
              status: 'confirmed',
              value: 'ignition key electric start',
              evidence: exactQuote,
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
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(actual.usedWebSearch).toBe(true);
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'web', attribute: 'start_control_mechanism', value: 'ignition key electric start' })
    ]));
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start_control_mechanism', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.completeness).toBe('answered');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'catalog_fact_missing_needs_web_research',
      'catalog_fact_extraction_used',
      'catalog_fact_extraction_needed_web_research'
    ]));
    expect(researchCalls()).toHaveLength(2);
    const webCall = researchCalls()[1];
    expect(webCall.stage).toBe('product_comparison_research');
    expect(webCall.request.tools).toEqual([{
      type: 'web_search',
      search_context_size: 'low',
      return_token_budget: 'default'
    }]);
    expect(JSON.stringify(webCall.request.input)).toContain('catalogExtraction');
  });

  it('does a dedicated text control search when electric starter is found but key/button control is unresolved', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E manual starter electric starter.'))
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E control panel: ignition key START switch, electric starter, manual starter.'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'start_control_mechanism',
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
                productName: 'FIRMAN RD4910E',
                attribute: 'start_control_mechanism',
                status: 'confirmed',
                value: 'electric starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://www.firman.biz/catalog/benzinovye-generatory-RD/generator-benzinovyy-FIRMAN-RD4910E',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                productName: 'FIRMAN RD4910E',
                attribute: 'start_control_mechanism',
                status: 'not_confirmed',
                value: '',
                evidence: 'first pass found electric starter but not the control',
                sourceUrl: null,
                sourceTitle: null
              },
              {
                productName: 'FIRMAN RD4910E',
                attribute: 'start_control_mechanism',
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
            attribute: 'start_control_mechanism',
            value: 'ignition key / START switch',
            sourceType: 'web',
            confidence: 'high',
            evidence: 'text listing and manual label the ignition key START switch for exact model RD4910E',
            sourceUrl: 'https://example.test/firman-rd4910e-listing',
            sourceTitle: 'FIRMAN RD4910E listing'
          }],
          answerGuidance: {
            directAnswer: 'RD4910E запускается электростартером с ключа. Ручной запуск тоже есть; кнопочный запуск не подтвержден.',
            completeness: 'answered',
            coverage: [
              {
                attribute: 'start_control_mechanism',
                status: 'confirmed',
                value: 'ignition key / START switch',
                evidence: 'text listing and manual label the ignition key START switch for exact model RD4910E',
                sourceUrl: 'https://example.test/firman-rd4910e-listing',
                sourceTitle: 'FIRMAN RD4910E listing'
              },
              {
                attribute: 'start_control_mechanism',
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
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(2);
    expect(researchCalls()[1].stage).toBe('product_comparison_research_exact_retry');
    expect(JSON.stringify(researchCalls()[0].request.input)).toContain('starter control mechanism');
    expect(JSON.stringify(researchCalls()[0].request.input)).not.toContain('заводится от ключа');
    expect(JSON.stringify(researchCalls()[0].request.input)).not.toContain('control panel photo');
    expect(researchCalls()[1].request.input[0].content).toContain('missing-fact slot');
    expect(researchCalls()[1].request.input[0].content).toContain('Do not reduce the task to a fixed phrase list');
    expect(String(researchCalls()[0].request.input[1].content)).not.toContain('FIRMAN RD3910E');
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start_control_mechanism', status: 'confirmed' })
    ]));
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'exact_target_external_retry_used',
      'electric_start_control_retry_used'
    ]));
    expect(actual.warnings).not.toContain('electric_start_control_not_confirmed_after_retry');
  });

  it('rejects invented key-start evidence when the cited source only proves electric starter', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sourceResponse('FIRMAN RD4910E. Starting system: manual starter, electric starter. Kit: spark plug wrench.')
      )
      .mockResolvedValueOnce(sourceResponse('%PDF-1.7', 'application/pdf'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [
            {
              productName: 'FIRMAN RD4910E',
              attribute: 'start_control_mechanism',
              value: 'manual starter / electric starter',
              sourceType: 'web',
              confidence: 'high',
              evidence: 'official exact model page lists manual starter and electric starter',
              sourceUrl: 'https://example.test/firman-rd4910e',
              sourceTitle: 'FIRMAN RD4910E'
            },
            {
              productName: 'FIRMAN RD4910E',
              attribute: 'start_control_mechanism',
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
                attribute: 'start_control_mechanism',
                status: 'confirmed',
                value: 'electric starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                attribute: 'start_control_mechanism',
                status: 'confirmed',
                value: 'manual starter',
                evidence: 'official exact model page',
                sourceUrl: 'https://example.test/firman-rd4910e',
                sourceTitle: 'FIRMAN RD4910E'
              },
              {
                attribute: 'start_control_mechanism',
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
            attribute: 'start_control_mechanism',
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
              attribute: 'start_control_mechanism',
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
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(actual.answerGuidance.coverage.some((item) =>
      item.status === 'confirmed' && normalized([item.value, item.evidence].join(' ')).includes('key')
    )).toBe(false);
    expect(actual.answerGuidance.directAnswer).not.toContain('starts with a key');
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_evidence_validation_failed:key_start',
      'source_evidence_pdf_parse_failed',
      'answer_guidance_invalidated_after_source_validation',
      'electric_start_control_not_confirmed_after_retry'
    ]));
  });

  it('invalidates generic direct answer when its source evidence is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E manual. Fuel type: gasoline.'))
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E specification. Fuel type: gasoline.'));
    const unsupportedResult = (sourceUrl: string) => result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'fuel tank capacity',
        value: '15 liters',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'source allegedly states a 15 liter tank',
        sourceUrl,
        sourceTitle: 'FIRMAN RD4910E specification'
      }],
      answerGuidance: {
        directAnswer: 'У FIRMAN RD4910E топливный бак на 15 литров.',
        completeness: 'answered',
        coverage: [{
          attribute: 'fuel tank capacity',
          status: 'confirmed',
          value: '15 liters',
          evidence: 'source allegedly states a 15 liter tank',
          sourceUrl,
          sourceTitle: 'FIRMAN RD4910E specification'
        }]
      },
      summaryForAnswer: 'The source allegedly confirms a 15 liter tank.'
    });
    queueResearchResponse({ parsed: unsupportedResult('https://example.test/firman-rd4910e-spec') });
    queueResearchResponse({ parsed: unsupportedResult('https://example.test/firman-rd4910e-spec-retry') });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой объем топливного бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(actual.facts).toEqual([]);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'fuel tank capacity', status: 'not_confirmed' })
    ]));
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('not_answered');
    expect(actual.summaryForAnswer).toBe('');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_evidence_validation_failed:semantic',
      'answer_guidance_invalidated_after_source_validation'
    ]));
  });

  it('marks a semantically verified exact-model fact and derives confirmed coverage without literal value matching', async () => {
    const sourceText = 'BISON BS6250IE specifications. DC USB Output: 5V/1A/2.1A.';
    fetchMock.mockResolvedValue(sourceResponse(sourceText));
    const semanticFactResult = result({
      usedWebSearch: true,
      facts: [{
        productName: 'BISON BS6250IE',
        attribute: 'usb_current_a',
        value: '1 А и 2,1 А',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'dc usb output: 5v/1a/2.1a',
        sourceUrl: 'https://bisonpower.net/generator/inverter-generator/BS6250IE.html',
        sourceTitle: 'BISON BS6250IE specifications'
      }],
      answerGuidance: {
        directAnswer: 'USB-выход поддерживает ток 1 А или 2,1 А.',
        completeness: 'answered',
        coverage: []
      }
    });
    queueResearchResponse({ parsed: semanticFactResult });
    queueResearchResponse({ parsed: semanticFactResult });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return {
          parsed: {
            claimSupported: true,
            claimStartKinds: [],
            supportedStartKinds: [],
            publisherAuthority: 'manufacturer',
            publisherEvidence: 'BISON BS6250IE specifications',
            evidence: 'dc usb output: 5v/1a/2.1a',
            targetApplicability: 'exact_model',
            scopeQuote: '',
            warnings: []
          }
        };
      }
      const next = queuedResearchResponses.shift();
      if (!next) throw new Error(`No queued structured response for stage ${call.stage}`);
      return {
        ...next,
        response: { output: [{ type: 'web_search_call', status: 'completed' }] }
      };
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какие токи поддерживает USB у BISON BS6250IE?',
      products: [],
      targetProductNames: ['BISON BS6250IE'],
      comparisonAttributes: ['usb_current_a']
    });

    expect(actual.facts).toContainEqual(expect.objectContaining({
      productName: 'BISON BS6250IE',
      attribute: 'usb_current_a',
      value: '1 А и 2,1 А',
      evidence: 'DC USB Output: 5V/1A/2.1A',
      evidenceVerifiedExact: true
    }));
    expect(actual.answerGuidance.coverage).toContainEqual(expect.objectContaining({
      productName: 'BISON BS6250IE',
      attribute: 'usb_current_a',
      status: 'confirmed',
      value: '1 А и 2,1 А'
    }));
    expect(actual.warnings).toContain('source_evidence_semantic_claim_verified');
  });

  it('rejects a semantically supported claim when no exact source excerpt is available', async () => {
    const sourceText = 'BISON BS6250IE specifications. DC USB output: 5V/1A/2.1A.';
    fetchMock.mockResolvedValue(sourceResponse(sourceText));
    const unsupportedExcerptResult = result({
      usedWebSearch: true,
      facts: [{
        productName: 'BISON BS6250IE',
        attribute: 'usb_current_a',
        value: '1 А и 2,1 А',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'The manufacturer confirms both requested USB current modes.',
        sourceUrl: 'https://bisonpower.net/generator/inverter-generator/BS6250IE.html',
        sourceTitle: 'BISON BS6250IE specifications'
      }],
      answerGuidance: {
        directAnswer: 'USB-выход поддерживает ток 1 А или 2,1 А.',
        completeness: 'answered',
        coverage: []
      }
    });
    queueResearchResponse({ parsed: unsupportedExcerptResult });
    queueResearchResponse({ parsed: unsupportedExcerptResult });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return {
          parsed: {
            claimSupported: true,
            claimStartKinds: [],
            supportedStartKinds: [],
            publisherAuthority: 'manufacturer',
            publisherEvidence: 'BISON BS6250IE specifications',
            evidence: 'Generated summary that is not present in the source.',
            targetApplicability: 'exact_model',
            scopeQuote: '',
            warnings: ['source_evidence_semantic_claim_verified']
          }
        };
      }
      const next = queuedResearchResponses.shift();
      if (!next) throw new Error(`No queued structured response for stage ${call.stage}`);
      return {
        ...next,
        response: { output: [{ type: 'web_search_call', status: 'completed' }] }
      };
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какие токи поддерживает USB у BISON BS6250IE?',
      products: [],
      targetProductNames: ['BISON BS6250IE'],
      comparisonAttributes: ['usb_current_a']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.answerGuidance.coverage).not.toContainEqual(expect.objectContaining({
      attribute: 'usb_current_a',
      status: 'confirmed'
    }));
    expect(actual.warnings).toContain('source_evidence_exact_excerpt_not_found');
    expect(actual.warnings).not.toContain('source_evidence_semantic_claim_verified');
  });

  it('rejects a literal value quote when it supports a different attribute', async () => {
    const sourceText = 'BISON BS6250IE specifications. Maximum power: 5 kW.';
    fetchMock.mockResolvedValue(sourceResponse(sourceText));
    const wrongAttributeResult = result({
      usedWebSearch: true,
      facts: [{
        productName: 'BISON BS6250IE',
        attribute: 'rated_power_kw',
        value: '5 kW',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'BISON BS6250IE specifications. Maximum power: 5 kW.',
        sourceUrl: 'https://manufacturer.example/product/bison-bs6250ie',
        sourceTitle: 'BISON BS6250IE specifications'
      }],
      answerGuidance: {
        directAnswer: 'Номинальная мощность составляет 5 кВт.',
        completeness: 'answered',
        coverage: []
      }
    });
    queueResearchResponse({ parsed: wrongAttributeResult });
    queueResearchResponse({ parsed: wrongAttributeResult });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return {
          parsed: {
            claimSupported: false,
            claimStartKinds: [],
            supportedStartKinds: [],
            publisherAuthority: 'manufacturer',
            publisherEvidence: 'BISON BS6250IE specifications',
            evidence: 'BISON BS6250IE specifications. Maximum power: 5 kW.',
            targetApplicability: 'exact_model',
            scopeQuote: '',
            warnings: []
          }
        };
      }
      const next = queuedResearchResponses.shift();
      if (!next) throw new Error(`No queued structured response for stage ${call.stage}`);
      return {
        ...next,
        response: { output: [{ type: 'web_search_call', status: 'completed' }] }
      };
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какая номинальная мощность у BISON BS6250IE?',
      products: [],
      targetProductNames: ['BISON BS6250IE'],
      comparisonAttributes: ['rated_power_kw']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.warnings).toContain('source_evidence_exact_quote_verified');
    expect(actual.warnings).toContain('source_evidence_validation_failed:semantic');
    expect(actual.warnings).not.toContain('source_evidence_semantic_claim_verified');
  });

  it('preserves contradicted coverage when accepted facts fill the coverage cap', async () => {
    const sourceUrl = 'https://manufacturer.example/product/bison-bs6250ie';
    const facts = Array.from({ length: 12 }, (_, index) => ({
      productName: 'BISON BS6250IE',
      attribute: `specification_${index}`,
      value: `${index + 1} units`,
      sourceType: 'web' as const,
      confidence: 'high' as const,
      evidence: `BISON BS6250IE specification ${index}: ${index + 1} units confirmed by manufacturer.`,
      sourceUrl,
      sourceTitle: 'BISON BS6250IE product specifications'
    }));
    fetchMock.mockResolvedValue(sourceResponse(facts.map((fact) => fact.evidence).join(' ')));
    const cappedResult = result({
      usedWebSearch: true,
      facts,
      answerGuidance: {
        directAnswer: '',
        completeness: 'partially_answered',
        coverage: [{
          productName: 'BISON BS6250IE',
          attribute: 'safety_status',
          status: 'contradicted',
          value: '',
          evidence: 'Official sources disagree on the safety status.',
          sourceUrl: null,
          sourceTitle: null
        }]
      }
    });
    queueResearchResponse({ parsed: cappedResult });
    queueResearchResponse({ parsed: cappedResult });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Проверьте характеристики и спорный статус BISON BS6250IE.',
      products: [],
      targetProductNames: ['BISON BS6250IE'],
      comparisonAttributes: [...facts.map((fact) => fact.attribute), 'safety_status']
    });

    expect(actual.answerGuidance.coverage).toHaveLength(12);
    expect(actual.answerGuidance.coverage).toContainEqual(expect.objectContaining({
      productName: 'BISON BS6250IE',
      attribute: 'safety_status',
      status: 'contradicted'
    }));
  });

  it('preserves every fail-closed slot when malformed coverage expands across four targets', async () => {
    const targetProductNames = ['MODEL A1', 'MODEL B2', 'MODEL C3', 'MODEL D4'];
    const malformedCoverage = Array.from({ length: 12 }, (_, index) => ({
      productName: 'UNKNOWN MODEL',
      attribute: `attribute_${index}`,
      status: 'not_confirmed' as const,
      value: '',
      evidence: 'Coverage owner did not match a requested model.',
      sourceUrl: null,
      sourceTitle: null
    }));
    const malformedResult = result({
      usedWebSearch: true,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: malformedCoverage
      }
    });
    queueResearchResponse({ parsed: malformedResult });
    queueResearchResponse({ parsed: malformedResult });
    queueResearchResponse({ parsed: malformedResult });
    queueResearchResponse({ parsed: malformedResult });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Сравните четыре точные модели по двенадцати параметрам.',
      products: [],
      targetProductNames,
      comparisonAttributes: malformedCoverage.map((item) => item.attribute)
    });

    expect(actual.answerGuidance.coverage).toHaveLength(48);
    for (const productName of targetProductNames) {
      for (const attribute of malformedCoverage.map((item) => item.attribute)) {
        expect(actual.answerGuidance.coverage).toContainEqual(expect.objectContaining({
          productName,
          attribute,
          status: 'not_confirmed'
        }));
      }
    }
    expect(actual.warnings).toContain('source_coverage_target_mismatch');
    expect(actual.sourcesExhausted).toBe(false);
  });

  it('parses PDF-magic evidence in isolation even when the endpoint is mislabeled as text', async () => {
    fetchMock.mockImplementation(async () => sourceResponse('%PDF-1.7', 'text/plain'));
    extractPdfTextMock.mockResolvedValue({
      text: 'FIRMAN RD4910E fuel tank capacity 15 liters PDF allegedly states a 15 liter tank',
      totalPages: 1,
      parsedPages: 1,
      truncated: false
    });
    const supportedPdfResult = (sourceUrl: string) => result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'fuel tank capacity',
        value: '15 liters',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'PDF allegedly states a 15 liter tank',
        sourceUrl,
        sourceTitle: 'FIRMAN RD4910E PDF'
      }],
      answerGuidance: {
        directAnswer: 'У FIRMAN RD4910E топливный бак на 15 литров.',
        completeness: 'answered',
        coverage: [{
          attribute: 'fuel tank capacity',
          status: 'confirmed',
          value: '15 liters',
          evidence: 'PDF allegedly states a 15 liter tank',
          sourceUrl,
          sourceTitle: 'FIRMAN RD4910E PDF'
        }]
      }
    });
    queueResearchResponse({ parsed: supportedPdfResult('https://example.test/firman-rd4910e.pdf') });
    queueResearchResponse({ parsed: supportedPdfResult('https://example.test/firman-rd4910e-download') });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой объем топливного бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(extractPdfTextMock).toHaveBeenCalledTimes(2);
    expect(extractPdfTextMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ maxPages: 80, maxTextChars: 250000 })
    );
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: 'FIRMAN RD4910E', value: '15 liters' })
    ]));
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('partially_answered');
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.summaryForAnswer).toBe('');
    expect(actual.warnings).not.toContain('source_evidence_pdf_unsupported');
    expect(actual.warnings).not.toContain('source_evidence_pdf_parse_failed');
  });

  it('does not bind an exact quote for another model on a multi-model page', async () => {
    const sourceText = 'FIRMAN RD3910E overview; FIRMAN RD4910E fuel tank capacity: 15 liters.';
    fetchMock.mockImplementation(async () => sourceResponse(sourceText));
    const wrongModelQuote = result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'fuel tank capacity',
        value: '15 liters',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'FIRMAN RD3910E overview; FIRMAN RD4910E fuel tank capacity: 15 liters',
        sourceUrl: 'https://example.test/generator-comparison',
        sourceTitle: 'FIRMAN RD3910E and RD4910E comparison'
      }],
      answerGuidance: {
        directAnswer: 'FIRMAN RD3910E has a 15 liter tank.',
        completeness: 'answered',
        coverage: []
      }
    });
    queueResearchResponse({ parsed: wrongModelQuote });
    queueResearchResponse({ parsed: wrongModelQuote });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the fuel tank capacity of FIRMAN RD3910E?',
      products: [],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(createStructuredJsonResponse.mock.calls.some(([call]) =>
      call.stage === 'source_evidence_semantic_validation'
    )).toBe(true);
    expect(actual.facts).toEqual([]);
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.warnings).toContain('source_evidence_validation_failed:semantic');
  });

  it('rejects a neighboring modification even when the LLM labels the fact with the target product name', async () => {
    const neighborSource = 'TSS SGG 5000 EHA rated power: 6.0 kW.';
    fetchMock.mockResolvedValue(sourceResponse(neighborSource));
    const mislabeledNeighborFact = result({
      usedWebSearch: true,
      facts: [{
        productName: 'TSS SGG 5000 EH',
        attribute: 'rated power',
        value: '6.0 kW',
        sourceType: 'web',
        confidence: 'high',
        evidence: neighborSource,
        sourceUrl: 'https://example.test/tss-sgg-5000-eha',
        sourceTitle: 'TSS SGG 5000 EHA specification'
      }],
      answerGuidance: {
        directAnswer: 'TSS SGG 5000 EH has 6.0 kW rated power.',
        completeness: 'answered',
        coverage: [{
          attribute: 'rated power',
          status: 'confirmed',
          value: '6.0 kW',
          evidence: neighborSource,
          sourceUrl: 'https://example.test/tss-sgg-5000-eha',
          sourceTitle: 'TSS SGG 5000 EHA specification'
        }]
      }
    });
    queueResearchResponse({ parsed: mislabeledNeighborFact });
    queueResearchResponse({ parsed: mislabeledNeighborFact });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the rated power of TSS SGG 5000 EH?',
      products: [],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['rated power']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'rated power', status: 'not_confirmed' })
    ]));
    expect(actual.warnings).toContain('source_evidence_exact_target_not_found');
  });

  it('does not verify a web fact without an HTTP(S) source by falling back to the catalog card', async () => {
    const titleOnlyWebFact = result({
      usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start_control_mechanism',
        value: 'поворотом ключа',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'Запуск двигателя осуществляется поворотом ключа электростартера.',
        sourceUrl: null,
        sourceTitle: 'FIRMAN RD3910E'
      }],
      answerGuidance: {
        directAnswer: 'Запускается поворотом ключа.',
        completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
          status: 'confirmed',
          value: 'поворотом ключа',
          evidence: 'Запуск двигателя осуществляется поворотом ключа электростартера.',
          sourceUrl: null,
          sourceTitle: 'FIRMAN RD3910E'
        }]
      }
    });
    queueResearchResponse({
      parsed: compactCatalogResult({
        missing: [{
          productName: 'FIRMAN RD3910E',
          attribute: 'start control',
          reason: 'Catalog evidence is intentionally incomplete in this source-validation case.'
        }],
        completeness: 'not_answered'
      })
    });
    queueResearchResponse({ parsed: titleOnlyWebFact });
    queueResearchResponse({ parsed: titleOnlyWebFact });

    const actual = await researchProductComparisonFacts({
      userMessage: 'FIRMAN RD3910E starts with a key or a button?',
      products: [product()],
      targetProductNames: ['FIRMAN RD3910E'],
      comparisonAttributes: ['start_control_mechanism'],
      deadlineAtMs: Date.now() + 60_000
    });

    expect(actual.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'web' })
    ]));
    expect(actual.facts.every((fact) => fact.sourceType === 'catalog')).toBe(true);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start control', status: 'not_confirmed' })
    ]));
    expect(actual.warnings).toContain('source_evidence_source_url_missing');
  });

  it('rejects non-PDF binary evidence without sending it through the HTML parser', async () => {
    fetchMock.mockImplementation(async () => sourceResponse('binary payload', 'application/octet-stream'));
    const binaryResult = (sourceUrl: string) => result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'fuel tank capacity',
        value: '15 liters',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'binary payload allegedly confirms 15 liters',
        sourceUrl,
        sourceTitle: 'FIRMAN RD4910E binary download'
      }],
      answerGuidance: {
        directAnswer: 'FIRMAN RD4910E has a 15 liter fuel tank.',
        completeness: 'answered',
        coverage: []
      }
    });
    queueResearchResponse({ parsed: binaryResult('https://example.test/download?id=one') });
    queueResearchResponse({ parsed: binaryResult('https://example.test/download?id=two') });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the fuel tank capacity of FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(extractPdfTextMock).not.toHaveBeenCalled();
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_evidence_unsupported_binary');
  });

  it('caps distinct PDF evidence sources per research and keeps exhaustion false', async () => {
    fetchMock.mockImplementation(async () => sourceResponse('%PDF-1.7', 'application/pdf'));
    extractPdfTextMock.mockResolvedValue({
      text: 'FIRMAN RD4910E fuel tank capacity source confirms 15 liters for this model',
      totalPages: 1,
      parsedPages: 1,
      truncated: false
    });
    const facts = Array.from({ length: 5 }, (_item, index) => ({
      productName: 'FIRMAN RD4910E',
      attribute: 'fuel tank capacity',
      value: '15 liters',
      sourceType: 'web',
      confidence: 'high',
      evidence: 'fuel tank capacity source confirms 15 liters',
      sourceUrl: `https://example.test/firman-rd4910e-${index + 1}.pdf`,
      sourceTitle: 'FIRMAN RD4910E PDF'
    }));
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: facts.slice(0, 4),
        answerGuidance: {
          directAnswer: 'FIRMAN RD4910E has a 15 liter fuel tank.',
          completeness: 'answered',
          coverage: []
        }
      })
    });
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: facts.slice(4),
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: []
        }
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'What is the fuel tank capacity of FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(extractPdfTextMock).toHaveBeenCalledTimes(4);
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_evidence_pdf_source_cap_reached');
  });

  it('aborts bounded PDF parsing with the enclosing research signal', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('%PDF-1.7', 'application/pdf'));
    extractPdfTextMock.mockImplementationOnce((_bytes, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (options.signal?.aborted) rejectAbort();
        else options.signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    );
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD4910E',
          attribute: 'fuel tank capacity',
          value: '15 liters',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'official PDF states 15 liters',
          sourceUrl: 'https://example.test/firman-rd4910e.pdf',
          sourceTitle: 'FIRMAN RD4910E manual'
        }],
        answerGuidance: {
          directAnswer: 'У FIRMAN RD4910E бак 15 литров.',
          completeness: 'answered',
          coverage: []
        }
      })
    });
    const controller = new AbortController();
    const research = researchProductComparisonFacts({
      userMessage: 'Какой объем бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity'],
      signal: controller.signal
    });

    await vi.waitFor(() => expect(extractPdfTextMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(research).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('invalidates generic direct answers that contain no validated evidence', async () => {
    const unsupported = result({
      usedWebSearch: true,
      facts: [],
      answerGuidance: {
        directAnswer: 'У FIRMAN RD4910E топливный бак на 15 литров.',
        completeness: 'answered',
        coverage: []
      },
      summaryForAnswer: 'The tank is allegedly 15 liters.'
    });
    queueResearchResponse({ parsed: unsupported });
    queueResearchResponse({ parsed: unsupported });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой объем топливного бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('not_answered');
    expect(actual.summaryForAnswer).toBe('');
    expect(actual.warnings).toContain('answer_guidance_invalidated_without_validated_support');
  });

  it('does not treat low-confidence facts as support for a generic direct answer', async () => {
    const unsupported = result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'fuel tank capacity',
        value: '15 liters',
        sourceType: 'web',
        confidence: 'low',
        evidence: 'Unverified snippet',
        sourceUrl: 'https://example.test/unverified'
      }],
      answerGuidance: {
        directAnswer: 'У FIRMAN RD4910E топливный бак на 15 литров.',
        completeness: 'answered',
        coverage: []
      },
      summaryForAnswer: 'An unverified snippet says 15 liters.'
    });
    queueResearchResponse({ parsed: unsupported });
    queueResearchResponse({ parsed: unsupported });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой объем топливного бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(actual.facts).toEqual([]);
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('not_answered');
    expect(actual.summaryForAnswer).toBe('');
    expect(actual.warnings).toEqual(expect.arrayContaining([
      'source_evidence_low_confidence_rejected',
      'answer_guidance_invalidated_after_source_validation'
    ]));
  });

  it('never treats an unrelated validated fact as evidence for generic direct-answer prose', async () => {
    fetchMock
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E fuel type gasoline. Fuel type: gasoline.'))
      .mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E fuel type gasoline. Fuel type: gasoline.'));
    const unrelated = result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD4910E',
          attribute: 'fuel type',
          value: 'gasoline',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'Fuel type: gasoline',
          sourceUrl: 'https://example.test/firman-rd4910e'
        }],
        answerGuidance: {
          directAnswer: 'У FIRMAN RD4910E топливный бак на 15 литров.',
          completeness: 'answered',
          coverage: []
        },
        summaryForAnswer: 'The tank is allegedly 15 liters.'
    });
    queueResearchResponse({ parsed: unrelated });
    queueResearchResponse({ parsed: unrelated });
    createStructuredJsonResponse.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        return {
          parsed: {
            claimSupported: true,
            claimStartKinds: [],
            supportedStartKinds: [],
            evidence: 'Fuel type: gasoline',
            targetApplicability: 'exact_model',
            scopeQuote: '',
            warnings: []
          }
        };
      }
      const next = queuedResearchResponses.shift();
      if (!next) throw new Error(`No queued structured response for stage ${call.stage}`);
      return next;
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Какой объем топливного бака у FIRMAN RD4910E?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['fuel tank capacity']
    });

    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'fuel type', value: 'gasoline' })
    ]));
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('partially_answered');
    expect(actual.summaryForAnswer).toBe('');
    expect(actual.warnings).toContain('answer_guidance_direct_answer_removed_for_evidence_coupling');
  });

  it('keeps key-start evidence when the cited source text actually supports it', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E. Start procedure: turn the key to START. Electric starter and manual starter are available.'));
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD4910E',
          attribute: 'start_control_mechanism',
          value: 'turn the key to START',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'Start procedure: turn the key to START. Electric starter and manual starter are available.',
          sourceUrl: 'https://manufacturer.example/manuals/firman-rd4910e-manual',
          sourceTitle: 'FIRMAN RD4910E manual'
        }],
        answerGuidance: {
          directAnswer: 'RD4910E starts with a key; manual start is also available.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'turn the key to START',
            evidence: 'Start procedure: turn the key to START. Electric starter and manual starter are available.',
            sourceUrl: 'https://manufacturer.example/manuals/firman-rd4910e-manual',
            sourceTitle: 'FIRMAN RD4910E manual'
          }]
        },
        summaryForAnswer: 'Source-backed key start.'
      })
    });
    queueResearchResponse(queuedResearchResponses[0]);

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does Firman RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(2);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start_control_mechanism', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.completeness).toBe('partially_answered');
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:key_start');
  });

  it('keeps key-start evidence when Russian exact-source text says the model starts from a key', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('Продам FIRMAN RD 4910E. ЗАВОДИТСЯ ОТ КЛЮЧА. Есть электростартер и ручной запуск.'));
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts: [{
          productName: 'FIRMAN RD4910E',
          attribute: 'start_control_mechanism',
          value: 'заводится от ключа',
          sourceType: 'web',
          confidence: 'medium',
          evidence: 'source text says FIRMAN RD 4910E: ЗАВОДИТСЯ ОТ КЛЮЧА',
          sourceUrl: 'https://example.test/firman-rd4910e-listing',
          sourceTitle: 'FIRMAN RD 4910E listing'
        }],
        answerGuidance: {
          directAnswer: 'RD4910E заводится от ключа. Ручной запуск тоже есть.',
          completeness: 'answered',
          coverage: [{
            attribute: 'start_control_mechanism',
            status: 'confirmed',
            value: 'заводится от ключа',
            evidence: 'source text says FIRMAN RD 4910E: ЗАВОДИТСЯ ОТ КЛЮЧА',
            sourceUrl: 'https://example.test/firman-rd4910e-listing',
            sourceTitle: 'FIRMAN RD 4910E listing'
          }]
        },
        summaryForAnswer: 'Text listing confirms key start.'
      })
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Firman RD4910E заводится с ключа или с кнопки?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start_control_mechanism', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.directAnswer).toContain('ключ');
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:key_start');
    expect(JSON.stringify(researchCalls()[0].request.input)).not.toContain('input_image');
  });

  it('treats manual/electric source wording as electric start evidence without inventing the control', async () => {
    fetchMock.mockResolvedValueOnce(sourceResponse('FIRMAN RD4910E. Способ запуска: Ручной/электро.'));
    createStructuredJsonResponse
      .mockResolvedValueOnce({
        parsed: result({
          usedWebSearch: true,
          facts: [{
            productName: 'FIRMAN RD4910E',
            attribute: 'start_control_mechanism',
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
                attribute: 'start_control_mechanism',
                status: 'confirmed',
                value: 'ручной / электрический стартер',
                evidence: 'source says Способ запуска: Ручной/электро',
                sourceUrl: 'https://example.test/firman-rd4910e-manual-electric',
                sourceTitle: 'FIRMAN RD4910E manual'
              },
              {
                attribute: 'start_control_mechanism',
                status: 'not_confirmed',
                value: '',
                evidence: 'source does not identify key actuation',
                sourceUrl: null,
                sourceTitle: null
              },
              {
                attribute: 'start_control_mechanism',
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
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(researchCalls()).toHaveLength(2);
    expect(actual.answerGuidance.directAnswer).toBe('');
    expect(actual.answerGuidance.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'start_control_mechanism', status: 'confirmed' })
    ]));
    expect(actual.answerGuidance.coverage).not.toContainEqual(expect.objectContaining({
      productName: 'FIRMAN RD4910E',
      attribute: 'start_control_mechanism',
      status: 'not_confirmed'
    }));
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:electric_start');
  });

  it('applies warning-based source-exhaustion blockers in the exact-target retry flow', async () => {
    const unresolved = result({
      usedWebSearch: true,
      answerGuidance: {
        directAnswer: '',
        completeness: 'not_answered',
        coverage: [{
          attribute: 'start control',
          status: 'not_found',
          value: '',
          evidence: 'not confirmed',
          sourceUrl: null,
          sourceTitle: null
        }]
      },
      warnings: ['exact_target_external_fact_not_found']
    });
    queueResearchResponse({ parsed: unresolved });
    const attempts = [
      { tier: 'official_page', query: 'FIRMAN RD4910E official page start control', outcome: 'not_found' },
      { tier: 'official_manual', query: 'FIRMAN RD4910E official manual start control', outcome: 'not_found' },
      { tier: 'reliable_secondary', query: 'FIRMAN RD4910E reliable start control', outcome: 'not_found' }
    ];
    queueResearchResponse({
      parsed: result({
        ...unresolved,
        sourceAttempts: attempts,
        warnings: ['exact_target_external_fact_not_found', 'source_coverage_target_mismatch']
      }),
      response: {
        output: attempts.map((attempt) => ({
          type: 'web_search_call',
          status: 'completed',
          action: { query: attempt.query, sources: [] }
        }))
      }
    });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does FIRMAN RD4910E start with a key or a button?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['start control'],
      catalogSearchAttempted: true,
      catalogProductsFound: false
    });

    expect(actual.sourceAttempts?.map((attempt) => attempt.tier)).toEqual([
      'catalog',
      'official_page',
      'official_manual',
      'reliable_secondary'
    ]);
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.warnings).toContain('source_coverage_target_mismatch');
  });

  it('enforces schema/runtime fact, coverage, and distinct source URL caps', async () => {
    fetchMock.mockImplementation(async () => sourceResponse(
      'FIRMAN RD4910E starts with an ignition key and has an electric starter.'
    ));
    const facts = Array.from({ length: 20 }, (_item, index) => ({
      productName: 'FIRMAN RD4910E',
      attribute: `key start evidence ${index}`,
      value: 'ignition key',
      sourceType: 'web',
      confidence: 'high',
      evidence: 'FIRMAN RD4910E starts with an ignition key',
      sourceUrl: `https://example.test/firman-rd4910e/fact-${index}`,
      sourceTitle: 'FIRMAN RD4910E specification'
    }));
    const coverage = Array.from({ length: 20 }, (_item, index) => ({
      attribute: `key start coverage ${index}`,
      status: 'confirmed',
      value: 'ignition key',
      evidence: 'FIRMAN RD4910E starts with an ignition key',
      sourceUrl: `https://example.test/firman-rd4910e/coverage-${index}`,
      sourceTitle: 'FIRMAN RD4910E specification'
    }));
    const oversized = result({
      usedWebSearch: true,
      facts,
      answerGuidance: {
        directAnswer: 'FIRMAN RD4910E starts with an ignition key.',
        completeness: 'answered',
        coverage
      }
    });
    queueResearchResponse({ parsed: oversized });
    queueResearchResponse({ parsed: oversized });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does FIRMAN RD4910E start with a key?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start']
    });

    const schema = researchCalls()[0].request.text.format.schema;
    expect(schema.properties.facts.maxItems).toBe(12);
    expect(schema.properties.answerGuidance.properties.coverage.maxItems).toBe(12);
    expect(actual.facts.length).toBeLessThanOrEqual(12);
    expect(actual.answerGuidance.coverage.length).toBeLessThanOrEqual(12);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(actual.warnings).toContain('source_evidence_source_cap_reached');
    expect(researchWarningsPreventSourceExhaustion(actual.warnings)).toBe(true);
  });

  it('canonicalizes source cache keys while validating every claim independently', async () => {
    fetchMock.mockResolvedValue(sourceResponse(
      'FIRMAN RD4910E starts with an ignition key. Fuel tank capacity is 15 liters.'
    ));
    const canonicalizedSourceResult = result({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'key start',
        value: 'ignition key',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'FIRMAN RD4910E starts with an ignition key',
        sourceUrl: 'https://EXAMPLE.test:443/firman-rd4910e?edition=one#facts',
        sourceTitle: 'FIRMAN RD4910E specification'
      }, {
        productName: 'FIRMAN RD4910E',
        attribute: 'fuel tank capacity',
        value: '20 liters',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'FIRMAN RD4910E fuel tank capacity is 20 liters',
        sourceUrl: 'https://example.test/firman-rd4910e?edition=one#tank',
        sourceTitle: 'FIRMAN RD4910E specification'
      }],
      answerGuidance: {
        directAnswer: 'FIRMAN RD4910E starts with an ignition key.',
        completeness: 'answered',
        coverage: [{
          attribute: 'key start',
          status: 'confirmed',
          value: 'ignition key',
          evidence: 'FIRMAN RD4910E starts with an ignition key',
          sourceUrl: 'https://example.test:443/firman-rd4910e?edition=one#coverage',
          sourceTitle: 'FIRMAN RD4910E specification'
        }]
      }
    });
    queueResearchResponse({ parsed: canonicalizedSourceResult });
    queueResearchResponse({ parsed: canonicalizedSourceResult });

    const actual = await researchProductComparisonFacts({
      userMessage: 'Does FIRMAN RD4910E start with a key?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['key start']
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(actual.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute: 'key start' })
    ]));
    expect(actual.facts.some((fact) => fact.value === '20 liters')).toBe(false);
    expect(actual.warnings).toContain('source_evidence_validation_failed:semantic');
  });

  it('bounds concurrent source evidence validation work', async () => {
    let activeFetches = 0;
    let maxActiveFetches = 0;
    fetchMock.mockImplementation(async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFetches -= 1;
      return sourceResponse('FIRMAN RD4910E starts with an ignition key and has an electric starter.');
    });
    const facts = Array.from({ length: 12 }, (_item, index) => ({
      productName: 'FIRMAN RD4910E',
      attribute: 'start_control_mechanism',
      value: 'ignition key',
      sourceType: 'web',
      confidence: 'high',
      evidence: 'FIRMAN RD4910E starts with an ignition key',
      sourceUrl: `https://example.test/firman-rd4910e/source-${index}`,
      sourceTitle: 'FIRMAN RD4910E specification'
    }));
    queueResearchResponse({
      parsed: result({
        usedWebSearch: true,
        facts,
        answerGuidance: {
          directAnswer: 'FIRMAN RD4910E starts with an ignition key.',
          completeness: 'answered',
          coverage: facts.map((fact) => ({
            attribute: fact.attribute,
            status: 'confirmed',
            value: fact.value,
            evidence: fact.evidence,
            sourceUrl: fact.sourceUrl,
            sourceTitle: fact.sourceTitle
          }))
        }
      })
    });

    await researchProductComparisonFacts({
      userMessage: 'Does FIRMAN RD4910E start with a key?',
      products: [],
      targetProductNames: ['FIRMAN RD4910E'],
      comparisonAttributes: ['start_control_mechanism']
    });

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(maxActiveFetches).toBeLessThanOrEqual(4);
  });
});
