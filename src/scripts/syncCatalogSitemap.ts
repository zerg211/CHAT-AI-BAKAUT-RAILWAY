import { syncCatalogFromSitemap } from '../catalog/sitemapSync.js';
import { pool } from '../db/pool.js';

function numberArg(name: string) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  return arg ? Number(arg.split('=').slice(1).join('=')) : undefined;
}

function stringArg(name: string) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : undefined;
}

const maxProducts = numberArg('--max-products');
const maxContentPages = numberArg('--max-content-pages');
const concurrency = numberArg('--concurrency');
const requestDelayMs = numberArg('--request-delay-ms');
const sitemapUrl = stringArg('--sitemap-url');
const onlyUrl = stringArg('--only-url');
const includeEmbeddings = process.argv.includes('--with-embeddings');
const includeProducts = !process.argv.includes('--content-only');
const includeContent = !process.argv.includes('--products-only');

syncCatalogFromSitemap({
  sitemapUrl,
  maxProducts,
  maxContentPages,
  concurrency,
  requestDelayMs,
  includeEmbeddings,
  includeProducts,
  includeContent,
  onlyUrls: onlyUrl ? [onlyUrl] : undefined,
  onProgress: (message) => console.log(`[catalog] ${message}`)
})
  .then(async (stats) => {
    console.log(JSON.stringify(stats, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
