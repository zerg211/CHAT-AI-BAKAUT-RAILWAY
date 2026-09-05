import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../src/shared/types.js';
import type { ProductComparisonResearchResult, ProductResearchTraceEvent } from '../src/ai/productComparisonResearch.js';
import { validateToolResultOutput } from '../src/ai/agentManagerToolRegistry.js';
import { bindDocumentEvidence, createEvidenceDocuments } from '../src/ai/documentEvidence.js';

const structured = vi.hoisted(() => vi.fn());
const fetchSource = vi.hoisted(() => vi.fn());
const parsePdf = vi.hoisted(() => vi.fn());
vi.mock('../src/ai/openaiStructured.js', () => ({ createStructuredJsonResponse: structured }));
vi.mock('../src/security/outboundHttp.js', () => ({
  safeFetchBytes: fetchSource,
  outboundText: (source: { bytes: Uint8Array }) => new TextDecoder().decode(source.bytes)
}));
vi.mock('../src/ai/pdfTextExtraction.js', () => ({
  extractPdfText: parsePdf,
  PdfTextExtractionError: class extends Error { constructor(public code: string) { super(code); } }
}));
const { researchProductComparisonFacts } = await import('../src/ai/productComparisonResearch.js');

const target = 'FIRMAN RD3910E';
const attribute = 'first oil change';
const generalQuote = 'Replace the engine oil after the first 20 hours.';
const scopeQuote = 'This instruction manual applies to FIRMAN RD3910E and FIRMAN RD4910E.';
const publisherQuote = 'FIRMAN is the manufacturer and publisher of this instruction manual.';
const sharedUrl = 'https://www.firman.biz/manuals/generator-family.pdf';
const catalogProduct: Product = {
  id: 'test-rd3910e', name: target, brand: 'FIRMAN', category: 'Бензиновые генераторы',
  price: 10000, currency: 'RUB', sourceUrl: 'https://bakautprof.ru/catalog/rd3910e',
  description: `${target}. ${generalQuote}`, specs: {}
};
function emptyResult(): ProductComparisonResearchResult {
  return { usedWebSearch: false, searchDisposition: 'completed', sourcesExhausted: false,
    sourceAttempts: [], facts: [], conflicts: [], answerGuidance: { directAnswer: '', completeness: 'not_answered', coverage: [] },
    summaryForAnswer: '', warnings: [] };
}
function webResponse(tier: string, fact?: { evidence: string; value?: string; sourceUrl?: string }) {
  const query = `${target} ${tier} ${attribute}`;
  return {
    parsed: { ...emptyResult(), usedWebSearch: true,
      sourceAttempts: [{ tier, outcome: fact ? 'confirmed' : 'not_found', query }],
      facts: fact ? [{ productName: target, attribute, value: fact.value ?? '20 hours',
        sourceType: 'web', confidence: 'high', evidence: fact.evidence, sourceUrl: fact.sourceUrl ?? sharedUrl,
        sourceTitle: 'FIRMAN generator instruction manual' }] : [] },
    response: { output: [{ type: 'web_search_call', status: 'completed', action: {
      query, sources: fact ? [{ url: fact.sourceUrl ?? sharedUrl, title: 'FIRMAN generator instruction manual' }] : []
    } }] }
  };
}
function semanticResponse(call: any, overrides: Record<string, unknown> = {}) {
  const input = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
  return { parsed: { validations: input.claims.map((claim: any) => ({ itemIndex: claim.itemIndex,
    claimSupported: true, claimStartKinds: [], supportedStartKinds: [], publisherAuthority: 'manufacturer', publisherEvidence: publisherQuote,
    targetApplicability: 'shared_instruction', scopeQuote, evidence: generalQuote, warnings: [], ...overrides
  })) } };
}
function documentResponse(call: any, fact: { evidence: string; value?: string; sourceUrl?: string }) {
  const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
  const document = payload.documents.find((item: any) => item.sourceUrl === (fact.sourceUrl ?? sharedUrl));
  const start = document?.passages.map((part: any) => part.text).join('').indexOf(fact.evidence) ?? -1;
  const ids = start < 0 ? [document?.passages[0]?.id ?? 'unknown-document']
    : document.passages.filter((part: any) => part.end > start && part.start < start + fact.evidence.length).map((part: any) => part.id);
  const response = webResponse('official_manual', fact);
  (response.parsed.facts[0] as any).evidenceRef = { passageIds: ids };
  return response;
}
function research(overrides: Partial<Parameters<typeof researchProductComparisonFacts>[0]> = {}) {
  return researchProductComparisonFacts({ userMessage: 'Проверьте по руководству первую замену масла.',
    products: [], targetProductNames: [target], comparisonAttributes: [attribute],
    missingFactSlots: [{ productName: target, attribute }], allowCatalogOnlyAnswer: false,
    catalogSearchAttempted: true, catalogProductsFound: false, ...overrides });
}
function arrangeManual(sourceText = `${scopeQuote} ${generalQuote}`, validation: Record<string, unknown> = {}, quote = generalQuote) {
  parsePdf.mockResolvedValue({ text: `${sourceText} ${publisherQuote}`, totalPages: 32, parsedPages: 32, truncated: false });
  structured.mockImplementation(async (call) => {
    if (call.stage === 'source_evidence_semantic_validation') return semanticResponse(call, validation);
    if (call.stage === 'product_research_document_read') return documentResponse(call, { evidence: quote });
    return webResponse(call.stage.slice('product_comparison_research_'.length),
      call.stage.endsWith('_official_manual') ? { evidence: quote } : undefined);
  });
}

beforeEach(() => {
  structured.mockReset(); fetchSource.mockReset(); parsePdf.mockReset();
  fetchSource.mockImplementation(async (url) => ({ url, status: 200,
    headers: new Headers({ 'content-type': 'application/pdf' }), bytes: new TextEncoder().encode('%PDF-1.7') }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('production web research regressions', () => {
  it.each(['late passage', 'adjacent passages', 'invalid reference', 'unsupported claim', 'wrong model', 'missing reference'] as const)(
    'binds document evidence and reports its validation boundary: %s', async (mode) => {
      const actualQuote = mode === 'wrong model' ? generalQuote.replace('20', '50') : generalQuote;
      const actualScope = mode === 'wrong model' ? 'This instruction manual applies only to FIRMAN RD4910E.' : scopeQuote;
      const prefix = `${actualScope} ${publisherQuote} `;
      const position = mode === 'adjacent passages' ? 25_195 : 25_000;
      const sourceText = prefix + 'x'.repeat(position - prefix.length) + actualQuote + ' Supporting context.'.repeat(2_000);
      parsePdf.mockResolvedValue({ text: sourceText, totalPages: 32, parsedPages: 32, truncated: false });
      const traces: ProductResearchTraceEvent[] = [];
      let validationCalls = 0;
      structured.mockImplementation(async (call) => {
        if (call.stage === 'source_evidence_semantic_validation') {
          validationCalls += 1;
          const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
          if (mode === 'late passage' || mode === 'adjacent passages') {
            expect(payload.sources[0].sourceText).toContain(actualQuote);
            expect(payload.sources[0].sourceText).toContain(scopeQuote);
            expect(payload.sources[0].sourceText.length).toBeLessThanOrEqual(18_000);
          }
          return semanticResponse(call, { claimSupported: mode !== 'unsupported claim',
            evidence: actualQuote,
            scopeQuote: actualScope, targetApplicability: mode === 'wrong model' ? 'other_model' : 'shared_instruction' });
        }
        if (call.stage === 'product_research_document_read') {
          const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
          const document = payload.documents[0];
          expect(document.text).toBeUndefined();
          expect(document.passages.map((part: any) => part.text).join('')).toBe(sourceText.slice(0, 64_000));
          expect(document.passages.reduce((total: number, part: any) => total + part.text.length, 0)).toBeLessThanOrEqual(64_000);
          const refs = document.passages.filter((part: any) => part.end > position && part.start < position + actualQuote.length)
            .map((part: any) => part.id);
          expect(refs).toHaveLength(mode === 'adjacent passages' ? 2 : 1);
          const schema = call.request.text.format.schema.properties.facts.items.properties.evidenceRef;
          expect(schema.properties.passageIds.items.enum).toContain(refs[0]);
          const response = webResponse('official_manual', { evidence: 'The first oil change is required after twenty hours.',
            sourceUrl: 'https://invented.invalid/manual.pdf', value: '20 hours' });
          (response.parsed.facts[0] as any).evidenceRef = {
            passageIds: mode === 'invalid reference' ? ['document-99-passage-0'] : refs
          };
          if (mode === 'missing reference') delete (response.parsed.facts[0] as any).evidenceRef;
          return response;
        }
        const tier = call.stage.slice('product_comparison_research_'.length);
        const response = webResponse(tier);
        if (tier === 'official_manual') response.response.output[0]!.action.sources = [{ url: sharedUrl, title: 'Shared manual' }];
        return response;
      });
      const actual = await research({ onTrace: (event) => { traces.push(event); } });
      if (mode === 'late passage' || mode === 'adjacent passages') {
        expect(actual.facts).toContainEqual(expect.objectContaining({ value: '20 hours', sourceUrl: sharedUrl,
          evidence: actualQuote, evidenceVerifiedExact: true }));
      } else expect(actual.facts).toEqual([]);
      const readTrace: any = traces.find((event) => event.stage === 'document_read');
      expect(readTrace.documentEvidence.documents[0]).toMatchObject({ sourceUrl: sharedUrl,
        textLength: sourceText.length, suppliedLength: Math.min(sourceText.length, 64_000), textHash: expect.any(String) });
      const textHash = readTrace.documentEvidence.documents[0].textHash as string;
      expect(textHash).toHaveLength(64);
      expect([...textHash].every(character => 'abcdef0123456789'.includes(character))).toBe(true);
      expect(JSON.stringify(traces)).not.toContain(sourceText);
      if (mode === 'invalid reference' || mode === 'missing reference') {
        expect(validationCalls).toBe(0);
        expect(actual.warnings).toContain('document_evidence_reference_invalid');
        const documents = createEvidenceDocuments([{ sourceUrl: sharedUrl, text: sourceText },
          { sourceUrl: `${sharedUrl}?other`, text: sourceText }]);
        for (const ids of [['document-0-passage-0', 'document-0-passage-2'],
          ['document-0-passage-0', 'document-1-passage-1'], ['document-0-passage-1', 'document-0-passage-0']]) {
          const rebound = bindDocumentEvidence({ facts: [{ evidenceRef: { passageIds: ids } }] }, documents);
          expect(rebound.parsed.facts).toEqual([]);
          expect(rebound.trace.selections[0]?.status).toBe('invalid');
        }
      } else {
        const check: any = traces.find((event: any) => event.evidenceValidation?.length);
        expect(check.evidenceValidation[0]).toMatchObject({ sourceUrl: sharedUrl, exactExcerptFound: true,
          modelScopeMatched: mode !== 'wrong model', claimSupported: mode !== 'unsupported claim',
          accepted: mode === 'late passage' || mode === 'adjacent passages' });
        expect(check.evidenceValidation[0].validatorTextLength).toBeLessThanOrEqual(18_000);
      }
      if (mode === 'wrong model') {
        expect(actual.warnings).toContain('source_evidence_model_scope_mismatch');
        expect(actual.warnings).not.toContain('source_evidence_exact_excerpt_not_found');
      }
    }
  );

  it.each(['same input', 'changed question', 'changed target', 'changed attributes'] as const)('retries timed-out validation without rereading an unchanged document: %s', async (mode) => {
    const documentReadContext = {};
    let validationCalls = 0;
    parsePdf.mockResolvedValue({ text: `${scopeQuote} ${generalQuote} ${publisherQuote}`, totalPages: 4, parsedPages: 4, truncated: false });
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        if (++validationCalls === 1) throw Object.assign(new Error('validation deadline'), { code: 'structured_json_deadline_exceeded' });
        return semanticResponse(call);
      }
      if (call.stage === 'product_research_document_read') return documentResponse(call, { evidence: generalQuote });
      const tier = call.stage.slice('product_comparison_research_'.length);
      const response = webResponse(tier);
      if (tier === 'official_manual') response.response.output[0]!.action.sources = [{ url: sharedUrl, title: 'Shared manual' }];
      return response;
    });
    const first = await research({ documentReadContext, products: [catalogProduct], precomputedCatalogResult: null });
    expect(first.facts).toEqual([]);
    expect(first.warnings).toContain('source_tier_timed_out:official_manual');
    const second = await research({ documentReadContext, products: [catalogProduct], precomputedCatalogResult: null,
      ...(mode === 'changed question' ? { userMessage: 'Также проверьте обслуживание после хранения.' } : {}),
      ...(mode === 'changed attributes' ? { comparisonAttributes: ['oil grade'], missingFactSlots: [{ productName: target, attribute: 'oil grade' }] } : {}),
      ...(mode === 'changed target' ? { targetProductNames: ['FIRMAN RD4910E'], missingFactSlots: [{ productName: 'FIRMAN RD4910E', attribute }] } : {}) });
    expect(structured.mock.calls.filter(([call]) => call.stage === 'product_research_document_read'))
      .toHaveLength(mode === 'same input' ? 1 : 2);
    if (mode !== 'changed target') expect(validationCalls).toBeGreaterThanOrEqual(2);
    if (mode === 'same input') {
      expect(second.facts).toContainEqual(expect.objectContaining({ value: '20 hours', evidenceVerifiedExact: true }));
      expect(second.warnings).toContain('unverified_document_validation_resumed');
      expect(second.usedWebSearch).toBe(false);
      expect(second.sourceAttempts?.some((attempt) => attempt.tier !== 'catalog')).toBe(false);
    }
    expect(JSON.stringify(first)).not.toContain('documentReadContext');
  });

  it('does not retain a completed document read when its enclosing validation is aborted', async () => {
    const documentReadContext = {};
    const controller = new AbortController();
    arrangeManual();
    const base = structured.getMockImplementation()!;
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return base(call);
    });
    await expect(research({ documentReadContext, products: [catalogProduct], precomputedCatalogResult: null,
      signal: controller.signal })).rejects.toThrow();
    expect(documentReadContext).toEqual({});
    expect(structured.mock.calls.filter(([call]) => call.stage === 'product_research_document_read')).toHaveLength(1);
  });

  it.each(['same page', 'separate manual tier'] as const)('persists a discovered PDF among bounded candidates after a reader timeout: %s', async (origin) => {
    const url = `${sharedUrl}?edition=2026&lang=en`;
    parsePdf.mockResolvedValue({ text: `${scopeQuote} ${generalQuote}`, totalPages: 4, parsedPages: 4, truncated: false });
    structured.mockImplementation(async (call) => {
      if (call.stage === 'product_research_document_read') throw Object.assign(new Error('deadline'), { code: 'structured_json_deadline_exceeded' });
      const tier = call.stage.slice('product_comparison_research_'.length);
      const response = webResponse(tier);
      if (tier === 'official_page') response.response.output[0]!.action.sources = [
        ...Array.from({ length: 13 }, (_, index) => ({ url: `https://www.firman.biz/catalog/${index}`, title: 'Product page' })),
        ...(origin === 'same page' ? [{ url, title: 'Shared manual' }] : [])
      ];
      if (tier === 'official_manual' && origin === 'separate manual tier') response.response.output[0]!.action.sources = [{ url, title: 'Shared manual' }];
      return response;
    });
    const actual = await research();
    expect(fetchSource.mock.calls.map(([value]) => value)).toContain(url);
    expect(actual.sourceCandidates).toHaveLength(12);
    expect(actual.sourceCandidates).toContainEqual(expect.objectContaining({ url }));
    expect(actual.sourceCandidates?.some((candidate) => candidate.url.includes('/catalog/'))).toBe(true);
    expect(actual.facts).toEqual([]);
    expect(actual.warnings).toContain('document_read_timed_out');
    expect(actual.sourcesExhausted).toBe(false);
    expect(validateToolResultOutput({ requestId: 'web', tool: 'web.researchProductFacts', status: 'ok',
      payload: actual as unknown as Record<string, unknown>, warnings: actual.warnings }).payload.sourceCandidates)
      .toContainEqual(expect.objectContaining({ url }));
  });

  it.each(['scoped prior', 'known source', 'parallel page'] as const)('reads the actual PDF lead from %s when the manual response has no document', async (origin) => {
    const originalUrl = 'https://www.firman.biz/manuals/93ae398.pdf?edition=2026&lang=en';
    const mistypedUrl = 'https://www.firman.biz/manuals/93a398.pdf?edition=2026&lang=en';
    parsePdf.mockResolvedValue({ text: `${scopeQuote} ${generalQuote} ${publisherQuote}`, totalPages: 4, parsedPages: 4, truncated: false });
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') return semanticResponse(call);
      if (call.stage === 'product_research_document_read') {
        const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
        expect(payload.documents).toEqual([expect.objectContaining({ sourceUrl: originalUrl })]);
        expect(call.request.tools).toBeUndefined();
        return documentResponse(call, { evidence: generalQuote, sourceUrl: originalUrl });
      }
      const tier = call.stage.slice('product_comparison_research_'.length);
      const response = webResponse(tier);
      if (tier === 'official_page' && origin === 'parallel page') {
        // Finish manual discovery first: sharing only a currently filled array
        // would still miss the page's actual document lead.
        await new Promise((resolve) => setTimeout(resolve, 5));
        response.response.output[0]!.action.sources = [
          ...Array.from({ length: 13 }, (_, index) => ({ url: `https://www.firman.biz/catalog/${index}`, title: 'Product page' })),
          { url: originalUrl, title: 'Shared manual' }
        ];
      }
      if (tier === 'official_manual') {
        response.parsed.sourceAttempts = [{ tier, outcome: 'unreadable', query: `${target} ${tier} ${attribute}`,
          sources: [{ url: mistypedUrl }] }] as any;
      }
      return response;
    });
    const actual = await research({
      ...(origin === 'known source' ? { knownSourceCandidates: [{ url: originalUrl }] } : {}),
      ...(origin === 'scoped prior' ? { previousResearch: [{ requestId: 'prior', status: 'ok', warnings: [],
        payload: { targetProductNames: [target], sourceCandidates: [
          ...Array.from({ length: 13 }, (_, index) => ({ url: `https://www.firman.biz/catalog/${index}` })),
          { url: originalUrl }
        ] } }] } : {})
    });
    expect(fetchSource.mock.calls.map(([url]) => url)).toContain(originalUrl);
    expect(fetchSource.mock.calls.map(([url]) => url)).not.toContain(mistypedUrl);
    expect(actual.facts).toContainEqual(expect.objectContaining({ sourceUrl: originalUrl, value: '20 hours',
      sourceTier: 'official_manual', evidenceVerifiedExact: true, targetApplicability: 'shared_instruction' }));
    expect(structured.mock.calls.filter(([call]) => call.stage === 'product_research_document_read')).toHaveLength(1);
    expect(structured.mock.calls.filter(([call]) => call.stage.startsWith('product_comparison_research_'))).toHaveLength(2);
    expect(actual.sourcesExhausted).toBe(false);
  });

  it.each(['other target', 'mixed targets', 'unknown scope'] as const)('does not read saved document leads from %s', async (scope) => {
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length)));
    const actual = await research({ previousResearch: [{ requestId: 'unrelated', status: 'ok', warnings: [], payload: {
      ...(scope === 'unknown scope' ? {} : { targetProductNames: scope === 'mixed targets' ? [target, 'FIRMAN RD4910E'] : ['FIRMAN RD4910E'] }),
      sourceCandidates: [{ url: sharedUrl }], facts: [{ productName: target, attribute, value: '20 hours' }]
    } }] });
    expect(fetchSource).not.toHaveBeenCalled();
    expect(actual.facts).toEqual([]);
    expect(structured.mock.calls.some(([call]) => call.stage === 'product_research_document_read')).toBe(false);
  });

  it('prefers an accessible saved PDF over a rediscovered prior timeout without copying the old fact', async () => {
    const failedUrl = 'https://www.firman.biz/manuals/old.pdf';
    const mirrorUrl = 'https://www.firman.biz/manuals/accessible.pdf?edition=2026';
    parsePdf.mockResolvedValue({ text: `${scopeQuote} ${generalQuote} ${publisherQuote}`, totalPages: 4, parsedPages: 4, truncated: false });
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') return semanticResponse(call);
      if (call.stage === 'product_research_document_read') return documentResponse(call, { evidence: generalQuote, sourceUrl: mirrorUrl });
      const tier = call.stage.slice('product_comparison_research_'.length);
      const response = webResponse(tier);
      if (tier === 'official_manual') response.response.output[0]!.action.sources = [{ url: failedUrl, title: 'Manual' }];
      return response;
    });
    const actual = await research({ previousResearch: [{ requestId: 'prior', status: 'ok', warnings: [], payload: {
      targetProductNames: [target], sourceCandidates: [{ url: failedUrl }, { url: mirrorUrl }],
      sourceDiagnostics: [{ url: failedUrl, reason: 'timeout', elapsedMs: 4000 }],
      facts: [{ productName: target, attribute, value: '999 hours', sourceUrl: mirrorUrl }]
    } }] });
    expect(fetchSource.mock.calls.map(([url]) => url)).toEqual([mirrorUrl]);
    expect(actual.facts).toContainEqual(expect.objectContaining({ value: '20 hours', sourceUrl: mirrorUrl, evidenceVerifiedExact: true }));
    expect(actual.facts.some((fact) => fact.value === '999 hours')).toBe(false);
  });

  it('reads a known document without waiting for the parallel page discovery', async () => {
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    parsePdf.mockResolvedValue({ text: `${scopeQuote} ${generalQuote} ${publisherQuote}`, totalPages: 4, parsedPages: 4, truncated: false });
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') return semanticResponse(call);
      if (call.stage === 'product_research_document_read') {
        releasePage();
        return documentResponse(call, { evidence: generalQuote });
      }
      if (call.stage === 'product_comparison_research_official_page') await pageGate;
      return webResponse(call.stage.slice('product_comparison_research_'.length));
    });
    const actual = await research({ knownSourceCandidates: [{ url: sharedUrl }] });
    expect(actual.facts).toContainEqual(expect.objectContaining({ value: '20 hours', evidenceVerifiedExact: true }));
    expect(structured.mock.calls.filter(([call]) => call.stage === 'product_research_document_read')).toHaveLength(1);
  });

  it('finishes the manual wait when the parallel page discovery fails', async () => {
    structured.mockImplementation(async (call) => {
      if (call.stage === 'product_comparison_research_official_page') throw new Error('discovery unavailable');
      return webResponse(call.stage.slice('product_comparison_research_'.length));
    });
    const actual = await research();
    expect(actual.facts).toEqual([]);
    expect(actual.warnings).toContain('source_tier_failed:official_page');
    expect(structured.mock.calls.filter(([call]) => call.stage.startsWith('product_comparison_research_'))).toHaveLength(3);
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it.each(['https://www.firman.biz/download?id=RD3910E-manual',
    `https://www.firman.biz/${'a'.repeat(650)}/manual.pdf`])('preserves the actual source lead address in both continuation and memory: %s', async (url) => {
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length)));
    await research({ knownSourceCandidates: [{ url, title: 'Manual' }], previousResearch: [{ requestId: 'prior',
      status: 'ok', warnings: [], payload: { targetProductNames: [target], sourceCandidates: [{ url, title: 'Manual' }] } }] });
    const calls = structured.mock.calls.map(([call]) => call).filter((call) => call.stage.startsWith('product_comparison_research_'));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
      expect(payload.knownSourceCandidates).toEqual([{ url, title: 'Manual' }]);
      expect(payload.previousResearch[0].sourceCandidates).toEqual([{ url, title: 'Manual' }]);
    }
  });
  it.each(['shared source', 'different windows', 'different URLs'] as const)('preserves every fact and coverage claim while sharing only identical source windows: %s', async (mode) => {
    const oilQuote = 'Use engine oil SAE 10W-30.';
    const sourceText = mode === 'different windows'
      ? `${scopeQuote} ${publisherQuote} ${generalQuote} ${'Maintenance background. '.repeat(1500)} ${oilQuote}`
      : `${scopeQuote} ${publisherQuote} ${generalQuote} ${oilQuote} ${'Maintenance background. '.repeat(900)}`;
    parsePdf.mockResolvedValue({ text: sourceText, totalPages: 32, parsedPages: 32, truncated: false });
    const facts = [
      { productName: target, attribute, value: '20 hours', sourceType: 'web', confidence: 'high', evidence: generalQuote,
        sourceUrl: sharedUrl, sourceTitle: 'FIRMAN family instruction manual' },
      { productName: target, attribute: 'oil grade', value: 'SAE 10W-30', sourceType: 'web', confidence: 'high', evidence: oilQuote,
        sourceUrl: mode === 'different URLs' ? 'https://www.firman.biz/manuals/generator-family-copy.pdf' : sharedUrl,
        sourceTitle: 'FIRMAN family instruction manual' }
    ];
    structured.mockImplementation(async (call) => {
      if (call.stage === 'source_evidence_semantic_validation') {
        const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
        return { parsed: { validations: payload.claims.map((entry: any) => ({ itemIndex: entry.itemIndex,
          claimSupported: true, claimStartKinds: [], supportedStartKinds: [], publisherAuthority: 'manufacturer',
          publisherEvidence: publisherQuote, targetApplicability: 'shared_instruction', scopeQuote,
          evidence: entry.claim.evidence, warnings: [] })) } };
      }
      const response = webResponse(call.stage.slice('product_comparison_research_'.length));
      return call.stage.endsWith('_official_manual') ? { ...response, parsed: { ...response.parsed, facts,
        answerGuidance: { directAnswer: `${generalQuote} ${oilQuote}`, completeness: 'answered',
          coverage: facts.map((fact) => ({ ...fact, status: 'confirmed' })) } } } : response;
    });
    const actual = await research({ comparisonAttributes: [attribute, 'oil grade'], missingFactSlots: [] });
    const calls = structured.mock.calls.filter(([call]) => call.stage === 'source_evidence_semantic_validation');
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]![0].request.input.find((item: any) => item.role === 'user').content);
    expect(payload.claims).toHaveLength(4);
    expect(payload.sources).toHaveLength(mode === 'shared source' ? 1 : 2);
    const sources = new Map(payload.sources.map((source: any) => [source.sourceId, source]));
    for (const claim of payload.claims) {
      expect(claim).not.toHaveProperty('sourceText');
      const source: any = sources.get(claim.sourceId);
      expect(source.sourceUrl).toBe(claim.claim.sourceUrl);
      expect(source.sourceText).toContain(claim.claim.evidence);
      expect(source.sourceText).toContain(scopeQuote);
      expect(source.sourceText.length).toBeLessThanOrEqual(18_000);
      expect(claim.targetProductNames).toEqual([target]);
    }
    expect(new Set(payload.claims.map((claim: any) => claim.itemIndex)).size).toBe(4);
    expect(actual.facts).toHaveLength(2);
    expect(actual.facts).toEqual(expect.arrayContaining(facts.map((fact) => expect.objectContaining({
      productName: fact.productName, attribute: fact.attribute, value: fact.value,
      evidence: fact.evidence, sourceUrl: fact.sourceUrl, evidenceVerifiedExact: true,
      targetApplicability: 'shared_instruction', scopeQuote
    }))));
    expect(actual.answerGuidance.coverage.filter((item) => item.status === 'confirmed')).toHaveLength(2);
    if (mode === 'shared source') {
      const repeatedPayload = { claims: payload.claims.map(({ sourceId, ...claim }: any) => ({
        ...claim, sourceText: (sources.get(sourceId) as any).sourceText
      })) };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(Buffer.byteLength(JSON.stringify(repeatedPayload)) / 2);
    }
  });

  it('passes the changed research goal and exact-model prior failures to every source tier without treating them as new facts', async () => {
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length)));
    const researchGoal = { query: 'FIRMAN RD3910E maintenance HTML manual', semanticQuery: 'find readable first-service instructions',
      reason: 'The official PDF timed out; use another accessible edition or source.', notes: 'Preserve verified start facts and resolve the first oil-change interval.' };
    const previousResearch = [{ requestId: 'web-original', status: 'ok', warnings: ['source_evidence_fetch_failed'],
      payload: { targetProductNames: [target], searchDisposition: 'completed', sourcesExhausted: false,
        facts: [{ productName: target, attribute: 'start', value: 'manual recoil', evidence: 'Manual recoil starter.', sourceType: 'web',
          sourceUrl: 'https://www.firman.biz/product/rd3910e', evidenceVerifiedExact: true }],
        answerGuidance: { coverage: [{ productName: target, attribute, status: 'not_confirmed', value: '', evidence: 'Manual could not be read.' }] },
        sourceDiagnostics: [{ url: sharedUrl, reason: 'timeout', elapsedMs: 10001 }],
        sourceCandidates: [{ url: sharedUrl, title: 'Discovered manual' }],
        sourceAttempts: [{ tier: 'official_manual', outcome: 'unreadable', query: 'FIRMAN RD3910E manual', sources: [{ url: sharedUrl }] }] } }];
    const actual = await research({ researchGoal, previousResearch });
    const calls = structured.mock.calls.map(([call]) => call).filter((call) => call.stage.startsWith('product_comparison_research_'));
    expect(calls.map((call) => call.stage)).toEqual(['product_comparison_research_official_page',
      'product_comparison_research_official_manual', 'product_comparison_research_reliable_secondary']);
    for (const call of calls) {
      const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
      expect(payload.researchGoal).toEqual(researchGoal);
      expect(payload.previousResearch).toEqual([expect.objectContaining({ requestId: 'web-original',
        facts: [expect.objectContaining({ productName: target, value: 'manual recoil' })],
        sourceCandidates: [{ url: sharedUrl, title: 'Discovered manual' }],
        sourceDiagnostics: [expect.objectContaining({ url: sharedUrl, reason: 'timeout' })],
        sourceAttempts: [expect.objectContaining({ query: 'FIRMAN RD3910E manual', outcome: 'unreadable' })] })]);
      const instructions = call.request.input.find((item: any) => item.role === 'system').content;
      expect(instructions).toContain('researchGoal');
      expect(instructions).toContain('not fresh independent verification');
      expect(instructions).toContain('timeout is not evidence');
    }
    expect(actual.facts).toEqual([]);
  });

  it('bounds continuation context and strips unrelated model data, raw logs and credential-bearing URL components', async () => {
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length)));
    const otherTarget = 'FIRMAN RD4910E';
    const massive = 'bounded text '.repeat(3000);
    const relevant = (requestId: string) => ({ requestId, status: 'ok', warnings: ['source_evidence_fetch_failed'], payload: {
      targetProductNames: [target], rawMessages: 'PRIVATE RAW MESSAGE', rawHeaders: { authorization: 'PRIVATE HEADER' },
      products: [{ name: target, description: 'PRIVATE PRODUCT DESCRIPTION' }], providerTokenReservation: 999999,
      facts: Array.from({ length: 20 }, (_, index) => ({ productName: index === 0 ? otherTarget : target,
        attribute: massive, value: massive, evidence: massive, sourceType: 'web', sourceUrl: sharedUrl, raw: 'PRIVATE FACT LOG' })),
      sourceDiagnostics: Array.from({ length: 15 }, () => ({
        url: 'https://private-user:private-pass@www.firman.biz/manuals/rd3910e.pdf?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT',
        reason: 'timeout', elapsedMs: 10000, rawMessage: 'PRIVATE ERROR', rawHeaders: 'PRIVATE DIAGNOSTIC HEADER'
      })),
      sourceAttempts: Array.from({ length: 8 }, () => ({ tier: 'official_manual', outcome: 'unreadable', query: massive,
        sources: Array.from({ length: 8 }, () => ({ url: sharedUrl, rawBody: 'PRIVATE SOURCE BODY' })) }))
    } });
    const previousResearch = [relevant('old-relevant'), relevant('recent-relevant'),
      { requestId: 'unrelated', status: 'ok', warnings: [], payload: { targetProductNames: [otherTarget], summaryForAnswer: 'UNRELATED SUMMARY' } },
      relevant('latest-relevant')];
    await research({ researchGoal: { query: massive, notes: massive }, previousResearch });
    const payload = JSON.parse(structured.mock.calls[0][0].request.input.find((item: any) => item.role === 'user').content);
    expect(payload.previousResearch.map((item: any) => item.requestId)).toEqual(['recent-relevant', 'latest-relevant']);
    expect(JSON.stringify({ researchGoal: payload.researchGoal, previousResearch: payload.previousResearch }).length).toBeLessThanOrEqual(12_000);
    expect(payload.previousResearch.flatMap((item: any) => item.facts).length).toBeLessThanOrEqual(12);
    expect(payload.previousResearch.flatMap((item: any) => item.sourceDiagnostics).length).toBeLessThanOrEqual(8);
    expect(payload.previousResearch.flatMap((item: any) => item.sourceAttempts).length).toBeLessThanOrEqual(3);
    for (const observation of payload.previousResearch) {
      expect(observation.facts.length).toBeLessThanOrEqual(12);
      expect(observation.facts.every((fact: any) => fact.productName === target)).toBe(true);
      expect(observation.sourceDiagnostics.length).toBeLessThanOrEqual(8);
      expect(observation.sourceDiagnostics[0].url).toBe('https://www.firman.biz/manuals/rd3910e.pdf');
      expect(observation.sourceAttempts.length).toBeLessThanOrEqual(3);
      expect(observation.sourceAttempts.every((attempt: any) => attempt.sources.length <= 3)).toBe(true);
    }
    const serialized = JSON.stringify(payload.previousResearch);
    for (const sensitive of ['PRIVATE', 'private-user', 'private-pass', 'providerTokenReservation', 'rawMessages', 'rawHeaders', 'UNRELATED']) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it.each(['exact', 'generic'] as const)('preserves the changed goal in the legacy %s retry as well as its first pass', async (kind) => {
    const researchGoal = { query: 'readable maintenance instructions', reason: 'Use a source that can actually be read.' };
    structured.mockImplementation(async () => webResponse('official_page'));
    await research({ researchGoal, missingFactSlots: undefined,
      ...(kind === 'generic' ? { targetProductNames: [] } : {}) });
    const calls = structured.mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.stage)).toEqual(['product_comparison_research',
      kind === 'exact' ? 'product_comparison_research_exact_retry' : 'product_comparison_research_generic_source_tier_retry']);
    for (const call of calls) {
      const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
      expect(payload.researchGoal).toEqual(researchGoal);
      expect(call.request.input.find((item: any) => item.role === 'system').content).toContain('researchGoal');
    }
  });

  it('keeps calls without continuation inputs compatible and excludes unknown or mixed prior target scopes', async () => {
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length)));
    await research();
    let payload = JSON.parse(structured.mock.calls[0][0].request.input.find((item: any) => item.role === 'user').content);
    expect(payload.researchGoal).toBeUndefined();
    expect(payload.previousResearch).toBeUndefined();
    structured.mockClear();
    await research({ previousResearch: [
      { requestId: 'unknown', status: 'ok', warnings: [], payload: { facts: [{ productName: target }] } },
      { requestId: 'mixed', status: 'ok', warnings: [], payload: { targetProductNames: [target, 'FIRMAN RD4910E'] } }
    ] });
    payload = JSON.parse(structured.mock.calls[0][0].request.input.find((item: any) => item.role === 'user').content);
    expect(payload.previousResearch).toBeUndefined();
  });

  it.each(['timeout', 'skipped_budget', 'empty_success'] as const)(
    'retains exact catalog primary text and known source links when compact extraction is %s', async (outcome) => {
      const exactProduct = { ...catalogProduct, specs: {
        src: 'https://www.firman.biz/product/rd3910e',
        manualUrl: 'https://www.firman.biz/manuals/rd3910e.pdf',
        start: 'manual'
      } };
      structured.mockImplementation(async (call) => {
        if (call.stage.startsWith('catalog_')) {
          if (outcome === 'timeout') throw new DOMException('Catalog stage expired', 'TimeoutError');
          return { parsed: { facts: [], conflicts: [], missing: [], directAnswer: '', completeness: 'not_answered' } };
        }
        return webResponse(call.stage.slice('product_comparison_research_'.length));
      });
      await research({ products: [exactProduct], deadlineAtMs: Date.now() + (outcome === 'skipped_budget' ? 23_000 : 60_000) });
      const webCalls = structured.mock.calls.map(([call]) => call).filter((call) => call.stage.startsWith('product_comparison_research_'));
      expect(webCalls.length).toBeGreaterThan(0);
      for (const call of webCalls) {
        const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
        expect(payload.products).toContainEqual(expect.objectContaining({
          id: exactProduct.id, description: exactProduct.description,
          sourceUrl: exactProduct.sourceUrl, specs: exactProduct.specs
        }));
        const instructions = call.request.input.find((item: any) => item.role === 'system').content;
        expect(instructions).not.toContain('catalogExtraction already contains a compact semantic reading');
      }
      expect(structured.mock.calls.some(([call]) => call.stage.startsWith('catalog_'))).toBe(outcome !== 'skipped_budget');
    }
  );

  it('gives a 23 second retry useful official time and skips doomed catalog extraction and secondary', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const overallDeadline = now + 23_000;
    const traces: ProductResearchTraceEvent[] = [];
    structured.mockImplementation(async (call) => {
      if (call.stage.startsWith('catalog_')) return { parsed: { facts: [], conflicts: [], missing: [], directAnswer: '', completeness: 'not_answered' } };
      if (call.stage.endsWith('_official_manual')) now = overallDeadline - 1_500;
      return webResponse(call.stage.slice('product_comparison_research_'.length));
    });
    const actual = await research({ products: [catalogProduct], deadlineAtMs: overallDeadline, onTrace: (trace) => { traces.push(trace); } });
    const stages = structured.mock.calls.map(([call]) => call.stage);
    expect(stages).not.toContain('catalog_product_fact_extraction_compact');
    expect(stages).toEqual(['product_comparison_research_official_page', 'product_comparison_research_official_manual']);
    expect(structured.mock.calls[0][0].deadlineAtMs - 1_000_000).toBeGreaterThanOrEqual(15_000);
    expect(structured.mock.calls[0][0].deadlineAtMs).toBeLessThanOrEqual(overallDeadline - 5_000);
    expect(traces).toContainEqual(expect.objectContaining({ stage: 'catalog_extraction', outcome: 'skipped_budget' }));
    expect(actual.sourcesExhausted).toBe(false);
    expect(actual.sourceAttempts).toContainEqual(expect.objectContaining({ tier: 'reliable_secondary', outcome: 'skipped_budget' }));
  });

  it('does not begin any web model stage when the remaining time cannot include source verification', async () => {
    const traces: ProductResearchTraceEvent[] = [];
    const actual = await research({ deadlineAtMs: Date.now() + 5_000, onTrace: (trace) => { traces.push(trace); } });
    expect(structured).not.toHaveBeenCalled();
    expect(actual.searchDisposition).toBe('skipped_budget');
    expect(actual.sourcesExhausted).toBe(false);
    expect(traces.filter((trace) => trace.outcome === 'skipped_budget')).toHaveLength(3);
  });

  it('reserves source-validation time within full-budget official stages while keeping secondary bounded', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    arrangeManual();
    const actual = await research({ deadlineAtMs: 1_060_000 });
    const query = structured.mock.calls.find(([call]) => call.stage.endsWith('_official_manual'))![0];
    const validation = structured.mock.calls.find(([call]) => call.stage === 'source_evidence_semantic_validation')![0];
    expect(validation.deadlineAtMs - query.deadlineAtMs).toBeGreaterThanOrEqual(5_000);
    expect(validation.deadlineAtMs).toBeLessThanOrEqual(1_038_000);
    expect(actual.facts).toHaveLength(1);
  });

  it('honors mandatory external verification even when every typed slot is catalog-confirmed', async () => {
    arrangeManual();
    const catalogResult: ProductComparisonResearchResult = { ...emptyResult(), facts: [{ productName: target,
      attribute, value: '20 hours', sourceType: 'catalog', confidence: 'high', evidence: generalQuote,
      sourceUrl: catalogProduct.sourceUrl ?? undefined }] };
    const actual = await research({ products: [catalogProduct], precomputedCatalogResult: catalogResult });
    expect(structured.mock.calls.some(([call]) => call.stage.endsWith('_official_manual'))).toBe(true);
    expect(actual.usedWebSearch).toBe(true);
    expect(actual.facts).toContainEqual(expect.objectContaining({ sourceType: 'web', sourceTier: 'official_manual' }));
  });

  it('keeps the permitted catalog-only shortcut', async () => {
    const actual = await research({ products: [catalogProduct], allowCatalogOnlyAnswer: true,
      precomputedCatalogResult: { ...emptyResult(), facts: [{ productName: target, attribute, value: '20 hours',
        sourceType: 'catalog', confidence: 'high', evidence: generalQuote, sourceUrl: catalogProduct.sourceUrl ?? undefined }] } });
    expect(structured).not.toHaveBeenCalled();
    expect(actual.usedWebSearch).toBe(false);
  });

  it('accepts a shared-manual instruction through verified fact and model-scope quotes in the same batch', async () => {
    arrangeManual();
    const actual = await research();
    expect(actual.facts, JSON.stringify(actual)).toContainEqual(expect.objectContaining({ evidence: generalQuote, scopeQuote,
      targetApplicability: 'shared_instruction', evidenceVerifiedExact: true, sourceAuthority: 'manufacturer' }));
    expect(structured.mock.calls.filter(([call]) => call.stage === 'source_evidence_semantic_validation')).toHaveLength(1);
  });

  it.each([
    ['neighbor row', `${scopeQuote} FIRMAN RD4910E: first oil change after 20 hours.`, { claimSupported: false, targetApplicability: 'not_applicable' }, 'FIRMAN RD4910E: first oil change after 20 hours.'],
    ['neighbor row mislabeled shared', `${scopeQuote} FIRMAN RD4910E: first oil change after 20 hours.`, { evidence: 'FIRMAN RD4910E: first oil change after 20 hours.' }, 'FIRMAN RD4910E: first oil change after 20 hours.'],
    ['title only', generalQuote, {}, generalQuote],
    ['fabricated scope', `${target} overview. ${generalQuote}`, {}, generalQuote],
    ['uncertain applicability', `${scopeQuote} ${generalQuote}`, { targetApplicability: 'uncertain' }, generalQuote],
    ['scope from another model', `FIRMAN RD4910E instructions. ${generalQuote}`, { scopeQuote: 'FIRMAN RD4910E instructions.' }, generalQuote]
  ])('rejects unproven shared applicability: %s', async (_name, source, validation, quote) => {
    arrangeManual(source as string, validation as Record<string, unknown>, quote as string);
    const actual = await research();
    expect(actual.facts).toEqual([]);
    expect(actual.sourcesExhausted).toBe(false);
    if (_name === 'fabricated scope') {
      expect(actual.warnings).toContain('source_evidence_model_scope_mismatch');
      expect(actual.warnings).not.toContain('source_evidence_exact_excerpt_not_found');
    }
  });

  it('keeps document scope visible when the fact is far from the manual cover without expanding the text cap', async () => {
    arrangeManual(`${scopeQuote} ${'Maintenance background. '.repeat(1300)} ${generalQuote}`);
    const actual = await research();
    const call = structured.mock.calls.find(([item]) => item.stage === 'source_evidence_semantic_validation')![0];
    const payload = JSON.parse(call.request.input.find((item: any) => item.role === 'user').content);
    const source = payload.sources.find((item: any) => item.sourceId === payload.claims[0].sourceId);
    expect(source.sourceText).toContain(scopeQuote);
    expect(source.sourceText).toContain(generalQuote);
    expect(source.sourceText.length).toBeLessThanOrEqual(18_000);
    expect(actual.facts).toHaveLength(1);
  });

  it.each(['uncertain', undefined, null, 'invalid_status', 1, { status: 'exact_model' }, 'not_applicable'])(
    'does not promote an exact-looking quote with missing or unproven applicability: %j', async (applicability) => {
      const quote = `${target}: ${generalQuote}`;
      arrangeManual(quote, { targetApplicability: applicability, scopeQuote: '', evidence: quote,
        warnings: ['Applicability to the requested revision is unproven'] }, quote);
      const actual = await research();
      expect(actual.facts).toEqual([]);
      expect(actual.answerGuidance.coverage).not.toContainEqual(expect.objectContaining({ status: 'confirmed' }));
      expect(actual.warnings).not.toContain('source_evidence_semantic_claim_verified');
      expect(actual.sourcesExhausted).toBe(false);
    }
  );

  it('keeps an explicitly model-applicable exact quote without requiring separate shared scope', async () => {
    const quote = `${target}: ${generalQuote}`;
    arrangeManual(quote, { targetApplicability: 'exact_model', scopeQuote: '', evidence: quote }, quote);
    const actual = await research();
    expect(actual.facts).toContainEqual(expect.objectContaining({ evidence: quote, evidenceVerifiedExact: true }));
  });

  it.each([
    ['http_status', 404, undefined],
    ['timeout', undefined, new DOMException('private timeout detail', 'TimeoutError')],
    ['network', undefined, Object.assign(new Error('private network detail'), { cause: { code: 'ECONNRESET' } })],
    ['unsupported_binary', 200, undefined]
  ])('records bounded %s provenance without inventing a semantic rejection', async (reason, status, error) => {
    arrangeManual();
    const url = 'https://www.firman.biz/manuals/generator-family?private_query=hidden';
    structured.mockImplementation(async (call) => webResponse(call.stage.slice('product_comparison_research_'.length),
      call.stage.endsWith('_official_manual') ? { evidence: generalQuote, sourceUrl: url } : undefined));
    if (error) fetchSource.mockRejectedValue(error);
    else fetchSource.mockImplementation(async () => ({ url, status, headers: new Headers({ 'content-type': 'application/octet-stream' }),
      bytes: new TextEncoder().encode('unsupported bytes') }));
    const actual = await research();
    expect(actual.facts).toEqual([]);
    expect(actual.warnings).not.toContain('source_evidence_validation_failed:semantic');
    expect(actual.sourceDiagnostics).toContainEqual(expect.objectContaining({ reason,
      url: 'https://www.firman.biz/manuals/generator-family', elapsedMs: expect.any(Number),
      ...(reason === 'http_status' ? { status: 404 } : {}), ...(reason === 'network' ? { code: 'ECONNRESET' } : {}) }));
    expect(JSON.stringify(actual.sourceDiagnostics)).not.toContain('private');
  });
});
