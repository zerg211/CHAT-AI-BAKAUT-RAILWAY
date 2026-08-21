import { describe, expect, it } from 'vitest';
import {
  agentManagerToolRegistry,
  validateToolRequest,
  validateToolResultOutput
} from '../src/ai/agentManagerToolRegistry.js';

describe('agent manager strict tool registry', () => {
  it('accepts only catalog search arguments for catalog.search', () => {
    expect(validateToolRequest({
      id: 'search-1',
      tool: 'catalog.search',
      args: {
        query: 'виброплита для двора',
        productIntent: 'plate',
        limit: 8
      },
      rationale: 'Find matching catalog products.',
      required: true
    }).args).toEqual({
      query: 'виброплита для двора',
      productIntent: 'plate',
      limit: 8
    });
  });

  it('rejects foreign fields even when their values are empty placeholders', () => {
    for (const foreignArgs of [{ productNames: [] }, { contact: null }]) {
      expect(() => validateToolRequest({
        id: 'search-empty-foreign',
        tool: 'catalog.search',
        args: { query: 'generator', ...foreignArgs },
        rationale: 'Strict catalog search input.',
        required: true
      } as never)).toThrow();
    }
  });

  it('rejects a non-empty argument that belongs to another tool', () => {
    expect(() => validateToolRequest({
      id: 'search-1',
      tool: 'catalog.search',
      args: {
        query: 'генератор',
        contact: { phone: '+79000000000' }
      },
      rationale: 'Search only.',
      required: true
    } as never)).toThrow();
  });

  it('defines risk, side effect, timeout, result and retry bounds for every tool', () => {
    for (const definition of Object.values(agentManagerToolRegistry)) {
      expect(definition.timeoutMs).toBeGreaterThan(0);
      expect(definition.maxResultItems).toBeGreaterThan(0);
      expect(definition.maxResultBytes).toBeGreaterThan(0);
      expect(definition.maxAttempts).toBeGreaterThan(0);
      expect(definition.resultPayloadSchema).toBeDefined();
      expect(['safe_read', 'external_read', 'sensitive_write']).toContain(definition.risk);
    }
    expect(agentManagerToolRegistry['lead.capture']).toMatchObject({
      risk: 'sensitive_write',
      sideEffect: true,
      maxAttempts: 1
    });
    // Production traces #1842-#1848 exhausted the former 19.5-30s cap before
    // official/manual research could return. Keep a bounded but usable window;
    // the orchestrator still reserves final answer composition time from the turn budget.
    expect(agentManagerToolRegistry['web.researchProductFacts'].timeoutMs).toBe(30_000);
  });

  it('validates tool-specific result payloads and rejects unknown output fields', () => {
    const valid = validateToolResultOutput({
      requestId: 'search-1',
      tool: 'catalog.search',
      status: 'ok',
      payload: {
        query: 'генератор',
        productIds: ['p1'],
        products: [{ id: 'p1', name: 'Генератор', specs: {} }]
      },
      warnings: []
    });
    expect(valid.payload).toMatchObject({ productIds: ['p1'] });

    expect(validateToolResultOutput({
      requestId: 'web-source-tiers',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: true,
        researchOutcome: 'exhausted',
        sourceAttempts: [{
          tier: 'catalog',
          outcome: 'not_found'
        }, {
          tier: 'official_manual',
          outcome: 'not_found',
          query: 'exact model official manual PDF',
          sources: [{
            url: 'https://manufacturer.example/manual.pdf',
            host: 'manufacturer.example',
            documentKind: 'manual_or_specification',
            tier: 'official_manual',
            authority: 'manufacturer'
          }]
        }]
      },
      warnings: []
    }).payload).toMatchObject({
      sourceAttempts: expect.arrayContaining([
        expect.objectContaining({ tier: 'official_manual' })
      ])
    });

    const sourceList = Array.from({ length: 9 }, (_, index) => ({
      url: `https://manufacturer.example/manual-${index}.pdf`,
      host: 'manufacturer.example',
      documentKind: 'manual_or_specification' as const,
      tier: 'official_manual' as const,
      authority: 'manufacturer' as const
    }));
    expect(validateToolResultOutput({
      requestId: 'web-source-list',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        sourceAttempts: [{
          tier: 'official_manual',
          outcome: 'confirmed',
          query: 'exact model official manual PDF',
          sources: sourceList
        }]
      },
      warnings: []
    }).payload).toMatchObject({
      sourceAttempts: [{ sources: sourceList }]
    });

    expect(() => validateToolResultOutput({
      requestId: 'search-1',
      tool: 'catalog.search',
      status: 'ok',
      payload: { query: 'генератор', untrustedExtra: 'must not pass' },
      warnings: []
    })).toThrow();
    expect(() => validateToolResultOutput({
      requestId: 'lead-1',
      tool: 'lead.capture',
      status: 'ok',
      payload: { productIds: ['p1'] },
      warnings: []
    })).toThrow();

    expect(validateToolResultOutput({
      requestId: 'lead-partial',
      tool: 'lead.capture',
      status: 'not_found',
      payload: {
        missing: 'name',
        missingFields: ['name'],
        draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        draftSaved: true,
        contactStored: true,
        preferredContact: 'message',
        originalQuestionPreserved: true
      },
      warnings: ['lead_name_missing']
    }).payload).toMatchObject({ draftSaved: true, contactStored: true });
    expect(() => validateToolResultOutput({
      requestId: 'lead-partial-unsafe',
      tool: 'lead.capture',
      status: 'not_found',
      payload: { contact: { phone: '+79000000000' } },
      warnings: []
    })).toThrow();
  });
});
