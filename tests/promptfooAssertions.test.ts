import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  assertAgentTaskCompletion,
  assertBusinessRules,
  assertSupportAnswerQuality
} = require('../evals/promptfoo/assertions.cjs') as {
  assertAgentTaskCompletion: (output: unknown, context?: unknown) => { pass: boolean; reason: string; score: number };
  assertBusinessRules: (output: unknown, context?: unknown) => { pass: boolean; reason: string; score: number };
  assertSupportAnswerQuality: (output: unknown, context?: unknown) => { pass: boolean; reason: string; score: number };
};

function outputWithTurns(turns: Array<Record<string, unknown>>) {
  return JSON.stringify({
    turns,
    final: turns[turns.length - 1] ?? null
  });
}

function outputWithAnswers(answers: string[]) {
  return outputWithTurns(answers.map((answer) => ({ ok: true, answer })));
}

describe('promptfoo business-rule assertions', () => {
  it('does not flag safe commercial non-confirmation as a discount promise', () => {
    const result = assertBusinessRules(outputWithAnswers([
      'Подобрал генератор под ваши условия.',
      'По доставке и скидке при самовывозе я сейчас точно не подтвержу. Лучше оставить контакт в форме: менеджер проверит условия.'
    ]), {});

    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('still flags explicit discount promises', () => {
    const result = assertBusinessRules(outputWithAnswers([
      'Скидку точно сделаем, доставка будет сегодня.'
    ]), {});

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('promptfoo structured completion assertions', () => {
  it('accepts product-class completion from metadata without fixed product text in the final answer', () => {
    const output = outputWithTurns([
      {
        ok: true,
        answer: 'Для подготовки основания под плитку подойдут модели 60-75 кг.',
        metadata: {
          selectionReadiness: { productClass: 'plate' },
          cardSelection: { intent: 'plate' }
        }
      },
      {
        ok: true,
        answer: 'Под ваш бюджет подходит TSS-WP60L. Она легкая и ее реально перевозить одному.',
        metadata: {
          selectionReadiness: { productClass: 'plate' },
          cardSelection: { intent: 'plate' }
        }
      }
    ]);

    const support = assertSupportAnswerQuality(output, {
      config: {
        minAnswerChars: 50,
        expectedProductClasses: ['plate']
      }
    });
    const completion = assertAgentTaskCompletion(output, {
      config: {
        expectedProductClasses: ['plate']
      }
    });

    expect(support.pass).toBe(true);
    expect(completion.pass).toBe(true);
  });
});
