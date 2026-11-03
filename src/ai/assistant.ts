import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import { config } from '../config.js';
import { PlatformAgentAssistant } from './platformAgentAssistant.js';
import {
  AgentManagerOrchestrator,
  type AgentManagerGenerateInput,
  type AgentManagerRecoverInput
} from './agentManagerOrchestrator.js';

/**
 * Route-facing adapter for the sole AI-manager runtime.
 * Semantic planning, tools, answer generation, review and recovery all live in
 * AgentManagerOrchestrator; no alternative writer or secondary answer path exists.
 */
export class AssistantService {
  private readonly agentManager: AgentManagerOrchestrator;
  private readonly platformAgent: PlatformAgentAssistant;

  constructor(
    conversations = new ConversationRepository(),
    products = new ProductRepository(),
    leads = new LeadRepository()
  ) {
    this.agentManager = new AgentManagerOrchestrator(conversations, products, leads);
    this.platformAgent = new PlatformAgentAssistant(conversations);
  }

  generateAnswer(input: AgentManagerGenerateInput & { catalogPage?: boolean }) {
    return config.OPENAI_PLATFORM_AGENT_ID ? this.platformAgent.generateAnswer(input) : this.agentManager.generateAnswer(input);
  }

  recoverTurn(input: AgentManagerRecoverInput) {
    return config.OPENAI_PLATFORM_AGENT_ID ? this.platformAgent.recoverTurn(input) : this.agentManager.recoverTurn(input);
  }
}
