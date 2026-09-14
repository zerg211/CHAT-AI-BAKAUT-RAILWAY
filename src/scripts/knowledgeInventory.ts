// Read-only deployment inventory. Deliberately emits counts/configuration, never rows or credentials.
import { config } from '../config.js';
import { pool } from '../db/pool.js';

async function inventory() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='8s'");
    const migrations = (await client.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(row => row.filename);
    const columns = (await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('products','catalog_pages','verified_fact_enrichment_jobs')")).rows;
    const has = (table: string, column: string) => columns.some(row => row.table_name === table && row.column_name === column);
    const pages = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE is_active IS FALSE)::int AS inactive,
      count(*) FILTER(WHERE embedding IS NOT NULL)::int AS embedded,
      count(*) FILTER(WHERE embedding IS NOT NULL AND ${has('catalog_pages','embedding_source_revision') ? 'embedding_source_revision IS DISTINCT FROM source_content_hash' : 'true'})::int AS unbound_vectors
      FROM catalog_pages`)).rows[0];
    const products = (await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE is_active IS FALSE)::int AS inactive,
      count(*) FILTER(WHERE price IS NOT NULL AND ${has('products','price_observed_at') ? 'price_observed_at IS NULL' : 'true'})::int AS unordered_prices,
      count(*) FILTER(WHERE price_verified_at IS NOT NULL AND (price IS NULL OR price_source_url IS NULL))::int AS incomplete_price_proof,
      count(*) FILTER(WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1)::int AS other_model_vectors
      FROM products`, [config.OPENAI_EMBEDDING_MODEL])).rows[0];
    const queues = (await client.query('SELECT status,count(*)::int AS count FROM verified_fact_enrichment_jobs GROUP BY status ORDER BY status')).rows;
    const facts = (await client.query('SELECT status,count(*)::int AS count FROM verified_product_facts GROUP BY status ORDER BY status')).rows;
    await client.query('COMMIT');
    return { readOnly: true, schema: migrations, products, pages, queues, facts,
      configuration: { answerModel: config.OPENAI_ANSWER_MODEL, plannerModel: config.OPENAI_PLANNER_MODEL,
        factModel: config.OPENAI_FACT_MODEL, embeddingModel: config.OPENAI_EMBEDDING_MODEL,
        reasoning: config.OPENAI_ANSWER_REASONING_EFFORT, sourceOrigin: new URL(config.CATALOG_BASE_URL).origin,
        webExtraction: config.OPENAI_ENABLE_WEB_FACT_EXTRACTION, usageGuard: config.OPENAI_USAGE_GUARD_ENABLED,
        dailyTokenBudget: config.OPENAI_DAILY_TOKEN_BUDGET, openaiConfigured: Boolean(config.OPENAI_API_KEY),
        emailHttpConfigured: Boolean(config.EMAIL_HTTP_URL && config.EMAIL_FROM && config.LEADS_TO_EMAIL) } };
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}

inventory().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(JSON.stringify({ status: 'UNAVAILABLE', errorCode: typeof error?.code === 'string' ? error.code : 'inventory_failed' }));
  process.exitCode = 1;
}).finally(() => pool.end());
