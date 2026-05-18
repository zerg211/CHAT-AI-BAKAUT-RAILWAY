import { describe, expect, it } from 'vitest';
import {
  answersActionableAssistantQuestion,
  detectActionableAssistantQuestion,
  dialogueContinuityIssues
} from './liveDialogueContinuity.mjs';

describe('live dialogue continuity', () => {
  it('flags a scripted jump when the assistant asked for voltage and simultaneous start details', () => {
    const assistant = 'Уточните только два момента: есть ли 380 В нагрузки и могут ли ворота запускаться одновременно с морозильником или насосом?';
    const question = detectActionableAssistantQuestion(assistant);

    expect(question?.topics).toEqual(expect.arrayContaining(['voltage', 'simultaneous_start']));
    expect(question?.topics).not.toContain('pump_details');
    expect(answersActionableAssistantQuestion(question, 'Теперь отдельно другой запрос: нужен генератор примерно 13 кВт.')).toBe(false);

    const issues = dialogueContinuityIssues([
      {
        phase: 'changed_loads_generator_calculation',
        user: 'Какую мощность генератора смотреть?',
        assistant
      },
      {
        phase: 'explicit_generator_13kw',
        user: 'Теперь отдельно другой запрос: нужен генератор примерно 13 кВт.',
        assistant: 'Показываю варианты.'
      }
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0].topics).toEqual(expect.arrayContaining(['voltage', 'simultaneous_start']));
  });

  it('accepts a buyer turn that first answers the assistant clarification', () => {
    const assistant = 'Уточните только два момента: есть ли 380 В нагрузки и могут ли ворота запускаться одновременно с морозильником или насосом?';
    const question = detectActionableAssistantQuestion(assistant);
    const user = '380 В нет, все обычное 220 В. Ворота могут сработать, пока морозильник работает, но специально одновременно ничего не запускаю.';

    expect(answersActionableAssistantQuestion(question, user)).toBe(true);
    expect(dialogueContinuityIssues([
      { user: 'Какую мощность генератора смотреть?', assistant },
      { user, assistant: 'Тогда смотрите 3-4 кВт.' }
    ])).toEqual([]);
  });

  it('detects pump-detail questions only when the assistant asks for pump data', () => {
    const question = detectActionableAssistantQuestion('Для насоса важна пусковая нагрузка. Насос у вас 220 В и какая у него мощность?');

    expect(question?.topics).toEqual(expect.arrayContaining(['voltage', 'pump_details']));
    expect(answersActionableAssistantQuestion(question, 'Насос 220 В, примерно 750 Вт, точную модель не помню.')).toBe(true);
  });
});
