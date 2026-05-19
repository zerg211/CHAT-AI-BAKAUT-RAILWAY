import { config } from '../config.js';
import { ProductRepository, type EmbeddingCoverage, type EmbeddingCoverageTarget } from '../db/repositories.js';

const COVERAGE_TARGETS: EmbeddingCoverageTarget[] = ['products', 'catalog_pages', 'troubleshooting_cases'];
const FINAL_COVERAGE_TARGET = 0.8;

function reportTarget(coverage: EmbeddingCoverage) {
  return {
    total: coverage.total,
    embedded: coverage.embedded,
    usable: coverage.usable,
    coverage: coverage.coverage,
    ready: coverage.total > 0 && coverage.coverage >= config.EMBEDDING_MIN_COVERAGE
  };
}

export async function buildEmbeddingCoverageReport(repository = new ProductRepository()) {
  const coverages = await Promise.all(
    COVERAGE_TARGETS.map((target) => repository.getEmbeddingCoverage(target, config.OPENAI_EMBEDDING_MODEL))
  );
  const targets = Object.fromEntries(
    coverages.map((coverage) => [coverage.target, reportTarget(coverage)])
  ) as Record<EmbeddingCoverageTarget, ReturnType<typeof reportTarget>>;
  const finalReady = targets.products.coverage >= FINAL_COVERAGE_TARGET &&
    targets.catalog_pages.coverage >= FINAL_COVERAGE_TARGET &&
    (targets.troubleshooting_cases.total === 0 || targets.troubleshooting_cases.coverage >= FINAL_COVERAGE_TARGET);

  return {
    model: config.OPENAI_EMBEDDING_MODEL,
    minCoverage: config.EMBEDDING_MIN_COVERAGE,
    finalCoverageTarget: FINAL_COVERAGE_TARGET,
    targets,
    finalReady
  };
}
