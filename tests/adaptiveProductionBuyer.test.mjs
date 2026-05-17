import { describe, expect, it } from 'vitest';
import {
  defaultAdaptiveBuyerGoal,
  evaluateAdaptiveGoalProgress,
  nextAdaptiveBuyerTurn
} from './adaptiveProductionBuyer.mjs';

describe('adaptive production buyer', () => {
  it('answers the assistant clarification instead of jumping to another product', async () => {
    const turn = await nextAdaptiveBuyerTurn({
      goal: defaultAdaptiveBuyerGoal,
      forceOffline: true,
      steps: [{
        phase: 'start_generator_need',
        user: defaultAdaptiveBuyerGoal.startUser,
        assistant: 'Для насоса важна пусковая нагрузка. Насос у вас 220 В и какая у него мощность?',
        newCards: []
      }]
    });

    expect(turn.phase).toBe('answer_pump_clarification');
    expect(turn.user).toMatch(/насос/iu);
    expect(turn.user).toMatch(/220\s*В|750\s*Вт|мощност/iu);
    expect(turn.user).not.toMatch(/виброплит/iu);
  });

  it('moves toward the buyer goal from answer to answer, not by a fixed phrase list', async () => {
    const steps = [];
    const first = await nextAdaptiveBuyerTurn({ goal: defaultAdaptiveBuyerGoal, forceOffline: true, steps });
    steps.push({ ...first, assistant: 'Ориентир можно считать после уточнения насоса. Насос 220 В?', newCards: [] });

    const second = await nextAdaptiveBuyerTurn({ goal: defaultAdaptiveBuyerGoal, forceOffline: true, steps });
    steps.push({ ...second, assistant: 'Тогда смотрите генераторы около 4-5 кВт. Могу показать варианты.', newCards: [] });

    const third = await nextAdaptiveBuyerTurn({ goal: defaultAdaptiveBuyerGoal, forceOffline: true, steps });
    expect(third.phase).toBe('request_generator_catalog');
    expect(third.user).toMatch(/генератор/iu);
    expect(third.user).toMatch(/покаж|вариант/iu);
  });

  it('audits goal coverage rather than exact scripted turns', () => {
    const steps = [
      {
        phase: 'start_generator_need',
        user: defaultAdaptiveBuyerGoal.startUser,
        assistant: 'Уточните насос.',
        newCards: []
      },
      {
        phase: 'answer_pump_clarification',
        user: 'Насос скважинный 220 В, примерно 750 Вт.',
        assistant: 'Подойдут генераторы 4-5 кВт.',
        newCards: []
      },
      {
        phase: 'request_generator_catalog',
        user: 'Покажите генераторы из каталога.',
        assistant: 'Вот варианты.',
        newCards: ['Генератор бензиновый 4 кВт']
      },
      {
        phase: 'switch_to_plate_need',
        user: 'Еще нужна виброплита для въезда.',
        assistant: 'Смотрите 80-100 кг.',
        newCards: []
      },
      {
        phase: 'request_plate_catalog',
        user: 'Покажите виброплиты 80-100 кг.',
        assistant: 'Вот варианты.',
        newCards: ['Виброплита бензиновая 90 кг']
      },
      {
        phase: 'ask_delivery_availability',
        user: 'Доставка и наличие по этим позициям как уточняется?',
        assistant: 'Доставку и наличие надо уточнить перед оформлением.',
        newCards: []
      },
      {
        phase: 'leave_contact_for_order_check',
        user: 'Меня зовут Алексей, телефон +7 900 000-00-11.',
        assistant: 'Заявку принял.',
        newCards: [],
        leadForm: defaultAdaptiveBuyerGoal.leadForm,
        leadSubmission: { submitted: true }
      }
    ];

    expect(evaluateAdaptiveGoalProgress(steps).ok).toBe(true);
  });
});
