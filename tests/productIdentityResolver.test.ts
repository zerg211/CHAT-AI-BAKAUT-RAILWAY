import { describe, expect, it } from 'vitest';
import { extractEvidenceInput } from '../src/ai/evidenceInput.js';
import {
  bindEphemeralPageIdentity,
  resolveProductIdentity,
  type ExactProductLookup
} from '../src/ai/productIdentityResolver.js';
import type { Product } from '../src/shared/types.js';

const product = (id: string, name: string): Product => ({ id, name }) as Product;

function repo(overrides: Partial<ExactProductLookup> = {}): ExactProductLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getProductByExactExternalId: async (id: string) => {
      calls.push('external:' + id);
      return overrides.getProductByExactExternalId?.(id) ?? null;
    },
    getProductByExactArticle: async (article: string) => {
      calls.push('article:' + article);
      return overrides.getProductByExactArticle?.(article) ?? null;
    },
    getProductBySourceUrl: async (url: string) => {
      calls.push('url:' + url);
      return overrides.getProductBySourceUrl?.(url) ?? null;
    },
    findProductsByNormalizedModel: overrides.findProductsByNormalizedModel
  };
}

describe('product identity resolver', () => {
  it('resolves a numeric article to an exact hit without embeddings', async () => {
    const found = product('p1', 'Генератор Tecener TE6000GLIS');
    const r = repo({ getProductByExactArticle: async () => found });
    const resolution = await resolveProductIdentity(r, extractEvidenceInput('Нужен артикул 1110511'));
    expect(resolution.resolved).toMatchObject({ confidence: 'exact', selector: 'exact_article:1110511' });
    expect(resolution.resolved!.product).toBe(found);
    expect(resolution.attemptedSelectors).toEqual(['exact_article:1110511']);
  });

  it('tries external id, then article, then URL in fixed order', async () => {
    const r = repo();
    const resolution = await resolveProductIdentity(
      r,
      extractEvidenceInput('bakaut:gen_x 1110511 https://bakautprof.ru/catalog/gen_x/')
    );
    expect(resolution.resolved).toBeNull();
    expect(resolution.attemptedSelectors).toEqual([
      'exact_external_id:bakaut:gen_x',
      'exact_article:1110511',
      'exact_source_url:https://bakautprof.ru/catalog/gen_x'
    ]);
    expect(resolution.unmatchedFirstPartyUrls).toEqual(['https://bakautprof.ru/catalog/gen_x']);
  });

  it('resolves a canonical first-party URL exactly', async () => {
    const found = product('p2', 'Генератор X');
    const r = repo({ getProductBySourceUrl: async () => found });
    const resolution = await resolveProductIdentity(
      r,
      extractEvidenceInput('Вот карточка https://bakautprof.ru/catalog/gen_x/?roistat_visit=1')
    );
    expect(resolution.resolved).toMatchObject({ confidence: 'exact' });
    expect(resolution.resolved!.selector).toBe('exact_source_url:https://bakautprof.ru/catalog/gen_x');
  });

  it('reports model-code confidence without embeddings when lookup is injected', async () => {
    const r = repo({ findProductsByNormalizedModel: async () => [product('p3', 'Tecener TE6000GLIS')] });
    const single = await resolveProductIdentity(r, extractEvidenceInput('TE6000GLIS'));
    expect(single.resolved).toMatchObject({ confidence: 'strong', selector: 'normalized_model:TE6000GLIS' });
    const r2 = repo({
      findProductsByNormalizedModel: async () => [product('a', 'X'), product('b', 'Y')]
    });
    const multi = await resolveProductIdentity(r2, extractEvidenceInput('TE6000GLIS'));
    expect(multi.resolved).toMatchObject({ confidence: 'ambiguous' });
  });

  it('never resolves from text alone and records the fingerprint', async () => {
    const r = repo();
    const resolution = await resolveProductIdentity(r, extractEvidenceInput('привет'));
    expect(resolution.resolved).toBeNull();
    expect(resolution.evidenceFingerprint).toBe('');
    expect(r.calls).toEqual([]);
  });

  it('binds an ephemeral page identity only from a verified page read', () => {
    expect(bindEphemeralPageIdentity({ canonicalUrl: 'https://bakautprof.ru/catalog/x/', pageVerified: false })).toBeNull();
    expect(
      bindEphemeralPageIdentity({ canonicalUrl: 'https://bakautprof.ru/catalog/x/', pageVerified: true, title: 'Генератор X', article: '1110511' })
    ).toMatchObject({ status: 'page_verified', title: 'Генератор X', article: '1110511' });
  });

  it('evidence monotonicity: stronger evidence never lowers confidence', async () => {
    const found = product('p1', 'Генератор Tecener TE6000GLIS');
    const r = repo({
      getProductByExactArticle: async () => found,
      findProductsByNormalizedModel: async () => [found]
    });
    const rank = { exact: 3, strong: 2, preliminary: 1, ambiguous: 0 } as const;
    const weak = await resolveProductIdentity(r, extractEvidenceInput('TE6000GLIS'));
    const strong = await resolveProductIdentity(r, extractEvidenceInput('TE6000GLIS, артикул 1110511'));
    expect(rank[strong.resolved!.confidence]).toBeGreaterThanOrEqual(rank[weak.resolved!.confidence]);
  });
});
