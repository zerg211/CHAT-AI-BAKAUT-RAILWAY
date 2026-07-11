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
  });
});
