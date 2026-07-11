import { ProductRepository } from '../db/repositories.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

function staleHoursArg(argv: string[]) {
  const prefix = '--stale-after-hours=';
  const value = argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return config.CATALOG_STALE_AFTER_HOURS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24 * 30) {
    throw new Error('invalid_stale_after_hours');
  }
  return parsed;
}

async function main() {
  const report = await new ProductRepository().getCatalogFreshness(staleHoursArg(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'fresh') process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
