import { describe, expect, it } from 'vitest';
import {
  adaptiveBuyerReadyForLeadSubmission,
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

  it('does not repeat a pump clarification after the buyer already answered it', async () => {
    const turn = await nextAdaptiveBuyerTurn({
      goal: defaultAdaptiveBuyerGoal,
      forceOffline: true,
      steps: [{
        phase: 'start_generator_need',
        user: defaultAdaptiveBuyerGoal.startUser,
        assistant: 'Какая мощность и напряжение у насоса?',
        newCards: []
      }, {
        phase: 'answer_pump_clarification',
        user: 'Насос скважинный на 220 В, примерно 750 Вт, точную модель не помню.',
        assistant: 'Какой точный шильдик насоса?',
        newCards: []
      }]
    });

    expect(turn.phase).toBe('request_generator_catalog');
    expect(turn.user.toLocaleLowerCase('ru-RU')).toContain('генератор');
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
        user: 'Хорошо, я оставлю контакт в форме.',
        assistant: 'Заявку принял.',
        newCards: [],
        leadForm: defaultAdaptiveBuyerGoal.leadForm,
        leadSubmission: { submitted: true, method: 'form' }
      }
    ];

    expect(evaluateAdaptiveGoalProgress(steps).ok).toBe(true);
  });

  it('keeps form contact details out of the buyer chat text', async () => {
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
        assistant: 'Подойдут генераторы около 3 кВт.',
        newCards: ['Генератор бензиновый 3 кВт']
      },
      {
        phase: 'request_plate_catalog',
        user: 'Еще нужна виброплита для въезда, покажите варианты 70-90 кг.',
        assistant: 'Оставьте контакт, и я передам выбранные позиции на проверку.',
        newCards: ['Виброплита бензиновая 75 кг']
      },
      {
        phase: 'ask_delivery_availability',
        user: 'Доставка и наличие по этим позициям как уточняется?',
        assistant: 'Оставьте контакт, и я передам выбранные позиции на проверку.',
        newCards: []
      }
    ];

    const turn = await nextAdaptiveBuyerTurn({ goal: defaultAdaptiveBuyerGoal, forceOffline: true, steps });

    expect(turn.leadForm).toMatchObject(defaultAdaptiveBuyerGoal.leadForm);
    expect(turn.user).not.toContain(defaultAdaptiveBuyerGoal.leadForm.phone);
    expect(turn.user).not.toContain(defaultAdaptiveBuyerGoal.leadForm.name);
  });

  it('does not consider the buyer ready for a form before plate catalog coverage', () => {
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
        assistant: 'Показываю генераторы.',
        newCards: ['Генератор бензиновый 5 кВт']
      },
      {
        phase: 'ask_delivery_availability',
        user: 'А наличие и доставка по генератору есть?',
        assistant: 'Оставьте контакт, чтобы уточнить.',
        newCards: []
      },
      {
        phase: 'switch_to_plate_need',
        user: 'Еще нужна виброплита для въезда под плитку. Какой вес смотреть?',
        assistant: 'Смотрите 60-80 кг.',
        newCards: []
      }
    ];

    expect(adaptiveBuyerReadyForLeadSubmission(steps, defaultAdaptiveBuyerGoal, steps.length)).toBe(false);
  });

  it('requests plate catalog again instead of leaving a lead when plate cards are missing', async () => {
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
        assistant: 'Вот генераторы.',
        newCards: ['Генератор бензиновый 5 кВт']
      },
      {
        phase: 'request_plate_catalog',
        user: 'Покажите из каталога виброплиты примерно 80-100 кг.',
        assistant: 'Пока показал только генераторы.',
        newCards: []
      },
      {
        phase: 'ask_delivery_availability',
        user: 'Доставка и наличие по этим позициям как уточняется?',
        assistant: 'Можно оставить контакт.',
        newCards: []
      }
    ];

    const turn = await nextAdaptiveBuyerTurn({ goal: defaultAdaptiveBuyerGoal, forceOffline: true, steps });

    expect(turn.phase).toBe('request_plate_catalog');
    expect(turn.leadForm).toBeUndefined();
    expect(turn.user).toMatch(/виброплит/iu);
  });
});
