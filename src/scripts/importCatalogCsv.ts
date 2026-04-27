import { importCatalogCsv } from '../catalog/csvImport.js';
import { pool } from '../db/pool.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: npm run catalog:import -- ./catalog.csv');
  process.exit(1);
}

importCatalogCsv(filePath)
  .then(async (stats) => {
    console.log(JSON.stringify(stats, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
