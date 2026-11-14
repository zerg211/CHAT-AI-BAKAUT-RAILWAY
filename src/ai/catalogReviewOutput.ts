import { outputFormat } from './platformAgentContract.js';

const decisions = ['selected', 'rejected', 'uncertain'] as const;

export function catalogReviewSchema(ids: string[]) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Invalid catalog review identities');
  const { selected: _selected, rejected: _rejected, uncertain: _uncertain, answer, ...properties } = outputFormat.schema.properties;
  return { ...outputFormat.schema, properties: {
    candidate_decisions: { type: 'object', additionalProperties: false,
      description: 'Оцени КАЖДОГО кандидата по текущему запросу: selected — подтверждённо подходит; rejected — установлен конфликт; uncertain — решающий факт требует проверки. Прежние товары не входят в новый подбор автоматически.',
      properties: Object.fromEntries(ids.map(id => [id, { type: 'string', enum: [...decisions] }])), required: ids },
    ...properties,
    answer: { ...answer, description: 'Ответ на исходный вопрос по результатам candidate_decisions. Перечисляй подходящие товары согласованно с решениями; прежние товары другой темы не включай в новый список.' }
  }, required: ['candidate_decisions', ...outputFormat.schema.required.filter(key => !decisions.includes(key as typeof decisions[number]))] };
}

/** Translates the model's complete identity-keyed decisions; never chooses suitability. */
export function normalizeCatalogReview(text: string, ids: string[]) {
  const parsed = JSON.parse(text);
  const map = parsed.candidate_decisions;
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== ids.length ||
      ids.some(id => !Object.hasOwn(map, id) || !decisions.includes(map[id])) ||
      decisions.some(key => Object.hasOwn(parsed, key))) throw new Error('Incomplete catalog review decisions');
  const { candidate_decisions: _removed, ...answer } = parsed;
  return JSON.stringify({ ...answer, ...Object.fromEntries(decisions.map(status => [status, ids.filter(id => map[id] === status)])) });
}
