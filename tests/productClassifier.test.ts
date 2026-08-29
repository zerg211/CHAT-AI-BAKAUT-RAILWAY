import { describe, expect, it } from 'vitest';

import {
  extractWeightKg,
  generatorAutoStartProfile,
  generatorRemoteStartProfile,
  oilViscosities,
  parseLoosePositiveNumber,
  productLiters,
  productMatchesIntent,
  productPowerSource,
  requestedLiters
} from '../src/ai/productClassifier.js';
import type { Product } from '../src/shared/types.js';

function product(name: string, overrides: Partial<Product> = {}): Product {
  return {
    id: name,
    name,
    brand: 'TSS',
    category: '',
    price: 0,
    currency: 'RUB',
    specs: {},
    ...overrides
  };
}

describe('productClassifier core title prefix parsing', () => {
  it('keeps core generator prefixes stronger than accessory words without regex', () => {
    const item = product('Generator filter kit 5 kW');

    expect(productMatchesIntent(item, 'generator')).toBe(true);
    expect(productMatchesIntent(item, 'generatorAccessory')).toBe(false);
  });

  it('keeps separator boundaries equivalent to the legacy title prefix check', () => {
    const item = product('Generator-Filter kit 5 kW');

    expect(productMatchesIntent(item, 'generator')).toBe(true);
    expect(productMatchesIntent(item, 'generatorAccessory')).toBe(false);
  });

  it('recognizes English gasoline and petrol catalog labels as fuel evidence', () => {
    expect(productPowerSource(product('Gasoline generator 5 kW'))).toBe('gasoline');
    expect(productPowerSource(product('Petrol generator 5 kW'))).toBe('gasoline');
  });
});

describe('productClassifier weight parsing without regex', () => {
  it('extracts the first loose positive number from spec text', () => {
    expect(parseLoosePositiveNumber('mass: 62,5 kg')).toBe(62.5);
    expect(parseLoosePositiveNumber('about 70.25 kg')).toBe(70.25);
    expect(parseLoosePositiveNumber('no numeric value')).toBeUndefined();
  });

  it('prefers structured mass specs before scanning title text', () => {
    const item = product('Vibroplita model 100 88 kg', {
      specs: { weight: '64,5 kg' }
    });

    expect(extractWeightKg(item)).toBe(64.5);
  });

  it('extracts English and Russian weight units from product text', () => {
    expect(extractWeightKg(product('Vibroplita model 100 88 kg'))).toBe(88);
    expect(extractWeightKg(product('Виброплита WP60L 60 кг'))).toBe(60);
  });

  it('ignores model digits not followed by a weight unit', () => {
    expect(extractWeightKg(product('Vibroplita WP60L compact model'))).toBeUndefined();
  });
});

describe('productClassifier oil and liter parsing without regex', () => {
  it('extracts and normalizes explicit oil viscosity tokens', () => {
    expect(oilViscosities('SAE 10W-40 для генератора, можно 5w30')).toEqual(['10w40', '5w30']);
  });

  it('keeps model-like embedded text from being treated as viscosity', () => {
    expect(oilViscosities('model x10w40y')).toEqual([]);
  });

  it('extracts requested oil package volume from Russian and English units', () => {
    expect(requestedLiters('нужно масло 1,5 л')).toBe(1.5);
    expect(requestedLiters('take 2l oil')).toBe(2);
    expect(requestedLiters('масло 4 литра')).toBe(4);
  });

  it('reads product volume through the stable productLiters API', () => {
    expect(productLiters(product('Масло SAE 10W-40 1 л'))).toBe(1);
  });
});

describe('productClassifier explicit generator autostart facts', () => {
  it('recognizes explicit present and absent structured facts', () => {
    expect(generatorAutoStartProfile(product('Generator no autostart', {
      specs: { 'Auto start': 'no' }
    }))).toBe('absent');
    expect(generatorAutoStartProfile(product('Generator with autostart', {
      specs: { Autostart: true }
    }))).toBe('present');
    expect(generatorAutoStartProfile(product('Generator explicitly without autostart', {
      specs: { Автозапуск: 'без автозапуска' }
    }))).toBe('absent');
    expect(generatorAutoStartProfile(product('Generator explicitly with autostart', {
      specs: { 'Наличие автозапуска': 'есть' }
    }))).toBe('present');
  });

  it('fails closed for missing, ambiguous, and contradictory facts', () => {
    expect(generatorAutoStartProfile(product('Generator unknown'))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator ambiguous', {
      specs: { Autostart: 'not determined' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator conflicting', {
      specs: { 'Auto start': 'yes', Autostart: 'no' }
    }))).toBe('conflict');
  });

  it('does not confuse a connector, readiness, option, or unrelated text with installed autostart', () => {
    expect(generatorAutoStartProfile(product('Generator with connector only', {
      specs: { 'Auto start connector': 'yes' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator prepared for optional ATS', {
      specs: { 'Auto start': 'optional connector ready' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator unrelated mode', {
      specs: { 'Auto start': 'normally open' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator with ATS socket only', {
      specs: { 'Разъем для автозапуска': 'есть' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator prepared for ATS only', {
      specs: { 'Подготовка к автозапуску': 'есть' }
    }))).toBe('unknown');
  });

  it('gives explicit negation precedence over installed-state words', () => {
    expect(generatorAutoStartProfile(product('Generator not installed', {
      specs: { 'Auto start': 'not determined' }
    }))).toBe('unknown');
    expect(generatorAutoStartProfile(product('Generator explicitly absent', {
      specs: { 'Auto start': 'не был установлен' }
    }))).toBe('absent');
    expect(generatorAutoStartProfile(product('Generator never provisioned', {
      specs: { 'Auto start': 'никогда не был предусмотрен' }
    }))).toBe('absent');
  });
});

describe('productClassifier explicit generator remote-start facts', () => {
  it('recognizes remote command start from structured start fields', () => {
    expect(generatorRemoteStartProfile(product('BISON BS6250IE', {
      specs: { запуск: 'ручной/электро/дистанционный' }
    }))).toBe('present');
    expect(generatorRemoteStartProfile(product('A-iPower A4000iS', {
      specs: { starter: 'ручной/электро/АВР, дистанционный пульт до 50 м' }
    }))).toBe('present');
    expect(generatorRemoteStartProfile(product('SUNREKA G2200iS', {
      specs: { стартер: 'ручной + электростартер, пульт ДУ, блок АВР' }
    }))).toBe('present');
  });

  it('does not substitute ATS, electric start, or unrelated remote control', () => {
    expect(generatorRemoteStartProfile(product('ATS generator', {
      specs: { автозапуск: 'с автозапуском', стартер: 'с электростартером' }
    }))).toBe('unknown');
    expect(generatorRemoteStartProfile(product('Remote welding adjustment', {
      specs: { welding: 'дистанционная регулировка тока с пульта' }
    }))).toBe('unknown');
  });

  it('keeps explicit absence and contradictory structured facts distinct', () => {
    expect(generatorRemoteStartProfile(product('No remote start', {
      specs: { 'remote start': false }
    }))).toBe('absent');
    expect(generatorRemoteStartProfile(product('Conflicting remote start', {
      specs: { 'remote start': false, запуск: 'дистанционный с брелока' }
    }))).toBe('conflict');
  });
});
