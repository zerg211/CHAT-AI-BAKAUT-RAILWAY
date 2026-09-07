import { ProductRepository } from '../db/repositories.js';

export async function processKnowledgeEnrichment(repository = new ProductRepository()) {
  const job = await repository.claimVerifiedFactEnrichmentJob();
  if (!job) return { claimed: false, saved: 0 };
  let saved = 0;
  try {
    for (const fact of job.facts) {
      // Use the original evidence time and captured technical revision on every
      // retry. A worker restart is not a fresh source verification.
      if (!fact.observedAt || !Number.isFinite(Date.parse(fact.observedAt)) || !fact.evidence?.trim() ||
        !fact.sourceUrl || !fact.sourceTier || !fact.sourceAuthority) throw new Error('invalid_enrichment_evidence');
      if (await repository.upsertVerifiedProductFact(fact)) saved += 1;
    }
    await repository.finishVerifiedFactEnrichmentJob(job);
    return { claimed: true, saved };
  } catch {
    // Do not log raw evidence or database connection errors with credentials.
    await repository.finishVerifiedFactEnrichmentJob(job, 'knowledge_enrichment_failed');
    return { claimed: true, saved, error: 'knowledge_enrichment_failed' };
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
