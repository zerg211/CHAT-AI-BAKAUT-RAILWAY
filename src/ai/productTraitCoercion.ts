import type { ProductSelectionClass, ProductSelectionCriteria } from '../shared/types.js';

export type ProductIntent = ProductSelectionClass;
export type ProductFuel = 'gasoline' | 'diesel' | 'any' | 'unknown';
export type ProductStartType = 'electric' | 'manual' | 'any' | 'unknown';
export type ProductRole = 'coreProduct' | 'accessory' | 'consumable' | 'unknown';
export type ProductEnclosure = 'enclosed' | 'open' | 'any' | 'unknown';

export type RequiredProductTraits = {
  productIntent: ProductIntent;
  productRole: ProductRole;
  fuel: ProductFuel;
  startType: ProductStartType;
  enclosure: ProductEnclosure;
  conventionalGenerator: boolean | null;
  singlePhase220: boolean | null;
  budgetMax: number | null;
  weightKgMin: number | null;
  weightKgMax: number | null;
  diameterMmMin: number | null;
  diameterMmMax: number | null;
  nominalPowerKwMin: number | null;
  nominalPowerKwMax: number | null;
  maxPowerKwMin: number | null;
  maxPowerKwMax: number | null;
  powerReasoning: string;
  provenance?: ProductSelectionCriteria['provenance'];
};

export function coerceProductIntent(value: unknown): ProductIntent {
  const allowed: ProductIntent[] = [
    'generator',
    'weldingGenerator',
    'generatorOil',
    'engineOil',
    'generatorAccessory',
    'plateAccessory',
    'plate',
    'rammer',
    'roller',
    'cutter',
    'diamondBlade',
    'diamondCore',
    'trowel',
    'unknown'
  ];
  return allowed.includes(value as ProductIntent) ? value as ProductIntent : 'unknown';
}

export function coerceFuel(value: unknown): ProductFuel {
  const allowed: ProductFuel[] = ['gasoline', 'diesel', 'any', 'unknown'];
  return allowed.includes(value as ProductFuel) ? value as ProductFuel : 'unknown';
}

export function coerceStartType(value: unknown): ProductStartType {
  const allowed: ProductStartType[] = ['electric', 'manual', 'any', 'unknown'];
  return allowed.includes(value as ProductStartType) ? value as ProductStartType : 'unknown';
}

export function coerceProductRole(value: unknown): ProductRole {
  const allowed: ProductRole[] = ['coreProduct', 'accessory', 'consumable', 'unknown'];
  return allowed.includes(value as ProductRole) ? value as ProductRole : 'unknown';
}

export function coerceProductEnclosure(value: unknown): ProductEnclosure {
  const allowed: ProductEnclosure[] = ['enclosed', 'open', 'any', 'unknown'];
  return allowed.includes(value as ProductEnclosure) ? value as ProductEnclosure : 'unknown';
}

export function coerceStringList(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
}

export function coerceProductIntentList(value: unknown, limit = 12): ProductIntent[] {
  if (!Array.isArray(value)) return [];
  return value.map(coerceProductIntent).filter((item) => item !== 'unknown').slice(0, limit);
}

export function coerceNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function coerceNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function emptyRequiredProductTraits(): RequiredProductTraits {
  return {
    productIntent: 'unknown',
    productRole: 'unknown',
    fuel: 'unknown',
    startType: 'unknown',
    enclosure: 'unknown',
    conventionalGenerator: null,
    singlePhase220: null,
    budgetMax: null,
    weightKgMin: null,
    weightKgMax: null,
    diameterMmMin: null,
    diameterMmMax: null,
    nominalPowerKwMin: null,
    nominalPowerKwMax: null,
    maxPowerKwMin: null,
    maxPowerKwMax: null,
    powerReasoning: ''
  };
}

export function requiredTraitsHaveHardConstraints(traits?: RequiredProductTraits) {
  if (!traits) return false;
  return traits.productIntent !== 'unknown' ||
    traits.productRole !== 'unknown' ||
    traits.fuel !== 'unknown' ||
    traits.startType !== 'unknown' ||
    traits.enclosure !== 'unknown' ||
    traits.conventionalGenerator !== null ||
    traits.singlePhase220 !== null ||
    traits.budgetMax !== null ||
    traits.weightKgMin !== null ||
    traits.weightKgMax !== null ||
    traits.diameterMmMin !== null ||
    traits.diameterMmMax !== null ||
    traits.nominalPowerKwMin !== null ||
    traits.nominalPowerKwMax !== null ||
    traits.maxPowerKwMin !== null ||
    traits.maxPowerKwMax !== null;
}

export function coerceRequiredProductTraits(value: any): RequiredProductTraits {
  const fallback = emptyRequiredProductTraits();
  if (!value || typeof value !== 'object') return fallback;
  return {
    productIntent: coerceProductIntent(value.productIntent),
    productRole: coerceProductRole(value.productRole),
    fuel: coerceFuel(value.fuel),
    startType: coerceStartType(value.startType),
    enclosure: coerceProductEnclosure(value.enclosure),
    conventionalGenerator: coerceNullableBoolean(value.conventionalGenerator),
    singlePhase220: coerceNullableBoolean(value.singlePhase220),
    budgetMax: coerceNullableNumber(value.budgetMax),
    weightKgMin: coerceNullableNumber(value.weightKgMin),
    weightKgMax: coerceNullableNumber(value.weightKgMax),
    diameterMmMin: coerceNullableNumber(value.diameterMmMin),
    diameterMmMax: coerceNullableNumber(value.diameterMmMax),
    nominalPowerKwMin: coerceNullableNumber(value.nominalPowerKwMin),
    nominalPowerKwMax: coerceNullableNumber(value.nominalPowerKwMax),
    maxPowerKwMin: coerceNullableNumber(value.maxPowerKwMin),
    maxPowerKwMax: coerceNullableNumber(value.maxPowerKwMax),
    powerReasoning: String(value.powerReasoning ?? '').trim().slice(0, 800)
  };
}
