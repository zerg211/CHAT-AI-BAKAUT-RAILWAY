import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('agent manager integration source guards', () => {
  it('routes generate and recover through AgentManagerOrchestrator behind the harness flag', () => {
    const assistant = readFileSync('src/ai/assistant.ts', 'utf8').replace(/\r\n/g, '\n');

    expect(assistant).toContain('new AgentManagerOrchestrator(this.conversations, this.products, this.leads)');
    expect(assistant).toContain('if (isAgentManagerHarnessEnabledForSession(session)) {\n      return this.agentManager.generateAnswer(input);');
    expect(assistant).toContain('if (isAgentManagerHarnessEnabledForSession(session)) {\n      return this.agentManager.recoverTurn(input);');
  });

  it('uses web search inside the comparison research module', () => {
    const research = readFileSync('src/ai/productComparisonResearch.ts', 'utf8');

    expect(research).toContain("type: 'web_search_preview'");
    expect(research).toContain('conflicts');
    expect(research).toContain('summaryForAnswer');
  });

  it('orders catalog search by the selected retrieval score alias', () => {
    const repositories = readFileSync('src/db/repositories.ts', 'utf8');

    expect(repositories).toContain('AS retrieval_score');
    expect(repositories).toContain('ORDER BY retrieval_score DESC NULLS LAST, updated_at DESC');
    expect(repositories).not.toContain('ORDER BY rank DESC NULLS LAST, updated_at DESC');
  });

  it('starts the lead outbox worker through the feature flag controlled worker', () => {
    const app = readFileSync('src/app.ts', 'utf8');
    const worker = readFileSync('src/ai/leadOutbox.ts', 'utf8');

    expect(app).toContain('startLeadOutboxWorker({ log: app.log })');
    expect(worker).toContain('if (!config.AGENT_MANAGER_HARNESS_ENABLED && !config.AGENT_MANAGER_LEAD_OUTBOX_ENABLED) return undefined;');
  });

  it('exposes a production runtime marker through health for deploy verification', () => {
    const app = readFileSync('src/app.ts', 'utf8');

    expect(app).toContain('commitSha: process.env.RAILWAY_GIT_COMMIT_SHA');
    expect(app).toContain('branch: process.env.RAILWAY_GIT_BRANCH');
    expect(app).toContain('agentManagerUrlOptInParam: AGENT_MANAGER_URL_OPT_IN_PARAM');
  });

  it('tries same-turn recovery before returning a saved-turn error in the harness path', () => {
    const route = readFileSync('src/routes/chat.ts', 'utf8');

    expect(route).toContain('if (!controller.signal.aborted && agentManagerHarnessEnabled)');
    expect(route).toContain('assistant.recoverTurn({');
    expect(route).toContain('recoverable: isAgentManagerHarnessEnabledForSession(sessionForRecovery)');
  });

  it('renders agent manager traces in the admin conversation detail UI', () => {
    const client = readFileSync('src/client/main.tsx', 'utf8');
    const styles = readFileSync('src/client/styles.css', 'utf8');

    expect(client).toContain('agentTraces?: AdminAgentTrace[]');
    expect(client).toContain('function AgentTracePanel');
    expect(client).toContain('detail.agentTraces?.length ? <AgentTracePanel traces={detail.agentTraces} /> : null');
    expect(styles).toContain('.admin-trace-panel');
  });
});
