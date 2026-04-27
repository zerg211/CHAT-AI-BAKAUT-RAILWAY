import { syncCatalogFromSite } from '../catalog/crawler.js';
import { pool } from '../db/pool.js';

const maxPagesArg = process.argv.find((arg) => arg.startsWith('--max-pages='));
const maxPages = maxPagesArg ? Number(maxPagesArg.split('=')[1]) : undefined;
const startPathArg = process.argv.find((arg) => arg.startsWith('--start-path='));
const startPath = startPathArg ? startPathArg.split('=').slice(1).join('=') : undefined;

syncCatalogFromSite({ maxPages, startPath })
  .then(async (stats) => {
    console.log(JSON.stringify(stats, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
