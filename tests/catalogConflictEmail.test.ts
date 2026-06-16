import { describe, expect, it, vi } from 'vitest';

import { buildCatalogConflictEmail, sendCatalogConflictEmail } from '../src/email/catalogConflictEmail.js';
import type { ProductAttributeConflict } from '../src/ai/productAttributeExtraction.js';
import type { ProductFactResolution } from '../src/ai/productFactResolution.js';
import type { Product } from '../src/shared/types.js';

const product: Product = {
  id: 'tss-wp60th',
  name: 'Виброплита TSS-WP60TH (60 кг)',
  brand: 'ТСС',
  category: 'Виброплиты',
  sourceUrl: 'https://bakautprof.ru/product/tss-wp60th',
  price: 79592,
  currency: 'RUB',
  specs: { 'рабочая масса, кг': '72' }
};

const conflict: ProductAttributeConflict = {
  productId: product.id,
  productName: product.name,
  productUrl: product.sourceUrl,
  attribute: 'weightKg',
  nameValue: 60,
  specsValue: 72,
  nameRaw: '60 кг',
  specsRaw: '72'
};

const resolution: ProductFactResolution = {
  status: 'confirmed',
  attribute: 'weightKg',
  confirmedValue: 60,
  conflict,
  sources: [
    {
      url: 'https://tss-s.ru/catalog/wp60th',
      title: 'TSS dealer',
      sourceType: 'dealer',
      attribute: 'weightKg',
      value: 60,
      evidence: 'Масса, кг — 60'
    },
    {
      url: 'https://mcgrp.ru/files/viewer/885338/1',
      title: 'Инструкция',
      sourceType: 'manual',
      attribute: 'weightKg',
      value: 60,
      evidence: 'TSS-WP60TH — эксплуатационная масса 60 кг'
    }
  ],
  valueGroups: [
    {
      normalizedValue: 60,
      strongestSourceRank: 5,
      sources: []
    }
  ],
  rationale: '2 independent sources confirm 60 kg'
};

describe('catalogConflictEmail', () => {
  it('builds an internal email with product link, conflict values, corrected value, and two sources', () => {
    const email = buildCatalogConflictEmail({ product, conflict, resolution, customerAction: 'used_corrected_value' });

    expect(email.subject).toContain('Конфликт данных');
    expect(email.text).toContain('https://bakautprof.ru/product/tss-wp60th');
    expect(email.text).toContain('Название: 60 кг');
    expect(email.text).toContain('Характеристики: 72');
    expect(email.text).toContain('Проверенное значение: 60 кг');
    expect(email.text).toContain('https://tss-s.ru/catalog/wp60th');
    expect(email.text).toContain('https://mcgrp.ru/files/viewer/885338/1');
    expect(email.text).toContain('Клиенту показано исправленное значение');
  });

  it('sends to the same configured recipients as lead email through the configured HTTP endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 202 }));

    const result = await sendCatalogConflictEmail(
      { product, conflict, resolution, customerAction: 'used_corrected_value' },
      {
        fetchImpl: fetchMock,
        config: {
          EMAIL_HTTP_URL: 'https://mail.example/send',
          EMAIL_HTTP_METHOD: 'POST',
          EMAIL_HTTP_AUTH_HEADER: 'X-Test-Auth: token-123',
          EMAIL_HTTP_TIMEOUT_MS: 1000,
          EMAIL_FROM: 'robot@example.com',
          LEADS_TO_EMAIL: 'sales@example.com,owner@example.com'
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://mail.example/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Test-Auth']).toBe('token-123');
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe('sales@example.com, owner@example.com');
    expect(body.subject).toContain('Конфликт данных');
    expect(body.text).toContain('Проверенное значение: 60 кг');
  });
});
