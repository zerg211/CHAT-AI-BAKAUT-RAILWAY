import { buildEmbeddingCoverageReport } from '../ai/embeddingCoverage.js';
import { pool } from '../db/pool.js';

buildEmbeddingCoverageReport()
  .then(async (report) => {
    console.log(JSON.stringify(report, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
