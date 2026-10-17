import pg from 'pg';
import { config } from '../config.js';
import { instrumentPostgresPool } from '../observability/postgresTiming.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000
});

instrumentPostgresPool(pool);

export async function closePool() {
  await pool.end();
}
