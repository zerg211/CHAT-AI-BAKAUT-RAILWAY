import { ProductRepository } from '../db/repositories.js';
import type { EnrichmentItemOutcome } from '../shared/types.js';

export async function processKnowledgeEnrichment(repository = new ProductRepository()) {
  const job = await repository.claimVerifiedFactEnrichmentJob();
  if (!job) return { claimed: false, saved: 0 };
  let saved = 0;
  const outcomes: EnrichmentItemOutcome[] = [];
  try {
    if (job.page) {
      const result = await repository.publishCompanyPageJob(job);
      if (result.leaseLost) return { claimed: true, saved, outcomes, error: 'lease_lost' };
      outcomes.push(...result.outcomes);
      saved += result.outcomes.filter(item => item.status === 'published' || item.status === 'reused').length;
    }
    const handled = new Set<number>();
    for (let index = 0; index < job.facts.length; index += 1) {
      if (handled.has(index)) continue;
      const group = job.facts[index]?.atomicGroup;
      const indexes = group ? job.facts.flatMap((fact, i) => fact?.atomicGroup === group ? [i] : []) : [index];
      const result = await repository.publishVerifiedFactEnrichmentGroup(job, indexes);
      if (result.leaseLost) return { claimed: true, saved, outcomes, error: 'lease_lost' };
      indexes.forEach(i => handled.add(i));
      outcomes.push(...result.outcomes);
      saved += result.outcomes.filter(item => item.status === 'published' || item.status === 'reused').length;
    }
    const error = outcomes.some(item => item.status === 'retryable_failure') ? 'knowledge_enrichment_incomplete' : undefined;
    const finished = await repository.finishVerifiedFactEnrichmentJob(job, error);
    return { claimed: true, saved, outcomes, ...(finished ? (error ? { error } : {}) : { error: 'lease_lost' }) };
  } catch {
    // Do not log raw evidence or database connection errors with credentials.
    await repository.finishVerifiedFactEnrichmentJob(job, 'knowledge_enrichment_failed');
    return { claimed: true, saved, outcomes, error: 'knowledge_enrichment_failed' };
  }
}

export function startKnowledgeEnrichmentWorker() {
  let inFlight: Promise<unknown> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = processKnowledgeEnrichment().catch(() => undefined).finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(run, 5_000);
  timer.unref();
  run();
  return async () => { stopped = true; clearInterval(timer); await inFlight; };
}
