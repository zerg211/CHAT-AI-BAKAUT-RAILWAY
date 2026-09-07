// Physical units and catalog field identifiers are deterministic data contracts.
// Unrecognized or qualified text stays distinct for semantic adjudication.
const fields = {
  mass: ['масса', 'вес', 'weight', 'mass', 'масса, кг', 'вес, кг', 'weight_kg', 'weightkg', 'рабочая масса, кг', 'working_weight_kg'],
  transport_mass: ['транспортный вес. кг', 'транспортный вес, кг', 'transport_weight_kg', 'transport_mass_kg'],
  price: ['price', 'price_rub', 'цена', 'цена, руб'],
  nominal_power: ['номинальная мощность', 'мощность номинальная', 'nominal power', 'rated power', 'nominal_power_kw', 'rated_power_kw'],
  maximum_power: ['максимальная мощность', 'maximum power', 'peak power', 'maximum_power_kw', 'peak_power_kw'],
  voltage: ['напряжение', 'voltage'],
  frequency: ['частота', 'frequency']
} as const;

export function normalizedFactText(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
}

export function canonicalFactAttribute(attribute: string) {
  const normalized = normalizedFactText(attribute);
  return Object.entries(fields).find(([, aliases]) => (aliases as readonly string[]).includes(normalized))?.[0] ?? normalized;
}

export function factAttributeAliases(attributes: string[]) {
  return [...new Set(attributes.flatMap(attribute => {
    const canonical = canonicalFactAttribute(attribute);
    return [normalizedFactText(attribute), ...(fields[canonical as keyof typeof fields] ?? [])];
  }))];
}

const units: Record<string, [string, number]> = {
  'г': ['kg', 0.001], 'g': ['kg', 0.001], 'кг': ['kg', 1], 'kg': ['kg', 1],
  'т': ['kg', 1000], 't': ['kg', 1000],
  'вт': ['kW', 0.001], 'w': ['kW', 0.001], 'квт': ['kW', 1], 'kw': ['kW', 1],
  'ва': ['kVA', 0.001], 'va': ['kVA', 0.001], 'ква': ['kVA', 1], 'kva': ['kVA', 1],
  'в': ['V', 1], 'v': ['V', 1], 'гц': ['Hz', 1], 'hz': ['Hz', 1],
  'мм': ['m', 0.001], 'mm': ['m', 0.001], 'см': ['m', 0.01], 'cm': ['m', 0.01],
  'м': ['m', 1], 'm': ['m', 1]
};

export function normalizedFactValue(value: string) {
  const text = normalizedFactText(value);
  let end = 0;
  while (end < text.length && '0123456789.,+-'.includes(text[end])) end += 1;
  const numberText = text.slice(0, end).replace(',', '.');
  const unit = units[text.slice(end).trim()];
  const number = Number(numberText);
  // No extraction of a convenient number from prose, ranges or conditions.
  if (numberText && Number.isFinite(number) && unit) {
    return { type: 'quantity' as const, value: Number((number * unit[1]).toPrecision(12)), unit: unit[0] };
  }
  return { type: 'text' as const, value: text };
}

export function verifiedFactValueKey(fact: { attribute: string; value: string }) {
  return JSON.stringify([canonicalFactAttribute(fact.attribute), normalizedFactValue(fact.value)]);
}
