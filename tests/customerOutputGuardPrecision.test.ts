import { describe, expect, it } from 'vitest';
import { guardCustomerOutput } from '../src/ai/agentManagerOutputGuard.js';

describe('customer output guard precision', () => {
  it('allows legitimate product language that collides with generic stems', () => {
    for (const answerText of [
      'Внутренний диаметр диска 350 мм — уточню по вашей модели.',
      'Повторная попытка запуска не удалась — опишите, что происходит при старте?',
      'Статус выполнения заказа уточню у менеджера склада.'
    ]) {
      expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(true);
    }
  });

  it('still blocks genuine internal process disclosure', () => {
    for (const answerText of [
      'Внутренний planner получил timeout web tool и запустил recovery.',
      'The web search completed after a retry in the pipeline.'
    ]) {
      expect(guardCustomerOutput({ answerText, productCards: [] }).ok).toBe(false);
    }
  });
});
