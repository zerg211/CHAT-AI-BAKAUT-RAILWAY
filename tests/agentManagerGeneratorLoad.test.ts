import { describe, expect, it } from 'vitest';
import { buildGeneratorLoadToolPayload, hasUnconfirmedGeneratorLoadBasisResult } from '../src/ai/agentManagerGeneratorLoad.js';
import type { ToolRequest, ToolResult } from '../src/ai/agentManagerContracts.js';

function generatorLoadRequest(loads: Array<Record<string, unknown>>): ToolRequest {
  return {
    id: 'load',
    tool: 'calculator.generatorLoad',
    args: {
      query: null,
      semanticQuery: 'preliminary generator sizing for a 220 V dacha with borehole pump',
      productIntent: 'generator',
      limit: null,
      productIds: [],
      productNames: [],
      comparisonAttributes: [],
      loads,
      simultaneousStarting: true,
      simultaneousStartingKinds: ['pump', 'refrigerator'],
      estimateBasis: 'bounded_assumption',
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: 'buyer asked for preliminary options',
      notes: null
    },
    rationale: 'calculate preliminary generator class',
    required: true
  };
}

function toolResultFromPayload(payload: ReturnType<typeof buildGeneratorLoadToolPayload>): ToolResult {
  return {
    requestId: 'load',
    tool: 'calculator.generatorLoad',
    status: payload.profile ? 'ok' : 'not_found',
    payload: {
      loads: payload.loads,
      profile: payload.profile,
      estimateBasis: payload.estimateBasis
    },
    warnings: payload.warnings
  };
}

describe('Agent Manager generator load payload', () => {
  it('fills conservative defaults for bounded estimated loads with missing kW', () => {
    const payload = buildGeneratorLoadToolPayload({
      request: generatorLoadRequest([{
        kind: 'pump',
        name: 'borehole pump',
        count: 1,
        runningKw: null,
        startingKw: null,
        source: 'estimated_average',
        evidence: 'Borehole pump, 220 V, exact power unknown',
        basisKind: 'specific_type_or_function',
        basisSignals: [
          'consumer_type_known',
          'consumer_function_known',
          'voltage_or_phase_known',
          'simultaneous_operation_known'
        ]
      }]),
      userMessage: 'Насос скважинный, дом 220 В, мощность насоса не знаю.'
    });

    expect(payload.loads).toEqual([
      expect.objectContaining({
        kind: 'pump',
        runningKw: 1.1,
        startingKw: 3.5,
        source: 'estimated_average',
        basisKind: 'specific_type_or_function'
      })
    ]);
    expect(payload.profile?.requiredNominalKw).toBeGreaterThanOrEqual(3.5);
    expect(payload.warnings).toContain('generator_load_default_bounded_estimate:pump');
    expect(payload.warnings).toContain('generator_load_bounded_assumption');
    expect(payload.warnings).not.toContain('generator_load_unbounded_guess');
    expect(hasUnconfirmedGeneratorLoadBasisResult([toolResultFromPayload(payload)])).toBe(false);
  });

  it('keeps generic unknown pump loads unconfirmed', () => {
    const payload = buildGeneratorLoadToolPayload({
      request: generatorLoadRequest([{
        kind: 'pump',
        name: 'unknown pump',
        count: 1,
        runningKw: null,
        startingKw: null,
        source: 'estimated_average',
        evidence: 'Pump exists, but type and power are unknown',
        basisKind: 'generic_load_name',
        basisSignals: ['consumer_type_known']
      }]),
      userMessage: 'Есть насос, какой не знаю.'
    });

    expect(payload.loads).toEqual([]);
    expect(payload.profile).toBeUndefined();
    expect(payload.warnings).toContain('generator_load_bounded_basis_incomplete');
    expect(payload.warnings).toContain('generator_load_unbounded_guess');
    expect(hasUnconfirmedGeneratorLoadBasisResult([toolResultFromPayload(payload)])).toBe(true);
  });
});
