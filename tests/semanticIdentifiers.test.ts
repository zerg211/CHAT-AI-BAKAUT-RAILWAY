import { expect, it, vi } from 'vitest';
import { AgentManagerOrchestrator } from '../src/ai/agentManagerOrchestrator.js';
import { CatalogSearchToolArgsSchema } from '../src/ai/agentManagerContracts.js';
import { catalogSearchToolArgsJsonSchema } from '../src/ai/agentManagerModelAdapter.js';

it('numeric budget and power in a query are not promoted to SKU without a planner binding', async () => {
  const exact = vi.fn(async () => []);
  const repository = { getProductsByExactArticle: exact, getProductByExactArticle: vi.fn(async () => null),
    searchProducts: vi.fn(async () => []), searchProductsByModelTokens: vi.fn(async () => []),
    getEmbeddingCoverage: vi.fn(async () => ({ total:0,usable:0 })), vectorSearch: vi.fn(async () => []) };
  const orchestrator = new AgentManagerOrchestrator({} as never, repository as never, {} as never, {} as never, async () => [0.1]);
  await (orchestrator as any).searchCatalogProducts({ query: 'до 90000 рублей, 5000 Вт', limit: 4 });
  expect(exact).not.toHaveBeenCalled();
  expect(repository.getProductByExactArticle).not.toHaveBeenCalled();
});

it('planner namespace and leading zeros survive provider schema and runtime validation', () => {
  expect(catalogSearchToolArgsJsonSchema.required).toContain('identifiers');
  expect(CatalogSearchToolArgsSchema.parse({ query:'артикул', identifiers:[{kind:'article',value:'0012345',namespace:null}] }).identifiers)
    .toEqual([{kind:'article',value:'0012345',namespace:undefined}]);
});
