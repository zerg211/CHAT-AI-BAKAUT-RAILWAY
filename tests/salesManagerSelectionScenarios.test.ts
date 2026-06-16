import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ScenarioFixture {
  focusedScenarios: Array<{
    buyerUtteranceVariants: string[];
    expectedBehavior: string[];
  }>;
  longDialogueScenario: {
    turns: string[];
    expectedBehavior: string[];
  };
}

const scenarios = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'salesManagerSelectionScenarios.json'), 'utf8')
) as ScenarioFixture;

describe('sales manager selection scenario fixtures', () => {
  it('keeps focused scenarios semantic instead of single-phrase regex checks', () => {
    expect(scenarios.focusedScenarios.length).toBeGreaterThanOrEqual(5);

    for (const scenario of scenarios.focusedScenarios) {
      expect(scenario.buyerUtteranceVariants.length).toBeGreaterThanOrEqual(3);
      expect(scenario.expectedBehavior.length).toBeGreaterThanOrEqual(3);
      expect(scenario.expectedBehavior.join(' ')).not.toMatch(/contains exact phrase|regex|keyword only/i);
    }
  });

  it('contains the long dialogue regression for topic switches and returning to prior need', () => {
    expect(scenarios.longDialogueScenario.turns.length).toBeGreaterThanOrEqual(8);
    expect(scenarios.longDialogueScenario.turns.join(' ')).toContain('генератор');
    expect(scenarios.longDialogueScenario.turns.join(' ')).toContain('Вернемся к виброплите');
    expect(scenarios.longDialogueScenario.expectedBehavior).toEqual(expect.arrayContaining([
      'preserve plate requirements when returning to plate topic',
      'do not leak plate budget/weight constraints into generator topic',
      'do not show stale plate cards for generator topic'
    ]));
  });
});
