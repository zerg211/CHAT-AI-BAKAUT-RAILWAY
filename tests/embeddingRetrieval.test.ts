import { describe, expect, it, vi, beforeEach } from 'vitest';

const createEmbeddingMock = vi.hoisted(() => vi.fn(async () => [0.1, 0.2, 0.3]));

vi.mock('../src/ai/openaiClient.js', () => ({
  createOpenAIClient: () => null,
  createEmbedding: createEmbeddingMock,
  withRetry: async <T>(fn: () => Promise<T>) => fn()
}));

const { AssistantService } = await import('../src/ai/assistant.js');
const { emptyNeedState } = await import('../src/ai/needState.js');
const { ProductRepository } = await import('../src/db/repositories.js');

function product(id: string, name: string, category: string, sourceUrl: string, retrievalScore?: number) {
  return {
    id,
    name,
    category,
    sourceUrl,
    price: 100_000,
    specs: {},
    raw: { pageType: 'product' },
    retrievalSource: retrievalScore === undefined ? undefined : 'vector',
    retrievalScore
  };
}

class FakeProducts {
  vectorCalls = 0;

  constructor(
    private readonly coverage: { total: number; usable: number; coverage: number },
    private readonly vectorProducts: ReturnType<typeof product>[] = []
  ) {}

  async getEmbeddingCoverage(target: string) {
    return { target, embedded: this.coverage.usable, ...this.coverage };
  }

  async searchProducts() {
    return [];
  }

  async searchProductsByModelTokens() {
    return [];
  }

  async vectorSearch() {
    this.vectorCalls += 1;
    return this.vectorProducts;
  }
}

function productRow() {
  return {
    id: 'product-id',
    external_id: null,
    slug: null,
    source_url: 'https://example.com/p',
    name: 'Product',
    brand: null,
    category: 'Category',
    price: null,
    currency: 'RUB',
    image_url: null,
    description: null,
    specs: {},
    raw: { pageType: 'product' }
  };
}

describe('embedding retrieval hardening', () => {
  beforeEach(() => {
    createEmbeddingMock.mockClear();
  });

  it('skips query embeddings and vector search when product coverage is unusable', async () => {
    const products = new FakeProducts({ total: 20, usable: 0, coverage: 0 });
    const assistant = new AssistantService(undefined as never, products as never);

    const result = await assistant.findProducts('нужен бензиновый генератор', emptyNeedState());

    expect(result).toEqual([]);
    expect(createEmbeddingMock).not.toHaveBeenCalled();
    expect(products.vectorCalls).toBe(0);
  });

  it('does not let vector similarity bypass hard product intent filters', async () => {
    const vectorPlate = product(
      'plate-1',
      'Виброплита TSS VP90',
      'Виброплиты',
      'https://example.com/plate',
      0.99
    );
    const products = new FakeProducts({ total: 20, usable: 20, coverage: 1 }, [vectorPlate]);
    const assistant = new AssistantService(undefined as never, products as never);

    const result = await assistant.findProducts('нужен бензиновый генератор 5 кВт', emptyNeedState());

    expect(createEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(products.vectorCalls).toBe(1);
    expect(result.map((item) => item.id)).not.toContain('plate-1');
  });

  it('stores embedding metadata when product embeddings are supplied', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [productRow()] })
      .mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ProductRepository({ query } as never);

    await repository.upsertProduct({
      name: 'Product',
      sourceUrl: 'https://example.com/p',
      raw: { pageType: 'product' }
    }, [0.1, 0.2], { model: 'embedding-model', sourceHash: 'hash-1' });

    expect(query.mock.calls[0][0]).toContain('embedding_model');
    expect(query.mock.calls[0][0]).toContain('embedding_source_hash');
    expect(query.mock.calls[0][1]).toContain('embedding-model');
    expect(query.mock.calls[0][1]).toContain('hash-1');
  });

  it('reports usable embedding coverage for the configured model', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ total: 10, embedded: 7, usable: 4 }]
    });
    const repository = new ProductRepository({ query } as never);

    const coverage = await repository.getEmbeddingCoverage('products', 'embedding-model');

    expect(query.mock.calls[0][0]).toContain('embedding_model = $1');
    expect(coverage).toEqual({
      target: 'products',
      total: 10,
      embedded: 7,
      usable: 4,
      coverage: 0.4
    });
  });
});
