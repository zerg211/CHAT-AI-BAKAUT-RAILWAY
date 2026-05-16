import { describe, expect, it } from 'vitest';
import type { ExecutionContract } from '../src/shared/types.js';
import { buildLeadStateMachine } from '../src/ai/leadStateMachine.js';

const executionContract: ExecutionContract = {
  version: 1,
  source: 'agent_turn_contract',
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogPolicy: 'find_matching_products',
  cardsPolicy: 'primary',
  leadPolicy: 'none',
  factPolicy: 'catalog_only',
  activeRequirementIds: [],
  postconditions: [],
  warnings: []
};

describe('lead state machine', () => {
  it('blocks contact pressure when lead policy is forbidden', () => {
    const state = buildLeadStateMachine({
      executionContract: { ...executionContract, leadPolicy: 'forbidden' },
      hasContactInTurn: false,
      leadRequested: true,
      leadCreated: false
    });

    expect(state.state).toBe('not_allowed');
    expect(state.nextAction).toBe('do_not_ask_contact');
    expect(state.warnings).toContain('lead_requested_despite_forbidden_policy');
  });

  it('requires missing contact when specialist handoff is required but no contact exists', () => {
    const state = buildLeadStateMachine({
      executionContract: { ...executionContract, leadPolicy: 'required_now' },
      hasContactInTurn: false,
      leadRequested: true,
      leadCreated: false
    });

    expect(state.state).toBe('required_contact_missing');
    expect(state.nextAction).toBe('ask_for_missing_contact');
    expect(state.missing).toBe('contact');
  });

  it('confirms a created lead as terminal successful state', () => {
    const state = buildLeadStateMachine({
      executionContract: { ...executionContract, leadPolicy: 'required_now' },
      hasContactInTurn: true,
      leadRequested: true,
      leadCreated: true
    });

    expect(state.state).toBe('created');
    expect(state.nextAction).toBe('confirm_created_lead');
    expect(state.leadCreated).toBe(true);
  });
});
