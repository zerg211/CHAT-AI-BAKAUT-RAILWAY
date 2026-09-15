import pg from 'pg';

const turnId = process.argv.at(-1);
if (!turnId) throw new Error('turn id is required');
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('production database URL is unavailable');
const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('rlwy.net') ? { rejectUnauthorized: false } : undefined
});
await client.connect();
try {
  const answers = await client.query(
    `SELECT answer_text, contract, review, status, created_at
       FROM answer_contracts
      WHERE turn_id = $1
      ORDER BY created_at`,
    [turnId]
  );
  const tools = await client.query(
    `SELECT tool_name, tool_request_id, status, payload, warnings, error_code, created_at
       FROM tool_artifacts
      WHERE turn_id = $1
      ORDER BY created_at`,
    [turnId]
  );
  const checkpoints = await client.query(
    `SELECT checkpoint, status, payload, error_code, error_message, created_at, updated_at
       FROM turn_checkpoints
      WHERE turn_id = $1
      ORDER BY created_at`,
    [turnId]
  );
  process.stdout.write(JSON.stringify({ answers: answers.rows, tools: tools.rows, checkpoints: checkpoints.rows }, null, 2));
} finally {
  await client.end();
}
