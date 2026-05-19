import { describe, expect, it } from 'vitest';
import { buildEmbeddingCoverageReport } from '../src/ai/embeddingCoverage.js';
import type { EmbeddingCoverageTarget } from '../src/db/repositories.js';

describe('embedding coverage report', () => {
  it('formats runtime readiness and final readiness from repository coverage', async () => {
    const repository = {
      async getEmbeddingCoverage(target: EmbeddingCoverageTarget) {
        const rows = {
          products: { total: 100, embedded: 90, usable: 90, coverage: 0.9 },
          catalog_pages: { total: 10, embedded: 8, usable: 8, coverage: 0.8 },
          troubleshooting_cases: { total: 0, embedded: 0, usable: 0, coverage: 0 }
        };
        return { target, ...rows[target] };
      }
    };

    const report = await buildEmbeddingCoverageReport(repository as never);

    expect(report).toMatchObject({
      model: 'text-embedding-3-small',
      minCoverage: 0.05,
      finalCoverageTarget: 0.8,
      targets: {
        products: { total: 100, embedded: 90, usable: 90, coverage: 0.9, ready: true },
        catalog_pages: { total: 10, embedded: 8, usable: 8, coverage: 0.8, ready: true },
        troubleshooting_cases: { total: 0, embedded: 0, usable: 0, coverage: 0, ready: false }
      },
      finalReady: true
    });
  });
});
