import { describe, expect, it } from 'vitest';
import type { Product } from '../src/shared/types.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import { revalidateReviewerRewrite } from '../src/ai/agentManagerRevisedAnswerGuard.js';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'tss-5000a',
    name: 'TSS SGG 5000A',
    brand: 'TSS',
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    specs: {
      power: '5 kW',
      voltage: '220 V',
      weight: '80 kg'
    },
    ...overrides
  };
}

function catalogResult(item: Product): ToolResult {
  return {
    requestId: 'catalog-search',
    tool: 'catalog.search',
    status: 'ok',
    payload: { productIds: [item.id], products: [item] },
    warnings: []
  };
}

function review(text: string, overrides: Partial<Parameters<typeof revalidateReviewerRewrite>[0]> = {}) {
  const item = product();
  return revalidateReviewerRewrite({
    revisedAnswerText: text,
    userMessage: 'Назовите точную цену и мощность TSS SGG 5000A.',
    products: [item],
    toolResults: [catalogResult(item)],
    durableLeadCaptureSucceeded: false,
    ...overrides
  });
}

describe('reviewer revisedAnswerText deterministic guard', () => {
  it('accepts product identifiers, price, and specifications grounded in successful catalog artifacts', () => {
    expect(review('TSS SGG 5000A стоит 1 000 ₽; мощность — 5 kW, напряжение — 220 V, масса — 80 kg.')).toEqual([]);
  });

  it('blocks a product identifier introduced by the reviewer without tool evidence', () => {
    expect(review('Вместо него берите TSS SGG 7000B.').map((issue) => issue.code))
      .toContain('review_rewrite_unsupported_product_identifier');
  });

  it('blocks revised price and specification numbers that disagree with the product artifact', () => {
    const issues = review('TSS SGG 5000A стоит 99 999 ₽; мощность — 9 kW.');

    expect(issues.map((issue) => issue.code)).toContain('review_rewrite_unsupported_numeric_product_claim');
    expect(issues.find((issue) => issue.code === 'review_rewrite_unsupported_numeric_product_claim')?.evidence)
      .toContain('99 999 ₽');
    expect(issues.find((issue) => issue.code === 'review_rewrite_unsupported_numeric_product_claim')?.evidence)
      .toContain('9 kW');
  });

  it('does not mistake quantities or calculated requirements for product price/spec claims', () => {
    expect(review('Покажу 2 модели с ценами. По расчету требуется 6 kW; конкретную модель подберу после проверки нагрузки.'))
      .toEqual([]);
  });

  it('accepts a numeric technical fact confirmed by a successful web research artifact', () => {
    const item = product({ id: 'bison-9000', name: 'BISON BS9000', price: null, specs: {} });
    const webResult: ToolResult = {
      requestId: 'web-thd',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        facts: [{
          productName: 'BISON BS9000',
          attribute: 'THD',
          value: '5 %',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'manufacturer manual'
        }]
      },
      warnings: []
    };

    expect(review('Для BISON BS9000 подтвержден THD 5 %.', {
      userMessage: 'Какой THD у BISON BS9000?',
      products: [item],
      toolResults: [webResult]
    })).toEqual([]);
  });

  it('blocks a claimed handoff unless durable lead and outbox capture succeeded', () => {
    expect(review('Контакт получен, запрос передан техническому специалисту.').map((issue) => issue.code))
      .toContain('review_rewrite_false_lead_confirmation');

    expect(review('Контакт получен, запрос передан техническому специалисту.', {
      durableLeadCaptureSucceeded: true
    }).map((issue) => issue.code)).not.toContain('review_rewrite_false_lead_confirmation');
  });

  it('blocks unconditional stock, delivery, and discount promises but allows truthful verification language', () => {
    const unsafe = review('Товар есть в наличии. Доставка есть, и мы дадим скидку 10 %.');
    expect(unsafe.map((issue) => issue.code)).toContain('review_rewrite_forbidden_commercial_promise');

    expect(review('Товар не в наличии.').map((issue) => issue.code))
      .toContain('review_rewrite_forbidden_commercial_promise');

    expect(review('Точное наличие, условия доставки и скидку нужно проверить для конкретного заказа.'))
      .toEqual([]);

    expect(review('Доставка есть. Назовите город и товар — сориентирую по условиям.'))
      .toEqual([]);
  });
});
