import type { CheerioAPI } from 'cheerio';
import { cleanText } from './normalize.js';

/** Preserve document order and table/paragraph boundaries, including public footer facts. */
export function extractReadableSourceText($: CheerioAPI): string {
  const body = $('body').clone();
  body.find('script, style, noscript, svg, template').remove();
  body.find('td, th').append(' | ');
  body.find('p, div, section, article, header, footer, nav, li, tr, h1, h2, h3, h4, br').append('\n');
  return body.text().split('\n').map(line => cleanText(line)).filter(Boolean).join('\n');
}
