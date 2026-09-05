import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactToolResultsForModel, compactVerifiedFactsForModel } from '../src/ai/agentManagerModelContext.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import type { Product, VerifiedProductFact } from '../src/shared/types.js';

function catalogProduct(id: string, blob = 'exact-spec'): Product {
  return {
    id,
    name: `TSS ${id} generator`,
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    specs: { blob }
  };
}

function catalogResult(products: Product[]): ToolResult {
  return {
    requestId: 'catalog-search',
    tool: 'catalog.search',
    status: 'ok',
    payload: {
      query: 'generator',
      productIds: products.map((product) => product.id),
      products,
      retrieval: { usedEmbeddings: false }
    },
    warnings: []
  };
}

describe('agent manager model context compaction', () => {
  it('shares only exactly represented web products and keeps unmatched source evidence and durable artifacts intact', () => {
    const same = catalogProduct('p1');
    const different = { ...same, description: 'A different source description.', specs: { oil: '10W-30' } };
    const outside = catalogProduct('outside');
    const facts = [{ productName: same.name, attribute: 'manual_starter', value: 'absent',
      evidence: 'No recoil starter is fitted.', sourceUrl: 'https://example.com/manual', sourceTier: 'official_manual' }];
    const original: ToolResult = { requestId: 'web', tool: 'web.researchProductFacts', status: 'ok', warnings: ['partial'],
      payload: { products: [same, different, outside], facts, conflicts: [{ attribute: 'oil', values: ['10W-30', '10W-40'] }],
        sourceAttempts: ['official_manual'], sourcesExhausted: false, answerGuidance: { directAnswer: 'No recoil starter.' } } };
    const snapshot = structuredClone(original);
    const compact = compactToolResultsForModel([original], [same])[0]!;
    expect(compact.payload).toMatchObject({ products: [different, outside], productIds: [same.id], facts,
      conflicts: snapshot.payload.conflicts, sourceAttempts: ['official_manual'], sourcesExhausted: false,
      answerGuidance: snapshot.payload.answerGuidance });
    expect(original).toEqual(snapshot);
  });

  it('removes only database bookkeeping from verified facts while preserving every identity, source and freshness field', () => {
    const fact: VerifiedProductFact = { id: 'fact-1', productId: 'product-1', productKey: 'exact-model', productName: 'Exact Model',
      attribute: 'oil_capacity', value: '1.1 L, including filter', sourceType: 'manual', sourceUrl: 'https://example.com/manual',
      sourceTitle: 'Model operating manual', evidence: 'Oil capacity including filter: 1.1 L.', sourceTier: 'official_manual',
      sourceAuthority: 'manufacturer', confidence: 'high', status: 'active', observedAt: '2026-09-01T00:00:00Z',
      lastVerifiedAt: '2026-09-04T00:00:00Z', firstSeenAt: '2026-08-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z', hitCount: 7, catalogSourceHash: 'hash', sourceFingerprint: 'fingerprint' };
    const snapshot = structuredClone(fact);
    const compact = compactVerifiedFactsForModel([fact]);
    const { hitCount, createdAt, updatedAt, firstSeenAt, catalogSourceHash, sourceFingerprint, ...semanticFields } = fact;
    expect(compact).toEqual([semanticFields]);
    expect(fact).toEqual(snapshot);
    expect(compactVerifiedFactsForModel([{ ...fact, id: 'conflict', value: '0.8 L' }])[0]).toMatchObject({
      id: 'conflict', value: '0.8 L', productId: fact.productId, evidence: fact.evidence,
      lastVerifiedAt: fact.lastVerifiedAt, observedAt: fact.observedAt, sourceAuthority: fact.sourceAuthority
    });
  });

  it('strips duplicate catalog products, intersects ids, and never mutates the durable artifact', () => {
    const products = [catalogProduct('p1'), catalogProduct('p2')];
    const durable = catalogResult(products);
    const durableSnapshot = structuredClone(durable);

    const [compact] = compactToolResultsForModel([durable], [products[0]!]);

    expect(compact).not.toBe(durable);
    expect(compact?.payload).toMatchObject({
      query: 'generator',
      productIds: ['p1'],
      retrieval: { usedEmbeddings: false }
    });
    expect(compact?.payload).not.toHaveProperty('products');
    expect(durable).toEqual(durableSnapshot);
    expect(durable.payload).toHaveProperty('products', products);
  });

  it('leaves non-catalog tool results unchanged', () => {
    const calculator: ToolResult = {
      requestId: 'calc',
      tool: 'calculator.generatorLoad',
      status: 'ok',
      payload: { profile: { requiredNominalKw: 5 } },
      warnings: []
    };
    const web: ToolResult = {
      requestId: 'web',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: { facts: [{ attribute: 'power', value: '5 kW' }] },
      warnings: []
    };

    const compact = compactToolResultsForModel([calculator, web], []);

    expect(compact[0]).toBe(calculator);
    expect(compact[1]).toBe(web);
  });

  it('keeps a maximum-size product sentinel exactly once and cuts duplicated model payload by over 40 percent', () => {
    const sentinel = `SENTINEL-${'x'.repeat(170_000)}`;
    const products = [catalogProduct('p1', sentinel)];
    const durable = catalogResult(products);
    const originalBody = JSON.stringify({ toolResults: [durable], products });
    const compactBody = JSON.stringify({
      toolResults: compactToolResultsForModel([durable], products),
      products
    });

    expect(originalBody.split('SENTINEL-')).toHaveLength(3);
    expect(compactBody.split('SENTINEL-')).toHaveLength(2);
    expect(compactBody.length).toBeLessThan(originalBody.length * 0.6);
  });

  it('uses the compact tool boundary in the single writer request serialization', () => {
    const source = readFileSync(new URL('../src/ai/agentManagerOrchestrator.ts', import.meta.url), 'utf8');
    const writerSource = source.slice(source.indexOf('  async composeAnswer('));
    const writerMethod = writerSource.slice(0, writerSource.indexOf('\n  async ', 1));
    const boundary = 'toolResults: compactToolResultsForModel(input.toolResults, input.products)';
    expect(writerMethod.split(boundary).length - 1).toBe(1);
    expect(writerMethod).toContain('products: input.products.map((product) => answerProductContext(product, input.toolResults))');
  });
});
