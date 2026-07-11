import { describe, expect, it } from 'vitest';

import {
  buildProductFactSearchPlan,
  resolveProductFactCandidate,
  sourceCredibilityRank
} from '../src/ai/productFactResolution.js';
import type { ProductAttributeConflict } from '../src/ai/productAttributeExtraction.js';

describe('productFactResolution', () => {
  const conflict: ProductAttributeConflict = {
    productId: 'tss-wp60th',
    productName: 'Виброплита TSS-WP60TH (60 кг, 10,5 кН, 500х360) 207192',
    productUrl: 'https://bakautprof.ru/catalog/vibroplity/tss_wp60th/',
    attribute: 'weightKg',
    nameValue: 60,
    specsValue: 72,
    nameRaw: '60 кг',
    specsRaw: '72'
  };

  function source(url: string, sourceType: 'manual' | 'manufacturer' | 'dealer' | 'marketplace', value: number) {
    return {
      url,
      title: sourceType,
      sourceType,
      attribute: 'weightKg' as const,
      value,
      evidence: `${value} кг`
    };
  }

  it('confirms a conflicted fact only with two credible independent matching sources', () => {
    const resolution = resolveProductFactCandidate({
      conflict,
      sources: [
        {
          url: 'https://mcgrp.ru/files/viewer/885338/1',
          title: 'Инструкция ТСС',
          sourceType: 'manual',
          attribute: 'weightKg',
          value: '60 кг',
          evidence: 'TSS-WP60TH 60 ... 207192'
        },
        {
          url: 'https://www.tss-s.ru/catalog/stroitelnoe-oborudovanie/vibroplity/benzinovye/tss_wp60th/',
          title: 'ТехноСпецСнаб TSS-WP60TH',
          sourceType: 'dealer',
          attribute: 'weightKg',
          value: '60',
          evidence: 'Масса, кг 60'
        }
      ]
    });

    expect(resolution).toMatchObject({
      status: 'confirmed',
      attribute: 'weightKg',
      confirmedValue: 60,
      conflict
    });
    expect(resolution.sources).toHaveLength(2);
  });

  it('does not confirm marketplace-only duplicate evidence as two independent sources', () => {
    const resolution = resolveProductFactCandidate({
      conflict,
      sources: [
        {
          url: 'https://market.example.ru/item-1',
          title: 'Marketplace item copy 1',
          sourceType: 'marketplace',
          attribute: 'weightKg',
          value: '60 кг',
          evidence: '60 кг'
        },
        {
          url: 'https://market.example.ru/item-2',
          title: 'Marketplace item copy 2',
          sourceType: 'marketplace',
          attribute: 'weightKg',
          value: '60 кг',
          evidence: '60 кг'
        }
      ]
    });

    expect(resolution.status).toBe('not_enough_evidence');
  });

  it('does not confirm a value when another credible source contradicts it', () => {
    const resolution = resolveProductFactCandidate({
      conflict,
      sources: [
        source('https://manual.example/wp60th', 'manual', 60),
        source('https://dealer.example/wp60th', 'dealer', 60),
        source('https://manufacturer.example/wp60th', 'manufacturer', 72)
      ]
    });

    expect(resolution.status).toBe('conflicting_sources');
    expect(resolution.confirmedValue).toBeUndefined();
  });

  it('returns conflicting_sources when credible sources disagree', () => {
    const resolution = resolveProductFactCandidate({
      conflict,
      sources: [
        {
          url: 'https://manual.example.ru/tss',
          title: 'Manual',
          sourceType: 'manual',
          attribute: 'weightKg',
          value: '60 кг',
          evidence: '60 кг'
        },
        {
          url: 'https://dealer.example.ru/tss',
          title: 'Dealer',
          sourceType: 'dealer',
          attribute: 'weightKg',
          value: '72 кг',
          evidence: '72 кг'
        }
      ]
    });

    expect(resolution.status).toBe('conflicting_sources');
    expect(resolution.valueGroups.map((group) => group.normalizedValue).sort()).toEqual([60, 72]);
  });

  it('builds a multi-query search plan before declaring a fact not found', () => {
    const plan = buildProductFactSearchPlan({
      productName: conflict.productName,
      attribute: 'weightKg',
      article: '207192',
      brand: 'ТСС'
    });

    expect(plan.queries.length).toBeGreaterThanOrEqual(6);
    expect(plan.queries).toEqual(expect.arrayContaining([
      'TSS-WP60TH 207192 масса кг',
      'TSS-WP60TH 207192 инструкция',
      'TSS-WP60TH 207192 паспорт',
      'TSS-WP60TH weight specs'
    ]));
    expect(plan.requiredSourceClasses).toEqual(expect.arrayContaining(['manual', 'manufacturer', 'dealer', 'marketplace']));
  });

  it('keeps model-token extraction stable for separated and embedded identifiers', () => {
    const separated = buildProductFactSearchPlan({
      productName: 'Виброплита TSS WP60TH 60 кг',
      attribute: 'weightKg'
    });
    const embedded = buildProductFactSearchPlan({
      productName: 'Генератор 1ABC2 профессиональный',
      attribute: 'powerKw'
    });

    expect(separated.queries).toContain('WP60TH масса кг');
    expect(embedded.queries).toContain('ABC2 мощность кВт');
  });

  it('treats www and bare host variants as one independent source', () => {
    const resolution = resolveProductFactCandidate({
      conflict,
      sources: [
        source('https://www.manual.example/wp60th', 'manual', 60),
        source('https://manual.example/copy/wp60th', 'manual', 60)
      ]
    });

    expect(resolution.status).toBe('not_enough_evidence');
    expect(resolution.valueGroups[0]?.sources).toHaveLength(1);
  });

  it('ranks manuals/manufacturers above dealers and marketplaces', () => {
    expect(sourceCredibilityRank('manual')).toBeGreaterThan(sourceCredibilityRank('dealer'));
    expect(sourceCredibilityRank('manufacturer')).toBeGreaterThan(sourceCredibilityRank('marketplace'));
  });
});
