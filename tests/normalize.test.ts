import { describe, expect, it } from 'vitest';
import { absoluteUrl, normalizeCsvHeader, normalizeSpecKey, parsePrice, slugFromUrl } from '../src/catalog/normalize.js';

describe('catalog normalization', () => {
  it('normalizes urls and slugs', () => {
    const url = absoluteUrl('/catalog/vibroplity/test/', 'https://bakautprof.ru/base/');
    expect(url).toBe('https://bakautprof.ru/catalog/vibroplity/test/');
    expect(slugFromUrl(url)).toBe('catalog/vibroplity/test');
  });

  it('parses Russian price text', () => {
    expect(parsePrice('123 456 руб.')).toBe(123456);
  });

  it('normalizes CSV and spec keys', () => {
    expect(normalizeCsvHeader(' Артикул товара ')).toBe('артикул_товара');
    expect(normalizeSpecKey(' Мощность двигателя: ')).toBe('мощность двигателя');
  });
});
