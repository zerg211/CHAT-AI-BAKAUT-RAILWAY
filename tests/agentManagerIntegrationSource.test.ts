import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('agent manager integration source guards', () => {
  it('routes generate and recover through AgentManagerOrchestrator behind the harness flag', () => {
    const assistant = readFileSync('src/ai/assistant.ts', 'utf8').replace(/\r\n/g, '\n');

    expect(assistant).toContain('new AgentManagerOrchestrator(this.conversations, this.products, this.leads)');
    expect(assistant).toContain('const runtimeDecision = getAgentManagerRuntimeDecision(session);');
    expect(assistant).toContain('if (runtimeDecision.agentManagerHarnessEnabled) {\n      return this.agentManager.generateAnswer(input);');
    expect(assistant).toContain('if (runtimeDecision.agentManagerHarnessEnabled) {\n      return this.agentManager.recoverTurn(input);');
  });

  it('uses web search inside the comparison research module', () => {
    const research = readFileSync('src/ai/productComparisonResearch.ts', 'utf8');

    expect(research).toContain("type: 'web_search_preview'");
    expect(research).toContain('conflicts');
    expect(research).toContain('summaryForAnswer');
    expect(research).toContain('exactTargetSearchQueries');
    expect(research).toContain('Same brand, same family, or nearby model pages are not proof about the target model.');
    expect(research).toContain('exact_target_external_fact_not_found');
    expect(research).toContain('Do not stop at a broad fact like "electric starter"');
    expect(research).toContain('answerGuidance.directAnswer');
    expect(research).toContain('switch turned/held in START');
    expect(research).toContain('catalog_product_fact_extraction');
    expect(research).toContain('description является обязательным источником каталожных фактов');
    expect(research).toContain('catalogExtraction');
    expect(research).toContain('catalog_fact_extraction_used');
    expect(research).toContain("search_context_size: targetProductNames.length ? 'high' : 'medium'");
    const orchestrator = readFileSync('src/ai/agentManagerOrchestrator.ts', 'utf8');
    expect(orchestrator).toContain('answerText must include all three parts in this order');
    expect(orchestrator).toContain('omits non-empty nearbyCatalogProducts');
    expect(orchestrator).toContain('requiredResponseClausesForToolResults');
    expect(orchestrator).toContain('answerText must satisfy every clause by meaning');
    expect(orchestrator).toContain('answer_checked_research_guidance');
    expect(orchestrator).toContain('hasConfirmedStartControlCoverage');
    expect(orchestrator).toContain('description: compactProductDescription(product.description)');
    expect(orchestrator).toContain('Пиши как знакомый знакомому');
    expect(orchestrator).toContain("labels.push('Кнопочный запуск')");
    expect(orchestrator).toContain("const suffix = status === 'ambiguous' ? 'точно подтвердить не могу' : 'в данных не вижу'");
    expect(orchestrator).toContain('У нас ${presence.productName} есть в каталоге.');
    expect(orchestrator).toContain('approvedAnswerStyleExamplesPromptBlock');
  });

  it('keeps a project-level human answer style rule in the main prompts', () => {
    const prompts = readFileSync('src/ai/prompts.ts', 'utf8');
    const research = readFileSync('src/ai/productComparisonResearch.ts', 'utf8');
    const styleExamples = readFileSync('src/ai/answerStyleExamples.ts', 'utf8');

    expect(prompts).toContain('Пиши как знакомый знакомому');
    expect(prompts).toContain('approvedAnswerStyleExamplesPromptBlock');
    expect(prompts).toContain('не используй внутренние формулировки');
    expect(research).toContain('approvedAnswerStyleExamplesPromptBlock');
    expect(research).toContain('как знакомый знакомому');
    expect(research).toContain('кнопочный запуск в данных не вижу');
    expect(styleExamples).toContain('Пул одобренных примеров стиля');
    expect(styleExamples).toContain('не являются шаблонами');
    expect(styleExamples).toContain('не являются источником фактов');
  });

  it('keeps blocked generator clarifications self-contained', () => {
    const orchestrator = readFileSync('src/ai/agentManagerOrchestrator.ts', 'utf8');

    expect(orchestrator).toContain('When productClass is generator and cards are blocked, answerText must remain self-contained');
    expect(orchestrator).toContain('explicitly mention the generator selection and the missing load/power/model fact');
    expect(orchestrator).toContain('does not explicitly mention generator selection plus the missing load/power/model fact');
    expect(orchestrator).toContain('A load with null kW is only a missing fact and will not be counted by the calculator');
  });

  it('orders catalog search by the selected retrieval score alias', () => {
    const repositories = readFileSync('src/db/repositories.ts', 'utf8');

    expect(repositories).toContain('AS retrieval_score');
    expect(repositories).toContain('token_match_count');
    expect(repositories).toContain('ORDER BY retrieval_score DESC NULLS LAST, token_match_count DESC, updated_at DESC');
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

    expect(route).toContain("import { closeSseReply, openSseReply, startStatusTimer } from './sse.js';");
    expect(route).toContain('const send = openSseReply(reply);');
    expect(route).toContain('stopStatusTimer = startStatusTimer({');
    expect(route).toContain('closeSseReply(reply);');
    expect(route).not.toContain('reply.raw.writeHead(200');
    expect(route).toContain('if (!controller.signal.aborted && agentManagerHarnessEnabled)');
    expect(route).toContain('assistant.recoverTurn({');
    expect(route).toContain('recoverable: agentManagerHarnessEnabled');
  });

  it('marks runtime mode and legacy paths in stream payloads, saved metadata, and admin UI', () => {
    const route = readFileSync('src/routes/chat.ts', 'utf8');
    const assistant = readFileSync('src/ai/assistant.ts', 'utf8');
    const runtime = readFileSync('src/ai/agentManagerRuntime.ts', 'utf8');
    const orchestrator = readFileSync('src/ai/agentManagerOrchestrator.ts', 'utf8');
    const client = readFileSync('src/client/main.tsx', 'utf8');

    expect(route).toContain('runtimeModeReason: runtimeDecision.reason');
    expect(route).toContain('agentManagerRuntime: runtimeDecision');
    expect(runtime).toContain("legacyRuntime: {");
    expect(runtime).toContain("path: legacyPath ?? 'legacy_unknown'");
    expect(assistant).toContain("runtimeResponseMetadata(runtimeDecision, 'legacy_full_pipeline')");
    expect(assistant).toContain("runtimeResponseMetadata(getAgentManagerRuntimeDecision(session), 'llm_fast_commercial_handoff')");
    expect(orchestrator).toContain('runtimeModeReason: runtimeDecision.reason');
    expect(client).toContain("label: `mode: ${runtimeMode} (${shortDiagnosticReason(runtimeReason)})`");
    expect(client).toContain("label: `legacy path: ${shortDiagnosticReason(metadata.legacyRuntime.path ?? 'unknown')}`");
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
