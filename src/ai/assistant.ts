import { ConversationRepository } from '../db/repositories.js';
import { PlatformAgentAssistant } from './platformAgentAssistant.js';
import type { AgentManagerGenerateInput, AgentManagerRecoverInput } from './agentManagerOrchestrator.js';

/**
 * Route-facing adapter for the saved OpenAI Platform agent.
 */
export class AssistantService {
  private readonly platformAgent: PlatformAgentAssistant;

  constructor(
    conversations = new ConversationRepository()
  ) {
    this.platformAgent = new PlatformAgentAssistant(conversations);
  }

  generateAnswer(input: AgentManagerGenerateInput) {
    return this.platformAgent.generateAnswer(input);
  }

  recoverTurn(input: AgentManagerRecoverInput) {
    return this.platformAgent.recoverTurn(input);
  }
}
