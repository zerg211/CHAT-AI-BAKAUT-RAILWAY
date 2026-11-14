import { describe, expect, it } from 'vitest';
import { guardCustomerOutput } from '../src/ai/agentManagerOutputGuard.js';

describe('customer output guard precision', () => {
  it('allows legitimate product language that collides with generic stems', () => {
    for (const answerText of [
      'Внутренний диаметр диска 350 мм — уточню по вашей модели.',
      'Повторная попытка запуска не удалась — опишите, что происходит при старте?',
      'Статус выполнения заказа уточню у менеджера склада.',
      'Ошибка timeout у контроллера означает превышение времени ожидания.',
      'Настройка таймаута оборудования зависит от модели.',
      'Параметр retry задаёт число повторов запуска контроллера.',
      'Функция recovery восстанавливает настройки оборудования.',
      'Промежуточный результат измерения мощности составляет 5 кВт.',
      'Planner входит в название программного модуля оборудования.'
    ]) {
      expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(true);
    }
  });

  it('still blocks genuine internal process disclosure', () => {
    for (const answerText of [
      'Внутренний planner получил timeout web tool и запустил recovery.',
      'Подождите, это промежуточный результат поиска.',
      'Как я уже искал, вот вариант.',
      'The search tool completed after a retry in the pipeline.'
    ]) {
      expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(false);
    }
  });

  it('does not claim the literal guard detects semantic paraphrases', () => {
    for (const answerText of [
      'Пока только предварительные результаты поиска.',
      'Промежуточный результат поиска ниже.'
    ]) expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(true);
  });
});
