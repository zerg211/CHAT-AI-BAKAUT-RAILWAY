import { describe, expect, it } from 'vitest';
import { AssistantService, assistantTestHooks } from '../src/ai/assistant.js';
import { emptyNeedState, heuristicNeedUpdate, mergeNeedState } from '../src/ai/needState.js';

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function product(id: string, name: string, price: number, sourceUrl: string) {
  return {
    id,
    name,
    category: name,
    sourceUrl,
    price,
    specs: {}
  };
}

function productWithSpecs(id: string, name: string, price: number, sourceUrl: string, specs: Record<string, unknown>) {
  return {
    id,
    name,
    category: name,
    sourceUrl,
    price,
    specs
  };
}

function brandedProduct(id: string, name: string, brand: string, category: string, price: number, sourceUrl: string) {
  return {
    id,
    name,
    brand,
    category,
    sourceUrl,
    price,
    specs: {}
  };
}

class FakeProducts {
  constructor(private readonly products: ReturnType<typeof product>[]) {}

  async searchProducts() {
    return this.products;
  }

  async searchProductsByModelTokens() {
    return this.products;
  }

  async vectorSearch() {
    return [];
  }
}

async function rank(message: string, products: ReturnType<typeof product>[]) {
  const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
  const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
  return {
    state,
    ranked: await assistant.findProducts(message, state)
  };
}

describe('recommendation ranking', () => {
  it('promotes portable plate compactors for any portability wording, not one fixed phrase', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0434\\u0430\\u0447\\u0438, \\u0431\\u0443\\u0434\\u0443 \\u043e\\u0434\\u0438\\u043d \\u0442\\u0430\\u0441\\u043a\\u0430\\u0442\\u044c \\u0440\\u0443\\u043a\\u0430\\u043c\\u0438, \\u043d\\u0443\\u0436\\u043d\\u0430 \\u043d\\u0435 \\u0442\\u044f\\u0436\\u0435\\u043b\\u0430\\u044f \\u0438 \\u043a\\u043e\\u043c\\u043f\\u0430\\u043a\\u0442\\u043d\\u0430\\u044f');
    const { ranked } = await rank(message, [
      product('heavy', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0440\\u0435\\u0432\\u0435\\u0440\\u0441\\u0438\\u0432\\u043d\\u0430\\u044f \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u0430\\u044f Wacker Neuson DPU 90 Lec 770 (771 \\u043a\\u0433)'), 2644950, 'https://example.test/catalog/vibroplity/heavy/'),
      product('light', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f Wacker Neuson BPS 1340 A (67 \\u043a\\u0433)'), 258250, 'https://example.test/catalog/vibroplity/light/')
    ]);

    expect(ranked[0].id).toBe('light');
  });

  it('uses inferred feature signals when the buyer implies portability without saying weight words', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430. \\u0411\\u0443\\u0434\\u0443 \\u0431\\u0440\\u0430\\u0442\\u044c \\u0441 \\u0441\\u043e\\u0431\\u043e\\u0439 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443');
    const { ranked, state } = await rank(message, [
      product('heavy', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0440\\u0435\\u0432\\u0435\\u0440\\u0441\\u0438\\u0432\\u043d\\u0430\\u044f \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u0430\\u044f (771 \\u043a\\u0433)'), 2644950, 'https://example.test/catalog/vibroplity/heavy/'),
      product('light', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f (67 \\u043a\\u0433)'), 258250, 'https://example.test/catalog/vibroplity/light/')
    ]);

    expect(state.featureSignals.portable).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('light');
  });

  it('promotes inverter generators for low-noise home use', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430, \\u0447\\u0442\\u043e\\u0431\\u044b \\u043d\\u043e\\u0447\\u044c\\u044e \\u043d\\u0435 \\u043c\\u0435\\u0448\\u0430\\u043b \\u0441\\u043e\\u0441\\u0435\\u0434\\u044f\\u043c');
    const { ranked, state } = await rank(message, [
      product('industrial', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043e\\u0442\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439 30 \\u043a\\u0412\\u0442'), 700000, 'https://example.test/catalog/dizelnye_generatory/industrial/'),
      product('quiet', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0439 Honda EU 10 iT1 0,9 \\u043a\\u0412\\u0442'), 150000, 'https://example.test/catalog/invertornye_generatory/quiet/')
    ]);

    expect(state.featureSignals.lowNoise).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('quiet');
  });

  it('promotes duty-grade equipment for daily crew work', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0442\\u0435\\u0445\\u043d\\u0438\\u043a\\u0430 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b, \\u0440\\u0430\\u0431\\u043e\\u0442\\u0430\\u0442\\u044c \\u0431\\u0443\\u0434\\u0435\\u0442 \\u043a\\u0430\\u0436\\u0434\\u044b\\u0439 \\u0434\\u0435\\u043d\\u044c');
    const { ranked, state } = await rank(message, [
      product('consumer', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0431\\u044b\\u0442\\u043e\\u0432\\u043e\\u0439 2 \\u043a\\u0412\\u0442'), 45000, 'https://example.test/catalog/benzinovye_generatory/consumer/'),
      product('pro', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b\\u0435\\u043d\\u043d\\u044b\\u0439 12 \\u043a\\u0412\\u0442'), 240000, 'https://example.test/catalog/dizelnye_generatory/pro/')
    ]);

    expect(state.featureSignals.professionalDuty).toBeGreaterThan(0.8);
    expect(ranked[0].id).toBe('pro');
  });

  it('promotes lower priced options when budget sensitivity is the need', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0442\\u0435\\u0445\\u043d\\u0438\\u043a\\u0430 \\u043d\\u0435\\u0434\\u043e\\u0440\\u043e\\u0433\\u0430\\u044f, \\u0431\\u044e\\u0434\\u0436\\u0435\\u0442 \\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0447\\u0435\\u043d');
    const { ranked, state } = await rank(message, [
      product('expensive', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u043e\\u0444\\u0435\\u0441\\u0441\\u0438\\u043e\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f 120 \\u043a\\u0433'), 300000, 'https://example.test/catalog/vibroplity/expensive/'),
      product('budget', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f 60 \\u043a\\u0433'), 55000, 'https://example.test/catalog/vibroplity/budget/')
    ]);

    expect(state.featureSignals.budgetSensitive).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('budget');
  });

  it('reduces stale inferred needs after the buyer changes the task', async () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430. \\u0411\\u0443\\u0434\\u0443 \\u0431\\u0440\\u0430\\u0442\\u044c \\u0441 \\u0441\\u043e\\u0431\\u043e\\u0439 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443');
    const nextMessage = ru('\\u0422\\u0435\\u043f\\u0435\\u0440\\u044c \\u043d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b, \\u0440\\u0430\\u0431\\u043e\\u0442\\u0430\\u0442\\u044c \\u0431\\u0443\\u0434\\u0435\\u0442 \\u043a\\u0430\\u0436\\u0434\\u044b\\u0439 \\u0434\\u0435\\u043d\\u044c');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('old-plate', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f 67 \\u043a\\u0433'), 258250, 'https://example.test/catalog/vibroplity/light/'),
      product('new-generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b\\u0435\\u043d\\u043d\\u044b\\u0439 12 \\u043a\\u0412\\u0442'), 240000, 'https://example.test/catalog/dizelnye_generatory/pro/')
    ]) as never);
    const ranked = await assistant.findProducts(nextMessage, state);

    expect(state.featureSignals.portable).toBeLessThan(0.45);
    expect(state.featureSignals.professionalDuty).toBeGreaterThan(0.8);
    expect(ranked[0].id).toBe('new-generator');
  });

  it('prioritizes an exact model code over accessories from the same broad category', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0422\\u0421\\u0421 \\u0410\\u0414-16\\u0421-\\u0422400-1\\u0420\\u041a\\u041c5, \\u0440\\u0430\\u0441\\u0441\\u043a\\u0430\\u0436\\u0438 \\u0445\\u0430\\u0440\\u0430\\u043a\\u0442\\u0435\\u0440\\u0438\\u0441\\u0442\\u0438\\u043a\\u0438');
    const { ranked } = await rank(message, [
      product('accessory', ru('\\u0421\\u0438\\u0441\\u0442\\u0435\\u043c\\u0430 \\u044d\\u043b.\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432\\u0430 \\u0431\\u043b\\u043e\\u043a\\u0430 \\u0434\\u0432\\u0438\\u0433\\u0430\\u0442\\u0435\\u043b\\u044f 20-230 \\u043a\\u0412\\u0442 \\u0422\\u0421\\u0421'), 22299, 'https://example.test/catalog/raskhodniki/sistema-generator/'),
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u0422\\u0421\\u0421 \\u0410\\u0414-16\\u0421-\\u0422400-1\\u0420\\u041a\\u041c5 (16,0 \\u043a\\u0412\\u0442) 040441'), 502200, 'https://example.test/catalog/dizelnye_generatory/generator_tss_ad_16s_t400_1rkm5/')
    ]);

    expect(ranked[0].id).toBe('generator');
  });

  it('filters accessories, trowels, and oversized diesel units from a gasoline 5-6 kW generator request', async () => {
    const message = 'Покажите бензиновый генератор 5-6 кВт однофазный 220 В с электростартером для дачи';
    const { ranked } = await rank(message, [
      product('cover', 'Кожух всепогодный/шумозащитный до 9 кВт', 129000, 'https://example.test/catalog/kozhukhi_dlya_generatora/cover/'),
      product('trowel', 'Машина затирочная бензиновая STEM Techno SPT 242', 64000, 'https://example.test/catalog/zatirochnye_mashiny/trowel/'),
      product('diesel16', 'Генератор дизельный ТСС АД-16С-Т400-1РКМ5 (16,0 кВт)', 502200, 'https://example.test/catalog/dizelnye_generatory/diesel16/'),
      productWithSpecs('gas6', 'Генератор бензиновый ТСС SGG 6000EHNA (6,0 кВт)', 67498, 'https://example.test/catalog/benzinovye_generatory/sgg_6000ehna/', { 'тип запуска': 'ручной/электростартер' })
    ]);

    expect(ranked.map((item) => item.id)).toEqual(['gas6']);
  });

  it('recognizes spaced model codes such as SGG 6000EHNA', async () => {
    const message = 'Мне нужен ТСС SGG 6000EHNA, сравните обычный и DUPLEX';
    const { ranked } = await rank(message, [
      product('accessory', 'Система эл.подогрева блока двигателя 20-230 кВт ТСС', 22299, 'https://example.test/catalog/raskhodniki/heater/'),
      product('generator', 'Генератор бензиновый ТСС SGG 6000EHNA (6,0 кВт) 160010', 67498, 'https://example.test/catalog/benzinovye_generatory/sgg_6000ehna/')
    ]);

    expect(ranked[0].id).toBe('generator');
  });

  it('does not fall back to random cards when the plan selected no products', () => {
    const message = 'Нужен генератор для дачи, пока не понимаю какой';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('diesel16', 'Генератор дизельный ТСС АД-16С-Т400-1РКМ5 (16,0 кВт)', 502200, 'https://example.test/catalog/dizelnye_generatory/diesel16/'),
      product('trowel', 'Машина затирочная электрическая STEM Techno SPT 24', 68000, 'https://example.test/catalog/zatirochnye_mashiny/trowel/')
    ], state, message, {
      action: 'ask_clarifying_question',
      catalogSearchQuery: 'генератор бензиновый однофазный 220В 3-5 кВт для дачи',
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: ['мощность насоса'],
      answerGuidance: 'ask first'
    } as any);

    expect(cards).toEqual([]);
  });

  it('keeps selected cards and fills a wider relevant product set', () => {
    const message = 'generator benzin 5-6 kw 220 for dacha';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = Array.from({ length: 6 }, (_, index) => {
      const kw = index % 2 === 0 ? '6,0' : '5,0';
      return productWithSpecs(
        `gas-${index + 1}`,
        `Generator benzin AP${index + 1} (${kw} kw)`,
        50_000 + index * 1000,
        `https://example.test/catalog/benzinovye_generatory/gas-${index + 1}/`,
        { start: 'manual/electric starter' }
      );
    });

    const cards = assistantTestHooks.cardsFromPlan(products, state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: ['gas-2', 'gas-1'],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards).toHaveLength(6);
    expect(cards.slice(0, 2).map((card) => card.id)).toEqual(['gas-1', 'gas-2']);
  });

  it('caps product cards at a manageable wide choice', () => {
    const message = 'generator benzin 5-6 kw 220 for dacha';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = Array.from({ length: 12 }, (_, index) => productWithSpecs(
      `gas-${index + 1}`,
      `Generator benzin AP${index + 1} (${index % 2 === 0 ? '6,0' : '5,0'} kw)`,
      50_000 + index * 1000,
      `https://example.test/catalog/benzinovye_generatory/gas-${index + 1}/`,
      { start: 'manual/electric starter' }
    ));

    const cards = assistantTestHooks.cardsFromPlan(products, state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards).toHaveLength(10);
  });

  it('keeps products over explicit budget out of the wider card set', () => {
    const message = 'Нужен бензиновый генератор 5-6 кВт до 90 тысяч';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('within', 'Генератор бензиновый A-iPower 6,0 кВт', 80_000, 'https://example.test/catalog/benzinovye_generatory/within/', { start: 'электростартер' }),
      productWithSpecs('over', 'Генератор бензиновый EUROPOWER 5,4 кВт', 179_990, 'https://example.test/catalog/benzinovye_generatory/over/', { start: 'электростартер' })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['within']);
  });

  it('treats electric start as a required need, not only a ranking bonus', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 5-6 \\u043a\\u0412\\u0442 220 \\u0412 \\u0441 \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440\\u043e\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('manual', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower LITE AP5500 (5,0 \\u043a\\u0412\\u0442)'), 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439') }),
      productWithSpecs('electric', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower LITE AP5500E (5,0 \\u043a\\u0412\\u0442)'), 55990, 'https://example.test/catalog/benzinovye_generatory/ap5500e/', { start: ru('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['electric']);
  });

  it('uses planner semantic traits as the main source for electric-start filtering', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 220 \\u0412. \\u0411\\u0443\\u0434\\u0435\\u0442 \\u043f\\u043e\\u0436\\u0438\\u043b\\u043e\\u0439 \\u0447\\u0435\\u043b\\u043e\\u0432\\u0435\\u043a, \\u043d\\u0443\\u0436\\u043d\\u043e \\u0447\\u0442\\u043e\\u0431\\u044b \\u0437\\u0430\\u0432\\u0435\\u0441\\u0442\\u0438 \\u0431\\u0435\\u0437 \\u0440\\u044b\\u0432\\u043a\\u0430 \\u0437\\u0430 \\u0448\\u043d\\u0443\\u0440');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('manual', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower AP5500 (5,0 \\u043a\\u0412\\u0442)'), 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439') }),
      productWithSpecs('electric', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 DAEWOO GDA 6500E (5,5 \\u043a\\u0412\\u0442)'), 67990, 'https://example.test/catalog/benzinovye_generatory/gda6500e/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439/\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: ru('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 220 \\u0412 \\u0443\\u0434\\u043e\\u0431\\u043d\\u044b\\u0439 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a'),
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generator',
        fuel: 'gasoline',
        startType: 'electric',
        conventionalGenerator: null,
        singlePhase220: true,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ru('\\u041f\\u043b\\u0430\\u043d\\u0438\\u0440\\u043e\\u0432\\u0449\\u0438\\u043a \\u043f\\u043e \\u0441\\u043c\\u044b\\u0441\\u043b\\u0443 \\u043f\\u043e\\u043d\\u044f\\u043b, \\u0447\\u0442\\u043e \\u043d\\u0443\\u0436\\u0435\\u043d \\u043b\\u0435\\u0433\\u043a\\u0438\\u0439 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a.')
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['electric']);
  });

  it('does not oversize a generator for pump, refrigerator, and lights', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443: \\u043d\\u0430\\u0441\\u043e\\u0441 900 \\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442. \\u0417\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430\\u0442\\u044c \\u043c\\u043e\\u0433\\u0443 \\u043f\\u043e \\u043e\\u0447\\u0435\\u0440\\u0435\\u0434\\u0438');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('right', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 Honda 3200 (3,2 \\u043a\\u0412\\u0442)'), 62000, 'https://example.test/catalog/benzinovye_generatory/honda3200/', { 'Максимальная мощность': ru('3,8 \\u043a\\u0412\\u0442') }),
      productWithSpecs('oversized', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 BigPower 6000 (6,0 \\u043a\\u0412\\u0442)'), 76000, 'https://example.test/catalog/benzinovye_generatory/big6000/', { 'Максимальная мощность': ru('6,5 \\u043a\\u0412\\u0442') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['right']);
  });

  it('uses the current product task when the buyer switches from generator to plate', () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u0430\\u0447\\u0438');
    const nextMessage = ru('\\u0422\\u0435\\u043f\\u0435\\u0440\\u044c \\u0434\\u0440\\u0443\\u0433\\u0430\\u044f \\u0437\\u0430\\u0434\\u0430\\u0447\\u0430: \\u043d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/'),
      product('plate', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f 90 \\u043a\\u0433'), 110000, 'https://example.test/catalog/vibroplity/plate/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: nextMessage,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['plate']);
  });

  it('does not show generators for a diamond blade request after generator context', () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440');
    const nextMessage = ru('\\u042f \\u043f\\u043b\\u0438\\u0442\\u043e\\u0447\\u043d\\u0438\\u043a, \\u043d\\u0443\\u0436\\u0435\\u043d \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 250 \\u043c\\u043c \\u0434\\u043b\\u044f \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0430');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/'),
      product('blade', ru('\\u0414\\u0438\\u0441\\u043a \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 250 \\u043c\\u043c \\u043f\\u043e \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0443'), 4500, 'https://example.test/catalog/almaznye_diski/blade/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: nextMessage,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['blade']);
  });

  it('does not treat a 350-400 mm cutter blade range as a MAGNUS 350/400 generator model', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u043f\\u043e\\u0434 \\u0434\\u0438\\u0441\\u043a 350-400 \\u043c\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('magnus', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 MAGNUS 350/400 FA (350,0 \\u043a\\u0412\\u0442)'), 2470000, 'https://example.test/catalog/dizelnye_generatory/magnus_350_400/'),
      product('cutter', ru('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 400 \\u043c\\u043c'), 180000, 'https://example.test/catalog/shvonarezchiki/cutter/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cutter']);
  });

  it('does not show consumables or blades as cutter cards', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u043f\\u043e\\u0434 \\u0434\\u0438\\u0441\\u043a 350-400 \\u043c\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('filter', ru('\\u0424\\u0438\\u043b\\u044c\\u0442\\u0440 \\u0432\\u043e\\u0437\\u0434\\u0443\\u0448\\u043d\\u044b\\u0439 \\u0434\\u043b\\u044f \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0430 MFS 735'), 950, 'https://example.test/catalog/raskhodniki/filter/'),
      product('blade', ru('\\u0414\\u0438\\u0441\\u043a \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u043b\\u044f \\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0430 Husqvarna'), 24300, 'https://example.test/catalog/almaznye_diski/blade/'),
      product('cutter', ru('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 Wacker Neuson MFS 735 CE'), 230000, 'https://example.test/catalog/rezchiki/cutter/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cutter']);
  });

  it('records when fallback was suppressed because no relevant cards survived filtering', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 250 \\u043c\\u043c \\u0434\\u043b\\u044f \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0430');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const selection = assistantTestHooks.selectCardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(selection.cards).toEqual([]);
    expect(selection.diagnostics.fallbackSuppressed).toBe(true);
    expect(selection.diagnostics.fallbackReason).toBe('no_relevant_cards_after_current_need_filters');
  });

  it('keeps a strict brand request from being filled with other brands', () => {
    const message = 'Есть у вас генератор BISON на 5-6 кВт?';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('bison-1', 'Генератор бензиновый BISON BS6500EP (5,0 кВт)', 'BISON', 'Бензиновые генераторы', 51500, 'https://example.test/catalog/benzinovye_generatory/bison6500/'),
      brandedProduct('bison-2', 'Генератор бензиновый инверторный BISON BS6250IE (5,0 кВт)', 'BISON', 'Инверторные генераторы', 61100, 'https://example.test/catalog/invertornye_generatory/bison6250/'),
      brandedProduct('aipower', 'Генератор бензиновый A-iPower LITE AP5500 (5,0 кВт)', 'A-iPower', 'Бензиновые генераторы', 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/'),
      brandedProduct('champion', 'Генератор бензиновый CHAMPION GG5000 (5,0 кВт)', 'Champion', 'Бензиновые генераторы', 50190, 'https://example.test/catalog/benzinovye_generatory/gg5000/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['bison-1', 'bison-2']);
  });

  it('switches from a known generator model to generator oil cards on an accessory follow-up', () => {
    const firstMessage = 'Интересует инверторный генератор BISON BS6250IE';
    const nextMessage = 'А масло есть для таких генераторов?';
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('generator', 'Генератор бензиновый инверторный BISON BS6250IE (5,0 кВт)', 'BISON', 'Инверторные генераторы', 61100, 'https://example.test/catalog/invertornye_generatory/bison6250/'),
      brandedProduct('oil-1', 'Масло для генератора Teboil Silver SN 10W-40 1 л', 'Teboil', 'Масло для генератора', 650, 'https://example.test/catalog/maslo_dlya_generatora/teboil-1/'),
      brandedProduct('oil-4', 'Масло для генератора TSS SAE 10W-40 4 л', 'TSS', 'Масло для генератора', 1800, 'https://example.test/catalog/maslo_dlya_generatora/tss-4/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: `${nextMessage} ${firstMessage}`,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend oil'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1', 'oil-4']);
  });

  it('switches from a known plate model to suitable four-stroke engine oil cards', () => {
    const firstMessage = 'Интересует виброплита CHAMPION PC5332F';
    const nextMessage = 'А масло для нее у вас есть?';
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 52900, 'https://bakautprof.ru/catalog/vibroplity/champion_pc5332f/'),
      brandedProduct('oil-1', 'Масло моторное TEBOIL Silver SN 10W-40 канистра 1 л', 'Teboil', 'Масло для генератора', 640, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/teboil-1/'),
      brandedProduct('oil-4', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 4л', 'TSS', 'Масло для генератора', 1136, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/tss-4/'),
      brandedProduct('oil-15w', 'Масло минеральное ТСС Стандарт SAE 15W40 CF-4 канистра 5л', 'TSS', 'Масло для генератора', 1415, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/tss-15w40/'),
      brandedProduct('two-stroke', 'Масло двухтактное 2T для садовой техники', 'TSS', 'Масло для генератора', 520, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/2t/'),
      brandedProduct('filter-oil', 'Масло для воздушного фильтра', 'TSS', 'Расходники', 350, 'https://bakautprof.ru/catalog/raskhodniki/filter-oil/'),
      brandedProduct('cover', 'Кожух всепогодный для генератора', 'TSS', 'Кожухи для генератора', 129000, 'https://bakautprof.ru/catalog/kozhukhi_dlya_generatora/cover/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: `${nextMessage} ${firstMessage} 4-тактное моторное масло SAE`,
      selectedProductIds: ['plate'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'Нужно моторное масло к уже выбранной виброплите, а не карточка самой плиты.'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend oil'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1', 'oil-4']);
  });

  it('does not classify a normal bakautprof product URL as an accessory', () => {
    const message = 'Есть коврик или кожух?';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 52900, 'https://bakautprof.ru/catalog/vibroplity/champion_pc5332f/'),
      brandedProduct('cover', 'Кожух всепогодный для генератора', 'TSS', 'Кожухи для генератора', 129000, 'https://bakautprof.ru/catalog/kozhukhi_dlya_generatora/cover/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generatorAccessory',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend accessory'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cover']);
  });

  it('turns a checkout message into a selected bundle and does not add alternatives', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Интересует виброплита CHAMPION PC5332F и масло 10W-40'));
    const products = [
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 40490, 'https://example.test/catalog/vibroplity/pc5332f/'),
      brandedProduct('oil-1', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 1л', 'SAE', 'Масло для генератора', 428, 'https://example.test/catalog/maslo/tss-1/'),
      brandedProduct('oil-4', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 4л', 'SAE', 'Масло для генератора', 1136, 'https://example.test/catalog/maslo/tss-4/'),
      brandedProduct('teboil-1', 'Масло моторное TEBOIL Silver SN 10W-40 канистра 1 л', 'Teboil', 'Масло для генератора', 640, 'https://example.test/catalog/maslo/teboil-1/')
    ];
    const plan = assistantTestHooks.purchasePlanIfNeeded({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      catalogSearchQuery: 'CHAMPION PC5332F масло 10W-40',
      selectedProductIds: ['oil-4'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any, products, [{
      id: 'assistant-1',
      sessionId: 'session',
      role: 'assistant',
      content: '',
      metadata: { productCards: [assistantTestHooks.cardsFromPlan([products[0]], state, 'CHAMPION PC5332F', {
        action: 'recommend_products',
        catalogSearchQuery: 'CHAMPION PC5332F',
        selectedProductIds: ['plate'],
        requiredProductTraits: {
          productIntent: 'plate',
          fuel: 'any',
          startType: 'any',
          conventionalGenerator: null,
          singlePhase220: null,
          nominalPowerKwMin: null,
          nominalPowerKwMax: null,
          maxPowerKwMin: null,
          maxPowerKwMax: null,
          powerReasoning: ''
        },
        needsWebSearch: false,
        missingInformation: [],
        answerGuidance: ''
      } as any)[0]] },
      createdAt: new Date().toISOString()
    } as any], state, 'Давайте мне эту плиту и масло 1л под нее');

    const cards = assistantTestHooks.cardsFromPlan(products, state, 'Давайте мне эту плиту и масло 1л под нее', plan.plan);

    expect(plan.leadRequested).toBe(true);
    expect(plan.plan.action).toBe('collect_lead');
    expect(cards.map((card) => card.id)).toEqual(['plate', 'oil-1']);
    expect(cards[1].brand).toBe('ТСС');
  });

  it('keeps the chosen main equipment and first matching consumable when buyer proceeds', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Need vibroplita CHAMPION PC5332F and oil 10W-40'));
    const products = [
      brandedProduct('plate', 'Vibroplita CHAMPION PC5332F', 'Champion', 'vibroplity', 40490, 'https://example.test/catalog/vibroplity/pc5332f/'),
      brandedProduct('tss-1', 'Oil TSS SAE 10W-40 API SG/CD canister 1l', 'TSS', 'oil for generator', 428, 'https://example.test/catalog/oil/tss-1/'),
      brandedProduct('teboil-1', 'Oil motor TEBOIL Silver SN 10W-40 canister 1 l', 'Teboil', 'oil for generator', 640, 'https://example.test/catalog/oil/teboil-1/'),
      brandedProduct('tss-4', 'Oil TSS SAE 10W-40 API SG/CD canister 4l', 'TSS', 'oil for generator', 1136, 'https://example.test/catalog/oil/tss-4/')
    ];
    const previousOilCards = assistantTestHooks.cardsFromPlan([products[1], products[2], products[3]], state, 'Oil for CHAMPION PC5332F', {
      action: 'recommend_products',
      catalogSearchQuery: 'CHAMPION PC5332F oil 10W-40',
      selectedProductIds: ['tss-1', 'teboil-1', 'tss-4'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);
    const plan = assistantTestHooks.purchasePlanIfNeeded({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      catalogSearchQuery: 'CHAMPION PC5332F oil 10W-40',
      selectedProductIds: ['teboil-1'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any, products, [{
      id: 'user-1',
      sessionId: 'session',
      role: 'user',
      content: 'Need vibroplita CHAMPION PC5332F and oil for it',
      metadata: {},
      createdAt: new Date().toISOString()
    }, {
      id: 'assistant-1',
      sessionId: 'session',
      role: 'assistant',
      content: 'The main option is TSS 1l.',
      metadata: { productCards: previousOilCards },
      createdAt: new Date().toISOString()
    }] as any, state, 'Take this plate and 1l oil for it');

    const cards = assistantTestHooks.cardsFromPlan(products, state, 'Take this plate and 1l oil for it', plan.plan);

    expect(cards.map((card) => card.id)).toEqual(['plate', 'tss-1']);
  });

  it('does not treat model code fragments like 5W as engine oil', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Need engine oil 10W-40 for vibroplate'));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate-code', 'Vibroplita MASTERPAC PC4515WCH.2', 'Masterpac', 'vibroplity', 155000, 'https://example.test/catalog/vibroplity/pc4515wch/'),
      brandedProduct('oil-1', 'Oil TSS SAE 10W-40 API SG/CD canister 1l', 'TSS', 'oil for generator', 428, 'https://example.test/catalog/oil/tss-1/')
    ], state, 'Need engine oil 10W-40 for vibroplate', {
      action: 'recommend_products',
      catalogSearchQuery: 'engine oil 10W-40 vibroplate',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1']);
  });

  it('recognizes trowel, welding generator, and diamond core intents as product classes', () => {
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужна затирочная машина для склада').intent).toBe('trowel');
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужен сварочный генератор 2 в 1 под электрод 4 мм').intent).toBe('weldingGenerator');
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужна алмазная коронка 72 мм под подрозетник в монолите').intent).toBe('diamondCore');
  });

  it('keeps short model codes as exact model tokens', () => {
    const profile = assistantTestHooks.buildProductFitProfile(
      emptyNeedState(),
      'Сравни K770 и TS420 по запчастям, еще есть LAT100 и MP-15CE'
    );

    expect(profile.exactModelTokens.map((token) => token.replace(/\s+/g, ''))).toEqual(expect.arrayContaining(['K770', 'TS420', 'LAT100']));
    expect(profile.exactModelTokens).toEqual(expect.arrayContaining(['MP-15CE']));
  });

  it('removes visible external links from the assistant answer', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('Проверил [пример](https://example.com/item) и bakautprof.ru/catalog. Подойдет 10W-40.');
    expect(cleaned).toBe('Проверил пример и Подойдет 10W-40.');
  });

  it('removes deferred comparison offers at the end of factual answers', () => {
    const noDeferredOfferPlan = { followUpPolicy: 'answerNowNoDeferredOffer' } as any;
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('K 770 дешевле по ТО.\n\nЕсли хотите, я дальше могу разложить по конкретным позициям: свеча, фильтр, ремень.', noDeferredOfferPlan);
    const cleanedDirect = assistantTestHooks.sanitizeVisibleAnswer('MP-15 не выглядит актуальной моделью в основной линейке.\n\nЕсли хотите, я дальше сравню MP-15 с K770 и TS420 по стоимости владения.', noDeferredOfferPlan);
    const cleanedCatalogTail = assistantTestHooks.sanitizeVisibleAnswer('По нашему каталогу по MP15 есть сама виброплита и запчасти: ремень, амортизатор, система смачивания. Если у вас уже есть MP15, дальше могу быстро собрать список что чаще всего берут на сервис.', noDeferredOfferPlan);
    const cleanedBetterNext = assistantTestHooks.sanitizeVisibleAnswer('По MP15 есть ремень 1 200 ₽ и амортизатор 1 300 ₽.\n\nЕсли хотите, дальше лучше смотреть новую замену на MP15 или сразу подбирать расходники.', noDeferredOfferPlan);

    expect(cleaned).toBe('K 770 дешевле по ТО.');
    expect(cleanedDirect).toBe('MP-15 не выглядит актуальной моделью в основной линейке.');
    expect(cleanedCatalogTail).toBe('По нашему каталогу по MP15 есть сама виброплита и запчасти: ремень, амортизатор, система смачивания.');
    expect(cleanedBetterNext).toBe('По MP15 есть ремень 1 200 ₽ и амортизатор 1 300 ₽.');
  });

  it('forces web verification and a detailed style for service and ownership-cost questions', () => {
    const plan = {
      action: 'verify_with_web',
      answerMode: 'serviceCostComparison',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      catalogSearchQuery: 'Husqvarna K 770 STIHL TS 420 сервис запчасти расходники',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'unknown',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Сравнить сервисное обслуживание, стоимость запчастей и расходников'
    } as any;
    const message = 'А что по сервисному обслуживанию и стоимости запасных частей и расходных материалов?';

    expect(assistantTestHooks.shouldUseWebSearch(message, plan)).toBe(true);
    expect(assistantTestHooks.shouldUseDetailedFactStyle(message, plan, 0)).toBe(true);

    expect(assistantTestHooks.shouldUseWebSearch(message, {
      ...plan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      followUpPolicy: 'auto',
      needsWebSearch: false
    })).toBe(false);
  });

  it('routes current-lineup and service comparisons to deeper reasoning', () => {
    expect(assistantTestHooks.shouldUseDeepReasoningForPlanning('А MP-15 Wacker выпускается еще?', [])).toBe(true);
    expect(assistantTestHooks.shouldUseDeepReasoningForPlanning('Сколько стоит сервис K770 и TS420?', [])).toBe(true);
    expect(assistantTestHooks.shouldUseDeepReasoningForAnswer({
      action: 'verify_with_web',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      contextScope: 'latestMessageOnly',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'MP-15 Wacker выпускается еще?',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: ''
    } as any, true, false, true, 0)).toBe(true);

    const profile = assistantTestHooks.resolveReasoningProfile('gpt-5.4-mini', 'low', true, 2);
    expect(profile.effort).toBe('xhigh');
    expect(profile.model).not.toBe('gpt-5.4-mini');
  });

  it('uses high web-search context and proof policy for current-lineup fact checks', () => {
    const plan = {
      action: 'verify_with_web',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      contextScope: 'latestMessageOnly',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'Wacker Neuson MP-15 still produced current lineup',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: ''
    } as any;

    const policy = assistantTestHooks.buildFactualVerificationPolicy({
      userMessage: 'А MP-15 Wacker выпускается еще?',
      plan,
      currentLineupStyle: true,
      detailedFactStyle: false
    });

    expect(assistantTestHooks.webSearchContextSize(true, false, 1)).toBe('high');
    expect(policy?.mode).toBe('current_lineup_status');
    expect(policy?.sourceCoverage).toContain('manufacturer current product/catalog pages');
    expect(policy?.inferenceRules.join(' ')).toContain('not by itself proof');
    expect(policy?.inferenceRules.join(' ')).toContain('explicitly supports that relationship');
    expect(policy?.answerRules.join(' ')).toContain('distinguish single-direction plates from reversible plates');
    expect(policy?.answerRules.join(' ')).toContain('catalogLineupAlternatives');
    expect(policy?.answerRules.join(' ')).toContain('catalogLineupAlternativeGroups');
    expect(policy?.answerRules.join(' ')).toContain('catalog presence only');
    expect(policy?.answerRules.join(' ')).toContain('mandatoryCatalogLineupAlternativeFacts');
    expect(policy?.answerRules.join(' ')).toContain('best 1-3');
  });

  it('does not show product cards for service and ownership-cost comparison even with exact model matches', () => {
    const state = emptyNeedState();
    const message = 'Сравни обслуживание и стоимость расходников K770 и TS420';
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('k770', 'Бензорез Husqvarna K 770/12"', 'Husqvarna', 'Швонарезчики и Резчики', 108082, 'https://example.test/k770'),
      brandedProduct('k770-kit', 'Комплект сервиса K 770 HUSQVARNA', 'Husqvarna', 'Расходники', 7722, 'https://example.test/k770-kit')
    ], state, message, {
      action: 'verify_with_web',
      catalogSearchQuery: 'K770 TS420 сервис запчасти расходники',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'unknown',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Сравнить обслуживание, стоимость запчастей и расходников'
    } as any);

    expect(cards).toEqual([]);
  });

  it('keeps current-lineup questions out of service-cost detailed mode when old context leaks into the plan', () => {
    const plan = {
      action: 'verify_with_web',
      catalogSearchQuery: 'Wacker Neuson MP-15 выпускается ли сейчас, K770 TS420 сервис запчасти расходники',
      selectedProductIds: ['mp15'],
      requiredProductTraits: {
        productIntent: 'plate',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Проверить, выпускается ли MP-15. В старом контексте было сравнение сервиса K770 TS420 и расходников.'
    } as any;

    const message = 'А mp-15 wacker выпускается еще?';

    expect(assistantTestHooks.shouldUseCurrentLineupStyle(message)).toBe(true);
    expect(assistantTestHooks.shouldUseDetailedFactStyle(message, plan, 0)).toBe(false);
    expect(assistantTestHooks.shouldUseWebSearch(message, plan)).toBe(true);
  });

  it('does not show product cards for current-lineup fact checks unless the buyer asks to buy', () => {
    const state = emptyNeedState();
    const message = 'А mp-15 wacker выпускается еще?';
    const selection = assistantTestHooks.selectCardsFromPlan([
      brandedProduct('mp15', 'Виброплита прямоходная бензиновая Wacker Neuson MP15-CE (83 кг)', 'Wacker Neuson', 'Виброплиты', 154000, 'https://example.test/mp15'),
      brandedProduct('belt', 'Ремень приводной AV13x813Li для виброплиты Wacker Neuson MP-15', 'Wacker Neuson', 'Запчасти', 1200, 'https://example.test/belt')
    ], state, message, {
      action: 'verify_with_web',
      catalogSearchQuery: 'Wacker Neuson MP-15 выпускается ли сейчас',
      selectedProductIds: ['mp15', 'belt'],
      requiredProductTraits: {
        productIntent: 'plate',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Проверить текущую линейку производителя'
    } as any);

    expect(selection.cards).toEqual([]);
    expect(selection.diagnostics.fallbackReason).toBe('suppressed_for_current_lineup_question');
  });
});
