import type {
  ExecutionContract,
  LeadStateMachine
} from '../shared/types.js';

export function buildLeadStateMachine(input: {
  executionContract: ExecutionContract;
  hasContactInTurn: boolean;
  leadRequested: boolean;
  leadCreated: boolean;
  missing?: 'name' | 'contact';
  error?: string;
}): LeadStateMachine {
  const warnings: string[] = [];

  if (input.executionContract.leadPolicy === 'forbidden') {
    if (input.leadRequested || input.leadCreated) warnings.push('lead_requested_despite_forbidden_policy');
    return {
      version: 1,
      state: 'not_allowed',
      nextAction: 'do_not_ask_contact',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: input.hasContactInTurn,
      leadRequested: input.leadRequested,
      leadCreated: input.leadCreated,
      missing: input.missing,
      warnings
    };
  }

  if (input.leadCreated) {
    return {
      version: 1,
      state: 'created',
      nextAction: 'confirm_created_lead',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: input.hasContactInTurn,
      leadRequested: input.leadRequested,
      leadCreated: true,
      warnings
    };
  }

  if (input.error) {
    warnings.push('lead_creation_failed');
    return {
      version: 1,
      state: 'failed',
      nextAction: 'manual_follow_up_required',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: input.hasContactInTurn,
      leadRequested: input.leadRequested,
      leadCreated: false,
      missing: input.missing,
      warnings
    };
  }

  if (input.executionContract.leadPolicy === 'none') {
    return {
      version: 1,
      state: 'not_needed',
      nextAction: 'answer_without_lead',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: input.hasContactInTurn,
      leadRequested: input.leadRequested,
      leadCreated: false,
      missing: input.missing,
      warnings
    };
  }

  if (input.executionContract.leadPolicy === 'optional_after_answer') {
    return {
      version: 1,
      state: 'optional_after_answer',
      nextAction: 'offer_contact_after_answer',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: input.hasContactInTurn,
      leadRequested: input.leadRequested,
      leadCreated: false,
      missing: input.missing,
      warnings
    };
  }

  if (input.hasContactInTurn && !input.missing) {
    return {
      version: 1,
      state: 'ready_to_create',
      nextAction: 'create_or_confirm_lead',
      leadPolicy: input.executionContract.leadPolicy,
      hasContactInTurn: true,
      leadRequested: input.leadRequested,
      leadCreated: false,
      warnings
    };
  }

  return {
    version: 1,
    state: 'required_contact_missing',
    nextAction: 'ask_for_missing_contact',
    leadPolicy: input.executionContract.leadPolicy,
    hasContactInTurn: input.hasContactInTurn,
    leadRequested: input.leadRequested,
    leadCreated: false,
    missing: input.missing ?? 'contact',
    warnings
  };
}
