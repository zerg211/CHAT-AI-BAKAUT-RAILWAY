import pg from 'pg';

const connectionString = process.env.DATABASE_PUBLIC_URL;
if (!connectionString) throw new Error('DATABASE_PUBLIC_URL is required');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const column = await client.query(`
    SELECT column_name, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'verified_product_facts'
      AND column_name = 'evidence_verified_exact'
  `);
  const counts = await client.query(`
    SELECT evidence_verified_exact, count(*)::int AS count
    FROM verified_product_facts
    GROUP BY evidence_verified_exact
    ORDER BY evidence_verified_exact
  `);
  console.log(JSON.stringify({ column: column.rows, counts: counts.rows }));
} finally {
  await client.end();
}
