import crypto from 'node:crypto';
import OpenAI from 'openai';

const fallbackDialogueVariant = crypto.randomInt(0, 1_000_000);

function fallbackPhrase(variants, offset = 0) {
  return variants[(fallbackDialogueVariant + offset) % variants.length];
}

export const defaultAdaptiveBuyerGoal = {
  scenarioName: 'adaptive-homeowner-generator-plate-lead',
  persona: 'Обычный владелец частного дома, который впервые подбирает технику на сайте и хочет купить без лишней переплаты.',
  objective: 'Подобрать резервный генератор для дома, затем виброплиту для въезда, понять доставку/наличие и оставить контакт, если выбор выглядит нормальным.',
  constraints: [
    'Дом 220 В: скважинный насос, холодильник, газовый котел с электроникой и свет.',
    'Насос скважинный 220 В, примерно 750 Вт; точную модель покупатель может не знать.',
    'Инструмент от генератора включать не планирует.',
    'Виброплита нужна для небольшого въезда под плитку: песок, щебень, площадь небольшая, грузить будет сам.',
    'Покупатель не специалист: задает простые вопросы и отвечает на уточнения ассистента.',
    'Если ассистент задал уточняющий вопрос, следующий ход покупателя сначала отвечает на него.',
    'Покупатель не говорит как тестировщик, оператор или сценарист.'
  ],
  startUser: 'Здравствуйте. Нужен генератор для дома на случай отключений: насос в скважине, холодильник, котел и свет. Хочу понять нормальную мощность без лишней переплаты.',
  maxTurns: 8,
  minTurnsBeforeLead: 5,
  leadForm: {
    name: 'Алексей',
    phone: '+7 900 000-00-11',
    question: 'Уточнить наличие подобранного генератора, виброплиты и доставку.'
  }
};

const scriptedOperatorTextPattern = /(?:без\s+(?:заявк|телефон|номера|звонк|перезвон)|номер\s+пока\s+не\s+оставляю|пока\s+без\s+звонк|не\s+оставляю.{0,30}(?:номер|телефон)|точную\s+цену\s+сейчас\s+не\s+обещайте|без\s+обещаний\s+точн|что\s+вы\s+будете\s+сверять|что\s+надо\s+будет\s+отдельно\s+уточнять|финально\s+без|параллельно\s+(?:выбираю|подбираю|нужн))/iu;

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return normalize(value).toLocaleLowerCase('ru');
}

function hasInlineLeadContact(value) {
  const text = String(value ?? '');
  const digits = text.replace(/\D+/g, '');
  return digits.length >= 10 || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text);
}

function commitsToLeadSubmission(value) {
  return /(?:заявк|контакт|телефон|номер|перезвон|позвон|оставл|оставить|оставлю|форм[аеу]|оформ|давайте\s+(?:проверим|оформ|заявк))/iu.test(value);
}

function coversFallbackStep(decision, fallbackDecision) {
  const user = lower(decision?.user);
  if (!user) return false;
  switch (fallbackDecision?.phase) {
    case 'answer_pump_clarification':
    case 'add_pump_details':
      return /насос|750\s*вт|0[,.]?75\s*квт|шильдик|модель|220\s*в/iu.test(user);
    case 'request_generator_catalog':
      return /(?:генератор|инвертор|4\s*квт|5\s*квт)/iu.test(user) &&
        /(?:покаж|вариант|модел|карточ|каталог|какие[^.!?\n]{0,80}есть|налич)/iu.test(user);
    case 'switch_to_plate_need':
      return /виброплит/iu.test(user);
    case 'request_plate_catalog':
      return /виброплит/iu.test(user) &&
        /(?:покаж|вариант|модел|карточ|каталог|80|90|100|кг)/iu.test(user);
    case 'ask_delivery_availability':
      return /достав|налич|склад|заказ|оформ/iu.test(user);
    case 'leave_contact_for_order_check':
      return Boolean(decision?.leadForm) || hasInlineLeadContact(user);
    default:
      return true;
  }
}

export function adaptiveBuyerGoalSignature(goal = defaultAdaptiveBuyerGoal) {
  const stableGoal = {
    scenarioName: goal.scenarioName,
    persona: goal.persona,
    objective: goal.objective,
    constraints: goal.constraints,
    startUser: goal.startUser,
    maxTurns: goal.maxTurns,
    minTurnsBeforeLead: goal.minTurnsBeforeLead
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableGoal)).digest('hex');
}

export function adaptiveBuyerPolicy(goal = defaultAdaptiveBuyerGoal) {
  return {
    policy: 'adaptive_buyer_goal',
    scenarioName: goal.scenarioName,
    dialogueSignature: adaptiveBuyerGoalSignature(goal),
    turnCount: goal.maxTurns,
    turnPhases: ['generated_from_live_assistant_answers'],
    repeatedDialogueOverride: false,
    buyerPersona: goal.persona,
    buyerObjective: goal.objective
  };
}

function transcriptForPrompt(steps) {
  return steps.slice(-10).flatMap((step, index) => [
    `Ход ${Math.max(1, steps.length - 9 + index)} / покупатель: ${step.user}`,
    `Ход ${Math.max(1, steps.length - 9 + index)} / ассистент: ${step.assistant}`,
    step.newCards?.length ? `Новые карточки: ${step.newCards.join('; ')}` : ''
  ].filter(Boolean)).join('\n\n');
}

function parseJsonObject(text) {
  const value = normalize(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const source = fenced ?? value;
  const objectText = source.match(/\{[\s\S]*\}/u)?.[0] ?? source;
  return JSON.parse(objectText);
}

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output ?? [])
    .flatMap((item) => item?.content ?? [])
    .map((content) => content?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function validateDecision(decision, fallbackDecision) {
  const user = normalize(decision?.user);
  const phase = normalize(decision?.phase) || fallbackDecision.phase;
  if (decision?.done === true) return { ...fallbackDecision, done: true, phase: 'done', user: '' };
  if (!user || user.length < 12 || scriptedOperatorTextPattern.test(user)) return fallbackDecision;
  const leadForm = decision?.leadForm && typeof decision.leadForm === 'object'
    ? {
        name: normalize(decision.leadForm.name || fallbackDecision.leadForm?.name),
        phone: normalize(decision.leadForm.phone || fallbackDecision.leadForm?.phone),
        email: normalize(decision.leadForm.email || fallbackDecision.leadForm?.email),
        question: normalize(decision.leadForm.question || fallbackDecision.leadForm?.question)
      }
    : fallbackDecision.leadForm ?? null;
  if (leadForm && hasInlineLeadContact(user)) {
    return { ...fallbackDecision, leadForm: fallbackDecision.leadForm ?? leadForm };
  }
  const acceptedLeadForm = leadForm && commitsToLeadSubmission(user) ? leadForm : null;
  return {
    phase,
    user,
    rationale: normalize(decision?.rationale || decision?.reason || fallbackDecision.rationale),
    done: false,
    leadForm: acceptedLeadForm,
    source: decision?.source || 'llm'
  };
}

function coverageFromSteps(steps) {
  const userMessages = steps.map((step) => lower(step.user));
  const userText = userMessages.join('\n');
  const assistantText = lower(steps.map((step) => step.assistant).join('\n'));
  const cardText = lower(steps.flatMap((step) => step.newCards ?? []).join('\n'));
  const allText = `${userText}\n${assistantText}\n${cardText}`;
  return {
    askedGeneratorNeed: /генератор|резервн|отключен/iu.test(userText),
    answeredPumpDetails: userMessages.some((message) =>
      /насос[^.!?\n]{0,120}(?:220\s*в|750\s*вт|0[,.]?75\s*квт|шильдик|модель|точн|не\s+помню|не\s+знаю|кВт|Вт)/iu.test(message) ||
      /(?:220\s*в|750\s*вт|0[,.]?75\s*квт|шильдик|модель|точн|не\s+помню|не\s+знаю|кВт|Вт)[^.!?\n]{0,120}насос/iu.test(message)
    ),
    answeredBoilerDetails: userMessages.slice(1).some((message) =>
      message.includes('кот') && [
        'мощность котла',
        'ток котла',
        'шильдик котла',
        'тип котла',
        'мощность не знаю',
        'мощность точно не знаю',
        'мощность не помню'
      ].some((signal) => message.includes(signal))
    ),
    askedGeneratorCatalog: userMessages.some((message) =>
      /(?:покаж|вариант|модел|карточ)/iu.test(message) && /генератор/iu.test(message)
    ),
    sawGeneratorCards: /генератор/iu.test(cardText),
    askedPlateNeed: /виброплит/iu.test(userText),
    askedPlateCatalog: userMessages.some((message) =>
      /(?:покаж|вариант|модел|карточ)/iu.test(message) && /виброплит/iu.test(message)
    ),
    sawPlateCards: /виброплит/iu.test(cardText),
    askedDelivery: /доставк|налич|скидк|заказ/iu.test(userText),
    submittedLead: steps.some((step) => step.leadSubmission?.submitted || step.leadForm),
    assistantDiscussedDelivery: /доставк|налич|логист|услов|уточн/iu.test(assistantText),
    allText
  };
}

export function adaptiveBuyerReadyForLeadSubmission(steps, goal = defaultAdaptiveBuyerGoal, turnIndex = steps.length) {
  const coverage = coverageFromSteps(steps);
  return (turnIndex + 1) >= (goal.minTurnsBeforeLead ?? 0) &&
    coverage.askedGeneratorNeed &&
    coverage.sawGeneratorCards &&
    coverage.askedPlateNeed &&
    coverage.askedPlateCatalog &&
    coverage.sawPlateCards &&
    coverage.askedDelivery;
}

function assistantAsksPumpClarification(answer) {
  return /насос/iu.test(answer) &&
    /(?:мощност|кВт|Вт|шильдик|модель|какой|тип|220|напряж)/iu.test(answer) &&
    /\?/u.test(answer);
}

function questionSegments(answer) {
  const text = lower(answer);
  const segments = [];
  let questionEnd = text.indexOf('?');
  while (questionEnd >= 0) {
    const sentenceStart = Math.max(
      text.lastIndexOf('.', questionEnd - 1),
      text.lastIndexOf('!', questionEnd - 1),
      text.lastIndexOf('?', questionEnd - 1)
    );
    segments.push(text.slice(sentenceStart + 1, questionEnd));
    questionEnd = text.indexOf('?', questionEnd + 1);
  }
  return segments;
}

function assistantAsksBoilerClarification(answer) {
  return questionSegments(answer).some((question) =>
    question.includes('кот') && ['мощ', 'ток', 'шильд', 'тип'].some((signal) => question.includes(signal))
  );
}

function fallbackDecision({ goal, steps, turnIndex }) {
  if (!steps.length) {
    return {
      phase: 'start_generator_need',
      user: goal.startUser,
      rationale: 'Начинаю с цели покупателя по генератору.',
      source: 'fallback'
    };
  }

  const lastAssistant = steps.at(-1)?.assistant ?? '';
  const coverage = coverageFromSteps(steps);

  if (!coverage.answeredPumpDetails && assistantAsksPumpClarification(lastAssistant)) {
    return {
      phase: 'answer_pump_clarification',
      user: fallbackPhrase([
        'Насос скважинный на 220 В, мощность точно не помню, вроде около 750 Вт. Котел газовый с электроникой, холодильник один, инструмент от генератора включать не планирую.',
        'Насос обычный скважинный, 220 В, ориентировочно 750 Вт; точную модель пока не нашел. Котел газовый с электроникой, холодильник один, инструмент подключать не буду.',
        'Уточню по насосу: скважинный, 220 В, примерно 750 Вт. Модель сейчас не под рукой. Котел газовый с электроникой, холодильник один, без инструмента.',
        'По насосу пока такой ориентир: скважинный 220 В и около 750 Вт, точную модель посмотрю позже. Котел газовый с электроникой, холодильник один, инструмент не планирую.'
      ]),
      rationale: 'Ассистент спросил про насос, поэтому покупатель сначала отвечает на уточнение.',
      source: 'fallback'
    };
  }

  if (!coverage.answeredBoilerDetails && assistantAsksBoilerClarification(lastAssistant)) {
    return {
      phase: 'answer_boiler_clarification',
      user: 'Котел газовый с электроникой, точную мощность не знаю. Холодильник обычный, свет и насос будут работать в обычном режиме.',
      rationale: 'Ассистент спросил данные котла, поэтому покупатель сначала отвечает на это уточнение.',
      source: 'fallback'
    };
  }

  if (!coverage.answeredPumpDetails && turnIndex <= 2) {
    return {
      phase: 'add_pump_details',
      user: 'По насосу могу сказать так: обычный скважинный 220 В, примерно 750 Вт. Точную модель сейчас не вижу.',
      rationale: 'Даю данные, которые нужны для подбора мощности.',
      source: 'fallback'
    };
  }

  if (!coverage.sawGeneratorCards) {
    return {
      phase: 'request_generator_catalog',
      user: 'Покажите тогда пару нормальных генераторов из каталога, чтобы был запас под насос и котел, но без огромной переплаты.',
      rationale: 'После расчета покупатель просит конкретные варианты.',
      source: 'fallback'
    };
  }

  if (!coverage.askedPlateNeed) {
    return {
      phase: 'switch_to_plate_need',
      user: fallbackPhrase([
        'Еще нужна виброплита для въезда под плитку. Там песок и щебень, площадь небольшая, грузить буду сам. Какой вес смотреть?',
        'Отдельно хочу подобрать виброплиту для въезда под плитку: песок и щебень, площадь небольшая, грузить буду сам. Какой вес разумнее?',
        'И по второй задаче нужна виброплита для небольшого въезда под плитку, основание из песка и щебня. Возить и грузить буду сам, какой вес взять?'
      ], 1),
      rationale: 'Основная генераторная часть закрыта, покупатель добавляет вторую реальную задачу.',
      source: 'fallback'
    };
  }

  if (!coverage.askedPlateCatalog || !coverage.sawPlateCards) {
    return {
      phase: 'request_plate_catalog',
      user: fallbackPhrase([
        'Покажите из каталога виброплиты примерно 80-100 кг и скажите, нужен ли коврик под плитку.',
        'Какие виброплиты из каталога есть примерно на 80-100 кг? И нужен ли защитный коврик под плитку?',
        'Подберите, пожалуйста, по каталогу виброплиты в районе 80-100 кг и подскажите насчет коврика для плитки.'
      ], 2),
      rationale: 'Покупатель просит конкретные карточки под вторую задачу.',
      source: 'fallback'
    };
  }

  if (!coverage.askedDelivery) {
    return {
      phase: 'ask_delivery_availability',
      user: fallbackPhrase([
        'Если брать генератор и виброплиту, доставка до Азова у вас бывает? И наличие по этим позициям можно уточнить?',
        'Подскажите, если взять генератор и виброплиту, сможете проверить доставку до Азова и наличие обеих позиций?',
        'Как с доставкой до Азова и наличием, если оформлять вместе генератор и виброплиту? Это можно уточнить?'
      ], 3),
      rationale: 'После подбора покупатель переходит к покупке и условиям.',
      source: 'fallback'
    };
  }

  const contact = goal.leadForm ?? defaultAdaptiveBuyerGoal.leadForm;
  return {
    phase: 'leave_contact_for_order_check',
    user: fallbackPhrase([
      'Хорошо, давайте заявку, я оставлю контакт в форме. Нужно уточнить наличие выбранного генератора, виброплиты и доставку.',
      'Тогда оставлю контакт через форму, чтобы проверить наличие генератора, виброплиты и доставку до Азова.',
      'Готов оставить заявку через форму: проверьте, пожалуйста, наличие обеих выбранных позиций и доставку.'
    ], 4),
    rationale: 'Цель почти закрыта, покупатель готов оставить контакт для проверки наличия и доставки.',
    source: 'fallback',
    leadForm: contact
  };
}

function buildBuyerPrompt({ goal, steps, turnIndex }) {
  const last = steps.at(-1);
  return [
    'Ты играешь реального покупателя интернет-магазина строительной и силовой техники. Ты не тестировщик, не оператор и не сценарист.',
    '',
    `Личность покупателя: ${goal.persona}`,
    `Цель покупателя: ${goal.objective}`,
    'Данные и ограничения покупателя:',
    ...(goal.constraints ?? []).map((item) => `- ${item}`),
    '',
    'Правила следующей реплики:',
    '- Прочитай последний ответ ассистента и видимые карточки.',
    '- Если ассистент задал уточняющий вопрос, сначала ответь именно на него.',
    '- Не следуй заранее написанному маршруту. Выбери следующий логичный ход к цели покупателя.',
    '- Пиши обычной фразой покупателя, 1-2 предложения.',
    '- Не используй формулировки вроде "без заявки и телефона", "финально", "что вы будете сверять"; так покупатель не говорит.',
    '- Когда уже есть разумный подбор и вопрос упирается в наличие/доставку, можно оставить имя и телефон.',
    '- Верни только JSON.',
    '',
    `Номер следующего хода покупателя: ${turnIndex + 1} из максимум ${goal.maxTurns}.`,
    '',
    'История диалога:',
    transcriptForPrompt(steps) || '(диалог еще не начался)',
    '',
    last?.newCards?.length ? `Последние новые карточки: ${last.newCards.join('; ')}` : 'Последних новых карточек нет.',
    '',
    'Формат JSON:',
    '{"phase":"short_snake_case","user":"реплика покупателя","rationale":"почему это следующий логичный ход","leadForm":null}',
    '',
    `Если покупатель оставляет заявку через форму, user не должен включать имя и телефон; эти данные укажи только в leadForm: ${goal.leadForm?.name}, ${goal.leadForm?.phone}.`
  ].join('\n');
}

async function llmDecision({ goal, steps, turnIndex, signal }) {
  if (!process.env.OPENAI_API_KEY || process.env.ADAPTIVE_BUYER_OFFLINE === '1') return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const model = process.env.OPENAI_ADAPTIVE_BUYER_MODEL ||
    process.env.OPENAI_PLANNER_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-5.6-terra';
  const response = await client.responses.create({
    model,
    reasoning: { effort: process.env.OPENAI_ADAPTIVE_BUYER_REASONING_EFFORT || 'low' },
    input: [
      {
        role: 'system',
        content: 'Generate the next Russian buyer chat turn as JSON only. Do not include chain-of-thought.'
      },
      {
        role: 'user',
        content: buildBuyerPrompt({ goal, steps, turnIndex })
      }
    ],
    max_output_tokens: 900
  }, signal ? { signal } : undefined);
  return parseJsonObject(outputText(response));
}

export async function nextAdaptiveBuyerTurn({
  goal = defaultAdaptiveBuyerGoal,
  steps = [],
  turnIndex = steps.length,
  forceOffline = false,
  signal
} = {}) {
  const fallback = fallbackDecision({ goal, steps, turnIndex });
  if (forceOffline) return fallback;
  try {
    const decision = await llmDecision({ goal, steps, turnIndex, signal });
    if (!decision) return fallback;
    const validated = validateDecision(decision, fallback);
    if (validated.leadForm && !adaptiveBuyerReadyForLeadSubmission(steps, goal, turnIndex)) {
      return {
        ...fallback,
        source: `fallback_guarded_premature_lead_${validated.source ?? 'llm'}`
      };
    }
    if (!coversFallbackStep(validated, fallback)) {
      return {
        ...fallback,
        source: `fallback_guarded_${validated.source ?? 'llm'}`
      };
    }
    return validated;
  } catch (error) {
    return {
      ...fallback,
      source: 'fallback_after_llm_error',
      llmError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function evaluateAdaptiveGoalProgress(steps, goal = defaultAdaptiveBuyerGoal) {
  const coverage = coverageFromSteps(steps);
  const issues = [];
  if (!coverage.askedGeneratorNeed) issues.push('buyer_goal_missing_generator_need');
  if (!coverage.answeredPumpDetails) issues.push('buyer_goal_missing_pump_details');
  if (!coverage.askedGeneratorCatalog && !coverage.sawGeneratorCards) issues.push('buyer_goal_missing_generator_catalog_request');
  if (!coverage.sawGeneratorCards) issues.push('assistant_missing_generator_cards_for_goal');
  if (!coverage.askedPlateNeed) issues.push('buyer_goal_missing_plate_need');
  if (!coverage.askedPlateCatalog) issues.push('buyer_goal_missing_plate_catalog_request');
  if (!coverage.sawPlateCards) issues.push('assistant_missing_plate_cards_for_goal');
  if (!coverage.askedDelivery) issues.push('buyer_goal_missing_delivery_or_availability_step');
  if (!coverage.assistantDiscussedDelivery) issues.push('assistant_missing_delivery_or_availability_answer');
  if (!coverage.submittedLead) issues.push('buyer_goal_missing_lead_submission');

  steps.forEach((step, index) => {
    const next = steps[index + 1];
    const coverageBeforeNextTurn = coverageFromSteps(steps.slice(0, index + 1));
    if (next && assistantAsksPumpClarification(step.assistant) &&
      !coverageBeforeNextTurn.answeredPumpDetails &&
      !/(насос|220|мощност|шильдик|кВт|Вт)/iu.test(next.user)) {
      issues.push(`assistant_clarification_ignored_after_turn_${index + 1}`);
    }
  });

  return {
    ok: issues.length === 0,
    issues,
    coverage,
    goal: {
      scenarioName: goal.scenarioName,
      persona: goal.persona,
      objective: goal.objective
    }
  };
}
