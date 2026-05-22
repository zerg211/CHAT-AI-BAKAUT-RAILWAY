export type ApprovedAnswerStyleExample = {
  id: string;
  approvedByUser: true;
  approvalNote: string;
  situation: string;
  buyerQuestion: string;
  approvedStyleAnswer: string;
  copyStyleSignals: string[];
  doNotCopy: string[];
};

export const approvedAnswerStyleExamples: ApprovedAnswerStyleExample[] = [
  {
    id: 'exact_model_key_or_button_simple_shop_voice',
    approvedByUser: true,
    approvalNote: 'Добавлено только после явного подтверждения пользователя, что стиль ответа подходит. Новые примеры можно добавлять только после отдельного вопроса и явного согласия пользователя.',
    situation: 'Покупатель спрашивает точную характеристику конкретной модели: запуск с ключа или с кнопки.',
    buyerQuestion: 'Firman RD3910E заводится с ключа или с кнопки?',
    approvedStyleAnswer: 'RD3910E заводится с ключа, через электростартер. Ручной запуск тоже есть. Кнопочный запуск по данным не вижу. У нас эта модель есть в каталоге.',
    copyStyleSignals: [
      'Сразу отвечает на выбор покупателя, без лишнего "да" перед вопросом "ключ или кнопка".',
      'Пишет короткими простыми фразами, как человек человеку.',
      'Отделяет подтвержденный факт от неподтвержденного без канцелярита.',
      'Говорит от лица магазина: "у нас", а не "в каталоге БАКАУТ".'
    ],
    doNotCopy: [
      'Не копировать модель, характеристику запуска или наличие как факт для других товаров.',
      'Не использовать фразу как шаблон целиком; переносить только тон, длину и способ объяснения.',
      'Не начинать с "да", если вопрос был выбором между вариантами, а не yes/no-вопросом.'
    ]
  }
];

export function approvedAnswerStyleExamplesPromptBlock(limit = 3) {
  const examples = approvedAnswerStyleExamples.slice(0, limit);
  if (!examples.length) return '';
  return [
    'Пул одобренных примеров стиля:',
    'Важно: этот пул пополняется только после отдельного вопроса пользователю и его явного согласия. Нельзя добавлять сюда примеры по инициативе агента или потому, что агент сам решил, что ответ хороший.',
    'Эти примеры не являются шаблонами и не являются источником фактов. Не копируй их дословно. Не переноси модели, характеристики, наличие или цены из примера в новый ответ без текущих проверенных фактов. Используй только тон, простоту, длину фраз и способ отделять подтвержденное от неподтвержденного.',
    ...examples.flatMap((example, index) => [
      `Пример ${index + 1}: ${example.situation}`,
      `Основание добавления: ${example.approvalNote}`,
      `Вопрос: ${example.buyerQuestion}`,
      `Ответ в нужном стиле: ${example.approvedStyleAnswer}`,
      `Что перенять по стилю: ${example.copyStyleSignals.join('; ')}.`,
      `Что нельзя копировать: ${example.doNotCopy.join('; ')}.`
    ])
  ].join('\n');
}
