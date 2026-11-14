import { outputFormat } from './platformAgentContract.js';

const decisions = ['selected', 'rejected', 'uncertain'] as const;

export function catalogReviewSchema(ids: string[], names?: Record<string, string>) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Invalid catalog review identities');
  if (names && ids.some(id => !names[id])) throw new Error('Catalog review product name is missing');
  const { selected: _selected, rejected: _rejected, uncertain: _uncertain, answer, ...properties } = outputFormat.schema.properties;
  return { ...outputFormat.schema, properties: {
    candidate_decisions: { type: 'object', additionalProperties: false,
      description: 'Оцени КАЖДОГО кандидата по текущему запросу: selected — подтверждённо подходит; rejected — установлен конфликт; uncertain — решающий факт требует проверки. Прежние товары не входят в новый подбор автоматически.',
      properties: Object.fromEntries(ids.map(id => [id, names ? {
        type: 'object', additionalProperties: false, properties: {
          product_name: { type: 'string', enum: [names[id]] },
          basis: { type: 'string', description: 'Кратко назови решающие факты ИМЕННО ЭТОГО товара и их источник в полной карточке или найденном документе. Сопоставь с текущими условиями покупателя. Не переноси факты соседнего товара. Если есть конфликт или пробел, назови его.' },
          decision: { type: 'string', enum: [...decisions], description: 'Решение по названным фактам: подтверждённое соответствие, установленный конфликт или решающая неизвестная. Неполнота данных сама по себе не означает rejected.' }
        }, required: ['product_name', 'basis', 'decision']
      } : { type: 'string', enum: [...decisions] }])), required: ids },
    ...properties,
    answer: { ...answer, description: 'Короткий полезный вывод на исходный вопрос по candidate_decisions. Виджет сам показывает весь выбранный список, количество и цены по 10 карточек: не переписывай длинный каталог и его количество в текст. Объясни различия, рекомендации и нерешённые вопросы; конкретные названия и факты бери из соответствующего решения, не смешивая артикулы и прежнюю тему.' }
  }, required: ['candidate_decisions', ...outputFormat.schema.required.filter(key => !decisions.includes(key as typeof decisions[number]))] };
}

/** Translates the model's complete identity-keyed decisions; never chooses suitability. */
export function normalizeCatalogReview(text: string, ids: string[], names?: Record<string, string>) {
  const parsed = JSON.parse(text);
  const map = parsed.candidate_decisions;
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== ids.length ||
      ids.some(id => !Object.hasOwn(map, id) || (names
        ? !map[id] || typeof map[id] !== 'object' || Array.isArray(map[id]) || Object.keys(map[id]).length !== 3 ||
          map[id].product_name !== names[id] || typeof map[id].basis !== 'string' || !map[id].basis.trim() || !decisions.includes(map[id].decision)
        : !decisions.includes(map[id]))) ||
      decisions.some(key => Object.hasOwn(parsed, key))) throw new Error('Incomplete catalog review decisions');
  const { candidate_decisions: _removed, ...answer } = parsed;
  return JSON.stringify({ ...answer, ...Object.fromEntries(decisions.map(status => [status,
    ids.filter(id => (names ? map[id].decision : map[id]) === status)])) });
}
