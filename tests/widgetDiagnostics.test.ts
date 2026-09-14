// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { adminReadinessLabel, adminRuntimeFlags, shouldShowLeadPanel } from '../src/client/widgetDiagnostics.js';

describe('widget/admin correctness diagnostics', () => {
  it('shows the contact panel only for the latest authorized assistant offer', () => {
    expect(shouldShowLeadPanel([{ role: 'assistant', leadRequested: false }])).toBe(false);
    expect(shouldShowLeadPanel([{ role: 'assistant', leadRequested: true }, { role: 'user' }])).toBe(true);
    expect(shouldShowLeadPanel([{ role: 'assistant', leadRequested: true }, { role: 'assistant', leadRequested: false }])).toBe(false);
    expect(shouldShowLeadPanel([{ role: 'assistant', leadRequested: true, status: 'done' },
      { role: 'assistant', leadRequested: false, status: 'sending' }])).toBe(true);
    expect(shouldShowLeadPanel([{ role: 'assistant', leadRequested: true, status: 'done' },
      { role: 'assistant', leadRequested: false, status: 'error' }])).toBe(true);
  });

  it('uses current readiness and flags partial unresolved research', () => {
    const metadata = {
      selectionReadiness: { status: 'blocked_by_answer_contract' },
      taskOutcome: { status: 'partially_resolved', unresolvedFacts: ['weight_net_kg'] },
      build: { commitSha: '1234567890abcdef' },
      policyGateEnforcement: { failedRequiredTools: ['web.researchProductFacts'] },
      warnings: ['source_timeout'],
      toolResults: [{ tool: 'web.researchProductFacts', warnings: ['tier_timeout'], payload: {
        researchOutcome: 'partial', searchDisposition: 'timed_out', sourcesExhausted: false
      } }]
    } as any;
    expect(adminReadinessLabel(metadata)).toBe('blocked_by_answer_contract');
    const flags = adminRuntimeFlags(metadata);
    expect(flags.some((flag) => flag.warn && flag.label.includes('partially_resolved'))).toBe(true);
    expect(flags.some((flag) => flag.warn && flag.label.includes('exhausted no'))).toBe(true);
    expect(flags.some((flag) => flag.label === 'warnings: 2')).toBe(true);
  });
});
