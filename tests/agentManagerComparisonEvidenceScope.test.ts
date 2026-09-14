import { describe, expect, it } from 'vitest';
import type { AgentIntentContract, ToolRequest } from '../src/ai/agentManagerContracts.js';
import {
  comparisonAttributesForExecution,
  comparisonResearchRequiresFreshWeb
} from '../src/ai/agentManagerToolExecutor.js';
import { plannerSystemPromptBlock } from '../src/ai/agentManagerModelAdapter.js';

function intent(overrides: Partial<NonNullable<AgentIntentContract['grounding']>> = {}) {
  return {
    grounding: {
      taskType: 'comparison',
      responseMode: 'compare',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      buyerRequestedWeb: false,
      catalogRequirement: 'required',
      requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
      technicalAttributes: ['weight_kg', 'noise_level_db', 'noise_measurement_conditions'],
      buyerQuestion: 'Сравните вес и шум двух моделей.',
      rationale: 'The comparison needs current evidence.',
      ...overrides
    }
  } as AgentIntentContract;
}

function request(attributes = ['noise_level_db']) {
  return {
    id: 'research-comparison',
    tool: 'web.researchProductFacts',
    required: true,
    rationale: 'Check exact products.',
    coversRequirementIds: [],
    args: { comparisonAttributes: attributes }
  } as ToolRequest;
}

describe('exact comparison evidence scope', () => {
  it('tells the planner to preserve source and measurement comparability', () => {
    const prompt = plannerSystemPromptBlock('Сравните вес и шум двух моделей.');
    expect(prompt).toContain('включай все grounding.technicalAttributes');
    expect(prompt).toContain('без вывода о практическом превосходстве');
  });

  it('freshly checks every structured comparison attribute when web evidence is required', () => {
    const planned = intent();
    const plannedRequest = request();

    expect(comparisonAttributesForExecution(planned, plannedRequest)).toEqual([
      'noise_level_db',
      'weight_kg',
      'noise_measurement_conditions'
    ]);
    expect(comparisonResearchRequiresFreshWeb(planned, plannedRequest)).toBe(true);
  });

  it('does not broaden a catalog-owned comparison or a non-comparison request', () => {
    const catalogOwned = intent({ sourcePolicy: 'catalog_required', webRequirement: 'conditional_on_catalog_gap' });
    expect(comparisonAttributesForExecution(catalogOwned, request())).toEqual(['noise_level_db']);
    expect(comparisonResearchRequiresFreshWeb(catalogOwned, request())).toBe(false);

    const conditionalWeb = intent({ webRequirement: 'conditional_on_catalog_gap' });
    expect(comparisonAttributesForExecution(conditionalWeb, request())).toEqual(['noise_level_db']);
    expect(comparisonResearchRequiresFreshWeb(conditionalWeb, request())).toBe(false);

    const selection = intent({ taskType: 'product_selection', webRequirement: 'buyer_requested' });
    expect(comparisonAttributesForExecution(selection, request())).toEqual(['noise_level_db']);
    expect(comparisonResearchRequiresFreshWeb(selection, request())).toBe(true);
  });
});
