import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactToolResultsForModel } from '../src/ai/agentManagerModelContext.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import type { Product } from '../src/shared/types.js';

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
    expect(writerMethod).toContain('products: input.products.map(answerProductContext)');
  });
});
