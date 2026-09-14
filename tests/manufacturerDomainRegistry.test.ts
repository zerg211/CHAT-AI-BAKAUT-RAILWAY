import { describe, expect, it } from 'vitest';
import { classifyProductResearchSource } from '../src/ai/productComparisonResearch.js';

describe('manufacturer domain authority registry', () => {
  it('classifies Fubag exact host and subdomains as manufacturer pages', () => {
    for (const sourceUrl of ['https://fubag.group/product/bs-8000-a-es/', 'https://shop.fubag.group/product/x']) {
      expect(classifyProductResearchSource({ sourceUrl, product: { brand: 'Fubag', name: 'Fubag BS 8000' } }))
        .toMatchObject({ authority: 'manufacturer', tier: 'official_page' });
    }
  });

  it('does not trust a lookalike suffix', () => {
    expect(classifyProductResearchSource({ sourceUrl: 'https://fubag.group.example/product/x', product: { brand: 'Fubag', name: 'Fubag BS 8000' } }))
      .toMatchObject({ authority: 'secondary', tier: 'reliable_secondary' });
  });
});
