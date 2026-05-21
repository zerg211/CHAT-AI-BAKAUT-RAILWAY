import { describe, expect, it } from 'vitest';

import {
  activeNeedSchema,
  needExtractionCriteriaSchema,
  needExtractionSelectionStateSchema,
  needItemSchema,
  semanticMemorySchema
} from '../src/ai/assistantNeedExtractionSchemas.js';

describe('assistant need extraction schemas', () => {
  it('keeps need item and active need schema contracts stable', () => {
    const needItem = needItemSchema() as any;
    const activeNeed = activeNeedSchema() as any;

    expect(needItem.additionalProperties).toBe(false);
    expect(needItem.required).toEqual(['value', 'evidence', 'confidence']);
    expect(needItem.properties.confidence).toEqual({ type: 'number', minimum: 0, maximum: 1 });

    expect(activeNeed.required).toEqual([
      'id',
      'productClass',
      'summary',
      'constraints',
      'openQuestions',
      'selectedProductIds',
      'status'
    ]);
    expect(activeNeed.properties.productClass.enum).toContain('commercial');
    expect(activeNeed.properties.productClass.enum).toContain('unknown');
    expect(activeNeed.properties.constraints.maxItems).toBe(16);
    expect(activeNeed.properties.openQuestions.maxItems).toBe(12);
  });

  it('keeps selection state schema nested constraints intact', () => {
    const criteria = needExtractionCriteriaSchema() as any;
    const selectionState = needExtractionSelectionStateSchema() as any;

    expect(criteria.required).toContain('productIntent');
    expect(criteria.required).toContain('excludedClasses');
    expect(criteria.properties.productIntent.enum).toContain('generator');
    expect(criteria.properties.productIntent.enum).not.toContain('commercial');
    expect(criteria.properties.fuel.enum).toEqual(['gasoline', 'diesel', 'any', 'unknown']);
    expect(criteria.properties.mustHaveTraits.maxItems).toBe(16);

    expect(selectionState.required).toEqual([
      'currentProductClass',
      'targetProductClass',
      'hardConstraints',
      'softPreferences',
      'unknowns',
      'conflicts',
      'selectedProductIds',
      'loadProfile',
      'confidence'
    ]);
    expect(selectionState.properties.hardConstraints.required).toEqual(criteria.required);
    expect(selectionState.properties.loadProfile.properties.items.maxItems).toBe(16);
    expect(selectionState.properties.loadProfile.properties.items.items.properties.source.enum).toEqual([
      'explicit_user',
      'estimated_average',
      'web_average',
      'catalog_fact'
    ]);
  });

  it('keeps semantic memory schema as the planner memory contract', () => {
    const memory = semanticMemorySchema() as any;
    const requirement = memory.properties.requirements.items;
    const mentionedProduct = memory.properties.mentionedProducts.items;
    const selectionPolicy = memory.properties.selectionPolicy;
    const botCommitments = memory.properties.botCommitments;

    expect(memory.required).toEqual([
      'version',
      'activeRequirementIds',
      'requirements',
      'mentionedProducts',
      'selectionPolicy',
      'botCommitments'
    ]);
    expect(memory.properties.version.enum).toEqual([1]);
    expect(memory.properties.requirements.maxItems).toBe(40);
    expect(requirement.properties.kind.enum).toContain('weightKg');
    expect(requirement.properties.value.required).toEqual(['text', 'min', 'max', 'unit', 'productClass', 'brand', 'amount']);
    expect(mentionedProduct.properties.role.enum).toContain('compatibilityTarget');
    expect(selectionPolicy.properties.alternativeMode.enum).toEqual(['none', 'afterPrimary', 'fallbackOnly']);
    expect(botCommitments.maxItems).toBe(30);
    expect(botCommitments.items.properties.kind.enum).toEqual(['availability', 'recommendation', 'constraint', 'fact']);
  });
});
