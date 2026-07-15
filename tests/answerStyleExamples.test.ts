import { describe, expect, it } from 'vitest';
import {
  approvedAnswerStyleExamples,
  approvedAnswerStyleExamplesPromptBlock
} from '../src/ai/answerStyleExamples.js';

describe('approved answer style examples', () => {
  it('stores user-approved style examples as annotated style evidence, not templates', () => {
    const example = approvedAnswerStyleExamples.find((item) =>
      item.id === 'exact_model_key_or_button_simple_shop_voice'
    );

    expect(example).toBeTruthy();
    expect(example?.approvedByUser).toBe(true);
    expect(example?.approvalNote).toContain('явного подтверждения пользователя');
    expect(example?.approvalNote).toContain('только после отдельного вопроса');
    expect(example?.buyerQuestion).toContain('с ключа или с кнопки');
    expect(example?.approvedStyleAnswer).toContain('RD3910E заводится с ключа');
    expect(example?.copyStyleSignals.join('\n')).toContain('без лишнего "да"');
    expect(example?.copyStyleSignals.join('\n')).toContain('человек человеку');
    expect(example?.doNotCopy.join('\n')).toContain('Не копировать модель');
    expect(example?.doNotCopy.join('\n')).toContain('Не использовать фразу как шаблон');
  });

  it('renders a prompt block that forbids copying facts while preserving the desired tone', () => {
    const block = approvedAnswerStyleExamplesPromptBlock();

    expect(block).toContain('Пул одобренных примеров стиля');
    expect(block).toContain('только после отдельного вопроса пользователю');
    expect(block).toContain('явного согласия');
    expect(block).toContain('Нельзя добавлять сюда примеры по инициативе агента');
    expect(block).toContain('не являются шаблонами');
    expect(block).toContain('не являются источником фактов');
    expect(block).toContain('Используй только тон');
    expect(block).toContain('RD3910E заводится с ключа');
  });
});
