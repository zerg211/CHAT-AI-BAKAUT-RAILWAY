import type { CustomerNeedState, Message } from '../shared/types.js';

export type LeadTemperatureLevel = 'cold' | 'warm' | 'interested' | 'hot' | 'ready';

interface LeadTemperatureResult {
  level: LeadTemperatureLevel;
  score: number;
  signals: string[];
}

const PURCHASE_INTENT_TERMS = [
  'купить', 'заказать', 'оформить', 'приобрести', 'покупк', 'заказ',
  'оплат', 'доставк', 'наличи', 'в наличии', 'есть ли', 'цена', 'стоимость',
  'сколько стоит', 'почём', 'прайс', 'buy', 'order', 'purchase'
];

const COMPARISON_TERMS = [
  'сравни', 'разница', 'отличи', 'лучше', 'хуже', 'какой выбрать',
  'что посоветуете', 'рекоменду', 'подбери', 'подобрат', 'помоги выбрать'
];

const CONTACT_TERMS = [
  'контакт', 'телефон', 'позвони', 'перезвони', 'связат', 'менеджер',
  'оставить заявку', 'заявк', 'обратн', 'callback'
];

export function assessLeadTemperature(
  userMessage: string,
  needState: CustomerNeedState,
  history: Message[]
): LeadTemperatureResult {
  const signals: string[] = [];
  let score = 0;

  const lower = userMessage.toLowerCase();
  const allText = history.map((m) => m.content).join(' ').toLowerCase();

  if (CONTACT_TERMS.some((t) => lower.includes(t))) {
    score += 40;
    signals.push('contact_request');
  }
  if (PURCHASE_INTENT_TERMS.some((t) => lower.includes(t))) {
    score += 25;
    signals.push('purchase_intent');
  }
  if (COMPARISON_TERMS.some((t) => lower.includes(t))) {
    score += 10;
    signals.push('comparison');
  }

  const explicitNeeds = needState.explicitNeeds?.length ?? 0;
  if (explicitNeeds >= 3) {
    score += 15;
    signals.push('detailed_needs');
  } else if (explicitNeeds >= 1) {
    score += 5;
    signals.push('some_needs');
  }

  if (needState.constraints?.length) {
    score += 10;
    signals.push('has_constraints');
  }

  const turnCount = history.filter((m) => m.role === 'user').length;
  if (turnCount >= 5) {
    score += 15;
    signals.push('long_conversation');
  } else if (turnCount >= 3) {
    score += 5;
    signals.push('moderate_conversation');
  }

  if (PURCHASE_INTENT_TERMS.some((t) => allText.includes(t))) {
    score += 5;
    signals.push('historical_purchase_signal');
  }

  const selectionState = needState.selectionState;
  if (selectionState?.selectedProductIds?.length || (selectionState?.confidence ?? 0) > 0.6) {
    score += 10;
    signals.push('active_selection');
  }

  score = Math.min(score, 100);

  let level: LeadTemperatureLevel;
  if (score >= 70) level = 'ready';
  else if (score >= 50) level = 'hot';
  else if (score >= 30) level = 'interested';
  else if (score >= 15) level = 'warm';
  else level = 'cold';

  return { level, score, signals };
}

export function temperatureGuidance(level: LeadTemperatureLevel): string {
  switch (level) {
    case 'ready':
      return 'Customer is ready to buy. Offer to collect contact info for order processing. Be direct about next steps.';
    case 'hot':
      return 'Customer shows strong purchase intent. Highlight key advantages of recommended products and gently suggest leaving contact info.';
    case 'interested':
      return 'Customer is actively comparing options. Focus on specific product advantages and differences. Ask targeted clarifying questions.';
    case 'warm':
      return 'Customer is exploring options. Help identify their needs. Ask about use case, power requirements, budget.';
    case 'cold':
      return 'Customer is just browsing. Be welcoming and helpful. Ask what they are looking for.';
  }
}
