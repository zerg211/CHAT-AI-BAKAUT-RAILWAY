import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { selectedCardsContradictReadiness } from '../src/ai/agentManagerOrchestrator.js';
import type { AnswerSelectionReadiness } from '../src/ai/agentManagerContracts.js';

async function orchestratorSource() {
  return readFile(new URL('../src/ai/agentManagerOrchestrator.ts', import.meta.url), 'utf8');
}

function readiness(status: AnswerSelectionReadiness['status'], canShow: boolean): AnswerSelectionReadiness {
  return {
    productClass: 'generator',
    status,
    canShowProductCards: canShow,
    missingFacts: [],
    rationale: 'fixture rationale'
  } as AnswerSelectionReadiness;
}

describe('vague fit request narrows first', () => {
  it('keeps the empty-fit gate in planner and writer prompts', async () => {
    const source = await orchestratorSource();
    expect(source).toContain('Пустой fit-запрос');
    expect(source).toContain('preliminary_fit требует минимум одного заявленного требования');
    expect(source).toContain('Estimate-only с нулем заявленных требований');
    expect(source).toContain('только внутри равного fit, никогда как цель');
    expect(source).toContain('cards_selected_without_readiness');
    expect(source).not.toContain('(разные бренды/типы/цены, сильнейший первым)');
  });

  it('blocks cards selected while readiness forbids showing them', () => {
    expect(selectedCardsContradictReadiness({
      selectionReadiness: readiness('needs_more_info', false),
      selectedProductIds: ['p1']
    })).toBe('cards_selected_without_readiness');

    expect(selectedCardsContradictReadiness({
      selectionReadiness: readiness('ready_for_exact_cards', false),
      selectedProductIds: ['p1']
    })).toBe('cards_selected_without_readiness');

    expect(selectedCardsContradictReadiness({
      selectionReadiness: undefined,
      selectedProductIds: ['p1']
    })).toBe('cards_selected_without_readiness');
  });

  it('passes consistent readiness contracts', () => {
    expect(selectedCardsContradictReadiness({
      selectionReadiness: readiness('ready_for_preliminary_cards', true),
      selectedProductIds: ['p1']
    })).toBeNull();

    expect(selectedCardsContradictReadiness({
      selectionReadiness: readiness('needs_more_info', false),
      selectedProductIds: []
    })).toBeNull();

    expect(selectedCardsContradictReadiness({
      selectionReadiness: undefined,
      selectedProductIds: []
    })).toBeNull();
  });
});
