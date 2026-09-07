import { describe, it, expect } from 'vitest';
import { webResearchTargetsCurrentIntent } from '../src/ai/agentManagerOrchestrator.js';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';

describe('typed research target authorization', () => {
  const name='Wacker Neuson BPS 1550 Gw-c CE';
  function intent(role:string,taskType='technical_answer') {
    return {grounding:{taskType},productMentions:[{name,role}],toolRequests:[]} as unknown as AgentIntentContract;
  }
  it.each(['target_product','catalog_candidate','comparison_subject'])('accepts the LLM-authorized %s during a technical answer',role=>{
    expect(webResearchTargetsCurrentIntent([name],intent(role))).toBe(true);
  });
  it('checks every target; one authorized model cannot authorize a different variant',()=>{
    expect(webResearchTargetsCurrentIntent([name,'Wacker Neuson BPS 1550 Aw'],intent('target_product'))).toBe(false);
  });
  it.each(['context_load_device','compatibility_context','mentioned_only'])('does not promote %s to a research target',role=>{
    expect(webResearchTargetsCurrentIntent([name],intent(role))).toBe(false);
  });
});
