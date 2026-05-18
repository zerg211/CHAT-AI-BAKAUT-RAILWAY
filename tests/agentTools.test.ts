import { describe, expect, it } from 'vitest';
import type { AgentToolPlanStepV2 } from '../src/shared/types.js';
import { AgentToolRegistry, plannedToolTrace } from '../src/ai/agentTools.js';
import { emptyNeedState } from '../src/ai/needState.js';

const step: AgentToolPlanStepV2 = {
  tool: 'searchCatalog',
  reason: 'catalog search',
  required: true,
  inputHint: {}
};

const context = {
  sessionId: 's',
  userMessage: 'hello',
  history: [],
  needState: emptyNeedState()
};

describe('agent tool registry', () => {
  it('denies missing handlers with structured result', async () => {
    const registry = new AgentToolRegistry();
    const result = await registry.execute(step, context);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('tool_handler_missing');
    expect(result.warnings).toContain('tool_denied:tool_handler_missing');
  });

  it('denies createLead when policy forbids leads', async () => {
    const registry = new AgentToolRegistry({
      createLead: () => ({ tool: 'createLead', ok: true, risk: 'sensitive', warnings: [], durationMs: 0 })
    });
    const result = await registry.execute({
      tool: 'createLead',
      reason: 'lead',
      required: true,
      inputHint: {}
    }, { ...context, policy: { leadAllowed: false } });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('lead_not_allowed_by_policy');
  });

  it('represents planned tools as trace when existing runtime path executes them', () => {
    expect(plannedToolTrace([step])).toEqual([expect.objectContaining({
      tool: 'searchCatalog',
      ok: true,
      summary: 'represented_by_existing_runtime_path'
    })]);
  });
});
