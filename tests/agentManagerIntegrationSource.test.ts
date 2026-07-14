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
    expect(research).toContain('missing-fact slot');
    expect(research).toContain('Do not reduce the task to a fixed phrase list');
    expect(research).toContain('source_evidence_semantic_validation');
    expect(research).toContain('A non-official listing, cached listing, marketplace page, or forum/classified page can be used as medium-confidence evidence');
    expect(research).not.toContain('source_visual_start_control_validation');
    expect(research).not.toContain('input_image');
    expect(research).not.toContain('OPENAI_VISION_MODEL');
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
    expect(orchestrator).toContain('When the buyer asks to check, verify, confirm facts, mentions missing catalog data, or asks for exact/current technical grounding');
    expect(orchestrator).toContain('plan web.researchProductFacts even without a named model');
    expect(orchestrator).toContain('For multi-turn generator selection, do not run catalog.search alone');
    expect(orchestrator).toContain('Re-run calculator.generatorLoad in the current turn before catalog.search');
    expect(orchestrator).toContain('every named catalog recommendation must be strong enough to be shown as a visible card');
    expect(orchestrator).toContain('Mention dimensions, widths, weights, prices, and specs only when they are present in the provided product context');
    expect(orchestrator).toContain('first cover all honestly suitable products');
    expect(orchestrator).toContain('rank the shortlist by fit to both constraints');
    expect(orchestrator).toContain('two or more clearly lighter in-budget candidates');
    expect(orchestrator).toContain('hasConfirmedStartControlCoverage');
    expect(orchestrator).toContain('description: compactProductDescription(product.description)');
    expect(orchestrator).toContain('Пиши как знакомый знакомому');
    expect(orchestrator).toContain("labels.push('Кнопочный запуск')");
    expect(orchestrator).toContain('startControlUncertaintyStatement');
    expect(orchestrator).toContain('Чем именно включается электростартер');
    expect(orchestrator).toContain('presentCatalogPresenceLine(presence.productName, directAnswer)');
    expect(orchestrator).toContain('У нас эта модель есть в каталоге.');
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
    expect(repositories).toContain("search_tsv @@ websearch_to_tsquery('russian', $1)");
    expect(repositories).toContain('ORDER BY rank DESC NULLS LAST, updated_at DESC');
  });

  it('starts the lead outbox worker as an active runtime component', () => {
    const app = readFileSync('src/app.ts', 'utf8');
    const worker = readFileSync('src/ai/leadOutbox.ts', 'utf8');

    expect(app).toContain('startLeadOutboxWorker({ log: app.log })');
    expect(worker).not.toContain('AGENT_MANAGER_LEAD_OUTBOX_ENABLED');
    expect(worker).toContain('processLeadOutboxBatch().catch');
  });

  it('exposes a production runtime marker through health for deploy verification', () => {
    const app = readFileSync('src/app.ts', 'utf8');
    const admin = readFileSync('src/routes/admin.ts', 'utf8');

    expect(app).toContain('commitSha: process.env.RAILWAY_GIT_COMMIT_SHA');
    expect(app).toContain('productionRuntime: AI_MANAGER_RUNTIME_MANIFEST.productionRuntime');
    expect(app).not.toContain('getAgentManagerRuntimeDecision');
    expect(app).not.toContain('getCatalogFreshness');
    expect(admin).toContain("app.get('/api/admin/health'");
    expect(admin).toContain('decision: getAgentManagerRuntimeDecision(null)');
    expect(admin).toContain('manifest: AI_MANAGER_RUNTIME_MANIFEST');
  });

  it('tries same-turn recovery before returning a saved-turn error in the harness path', () => {
    const route = readFileSync('src/routes/chat.ts', 'utf8');

    expect(route).toContain("import { closeSseReply, openSseReply, startStatusTimer } from './sse.js';");
    expect(route).toContain("const send = openSseReply(reply, { 'x-chat-turn-id': turnId });");
    expect(route).toContain("const send = openSseReply(reply, { 'x-chat-turn-id': params.turnId });");
    expect(route).toContain('stopStatusTimer = startStatusTimer({');
    expect(route).toContain('closeSseReply(reply);');
    expect(route).not.toContain('reply.raw.writeHead(200');
    expect(route).toContain('if (!controller.signal.aborted && agentManagerHarnessEnabled && recoveryAllowed)');
    expect(route).toContain('assistant.recoverTurn({');
    expect(route).toContain('recoverable: agentManagerHarnessEnabled && recoveryAllowed');
    expect(route).toContain('if (recoveryAllowed) {');
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

  it('uses one versioned manager policy and an explicit untrusted-evidence boundary in every model stage', () => {
    const orchestrator = readFileSync('src/ai/agentManagerOrchestrator.ts', 'utf8');
    const manifest = readFileSync('src/ai/aiManagerRuntimeManifest.ts', 'utf8');

    expect(orchestrator).toContain('SECURITY/TRUST BOUNDARY');
    expect(orchestrator).toContain('salesManagerPlannerPolicyPromptBlock()');
    expect(orchestrator).toContain("target: 'answer'");
    expect(orchestrator).toContain("target: 'reviewer'");
    expect(orchestrator).toContain('policyPackHash: SALES_MANAGER_POLICY_PACK_HASH');
    expect(manifest).toContain("productionRuntime: 'agent_manager'");
    expect(manifest).toContain("responseWriter: 'AgentManagerOrchestrator.executeClaimedTurn'");
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
