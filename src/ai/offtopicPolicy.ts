const OFFTOPIC_PATTERNS = [
  /(?:расскажи|напиши)\s+(?:стих|анекдот|историю|сказку|рецепт)/i,
  /(?:кто\s+(?:ты|такой|тебя\s+создал))/i,
  /(?:поиграем|давай\s+(?:поиграем|в\s+игру))/i,
  /(?:напиши\s+код|программирован)/i,
  /(?:политик|выборы|президент|партия|война)/i,
  /(?:религи|бог|церков|молитв)/i,
  /(?:медицин|лечен|диагноз|болезн|таблетк)/i
];

const REDIRECT_RESPONSE =
  'Я консультант по строительному и силовому оборудованию компании БАКАУТ. ' +
  'К сожалению, этот вопрос выходит за рамки моей компетенции. ' +
  'Могу помочь с подбором генераторов, виброплит, алмазного инструмента и другого оборудования. Чем могу помочь?';

export function isOfftopic(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (lower.length < 3) return false;
  return OFFTOPIC_PATTERNS.some((pattern) => pattern.test(lower));
}

export function getOfftopicRedirect(): string {
  return REDIRECT_RESPONSE;
}

export function buildOfftopicGuard(): string {
  return [
    'If the user asks about topics unrelated to construction/power equipment, politely redirect.',
    'Off-topic includes: politics, religion, medicine, coding, creative writing, games.',
    'Redirect by reminding the user what you can help with (equipment selection, specs, comparison).',
    'Short greetings and pleasantries are fine — respond briefly and steer back to equipment.'
  ].join('\n');
}
