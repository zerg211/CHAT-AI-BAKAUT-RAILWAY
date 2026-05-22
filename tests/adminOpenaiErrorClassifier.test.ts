import { describe, expect, it } from 'vitest';
import { classifyOpenAIRuntimeError } from '../src/routes/admin.js';

describe('admin OpenAI runtime error classifier', () => {
  it('classifies quota and billing failures', () => {
    expect(classifyOpenAIRuntimeError(429, { code: 'insufficient_quota' })).toBe('quota_or_billing');
    expect(classifyOpenAIRuntimeError(null, { message: 'Billing credits exhausted' })).toBe('quota_or_billing');
  });

  it('classifies authentication failures', () => {
    expect(classifyOpenAIRuntimeError(401, { message: 'Unauthorized' })).toBe('authentication');
    expect(classifyOpenAIRuntimeError(null, { code: 'invalid_api_key' })).toBe('authentication');
  });

  it('classifies provider region failures before generic access failures', () => {
    expect(classifyOpenAIRuntimeError(403, { code: 'unsupported_country_region_territory' })).toBe('provider_access_region');
  });

  it('classifies rate limits', () => {
    expect(classifyOpenAIRuntimeError(429, { code: 'rate_limit_exceeded' })).toBe('rate_limit');
  });

  it('classifies model, project, organization, and permission failures', () => {
    expect(classifyOpenAIRuntimeError(403, { message: 'Forbidden' })).toBe('model_project_or_org_access');
    expect(classifyOpenAIRuntimeError(null, { code: 'model_not_found' })).toBe('model_project_or_org_access');
  });

  it('classifies network and timeout failures', () => {
    expect(classifyOpenAIRuntimeError(null, { message: 'fetch failed because connection timed out' })).toBe('network_or_timeout');
    expect(classifyOpenAIRuntimeError(null, { message: 'ECONNRESET' })).toBe('network_or_timeout');
  });

  it('keeps unknown failures unknown', () => {
    expect(classifyOpenAIRuntimeError(500, { message: 'unexpected provider response' })).toBe('unknown');
  });
});
