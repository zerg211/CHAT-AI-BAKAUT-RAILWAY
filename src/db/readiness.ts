import pg from 'pg';

/** One bounded, shared dependency probe per app instance. Never calls a model. */
export function createReadinessProbe(connectionString: string, capabilitiesReady: () => boolean) {
  const db = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 5000, query_timeout: 1500, statement_timeout: 1500 });
  let inFlight: Promise<boolean> | undefined;
  let cached: { ready: boolean; until: number } | undefined;
  let stopped = false;
  return {
    check(): Promise<boolean> {
      if (stopped || !capabilitiesReady()) return Promise.resolve(false);
      if (cached && cached.until > Date.now()) return Promise.resolve(cached.ready);
      if (inFlight) return inFlight;
      inFlight = db.query(`SELECT
        (SELECT count(*)=5 FROM schema_migrations WHERE filename IN
          ('039_catalog_page_embedding_revision.sql','040_enrichment_item_outcomes.sql','041_price_writer_coherence.sql','042_company_page_publication.sql','043_optional_lead_name.sql'))
        AND to_regclass('public.conversation_turns') IS NOT NULL
        AND to_regclass('public.lead_outbox') IS NOT NULL
        AND to_regclass('public.verified_fact_enrichment_jobs') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='catalog_pages' AND column_name='embedding_source_revision')
        AND EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='verified_fact_enrichment_jobs' AND column_name='item_outcomes')
        AND EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='verified_fact_enrichment_jobs' AND column_name='page_payload')
        AND EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='catalog_pages' AND column_name='source_observed_at')
        AND EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='leads' AND column_name='name' AND is_nullable='YES')
        AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public'
          AND table_name='products' AND column_name IN ('price_observed_at','price_on_request','price_observation_source_type'))
        AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid=to_regclass('public.products')
          AND tgname IN ('a_product_price_observation','product_price_fact_mirror') AND tgenabled IN ('O','A')) AS ready`)
        .then(result => result.rows[0]?.ready === true)
        .catch(() => false)
        .then(ready => { cached = { ready, until: Date.now() + 2000 }; return ready; })
        .finally(() => { inFlight = undefined; });
      return inFlight;
    },
    async close() { stopped = true; await inFlight; await db.end(); }
  };
}
