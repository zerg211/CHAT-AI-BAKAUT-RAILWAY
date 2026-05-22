function parseOutput(output) {
  if (typeof output === 'object' && output !== null) return output;
  try {
    return JSON.parse(String(output || '{}'));
  } catch (error) {
    return {
      caseId: 'unparseable-output',
      turns: [],
      final: null,
      parseError: error instanceof Error ? error.message : String(error),
      rawOutput: String(output || '').slice(0, 2000)
    };
  }
}

function assertionConfig(context) {
  return context?.config || context?.assert?.config || {};
}

function result(pass, reason, score = pass ? 1 : 0) {
  return { pass, score, reason };
}

function allTurns(parsed) {
  return Array.isArray(parsed.turns) ? parsed.turns : [];
}

function latestTurn(parsed) {
  const turns = allTurns(parsed);
  return parsed.final || turns[turns.length - 1] || null;
}

function compilePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      if (pattern instanceof RegExp) return pattern;
      try {
        return new RegExp(expandPatternSource(String(pattern)), 'iu');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function expandPatternSource(source) {
  if (/виброплит/iu.test(source)) {
    const plateNoun = '(?:^|[^А-Яа-яЁё])плит(?:а|у|ы|е|ой|ою|ам|ами|ах)(?=$|[^А-Яа-яЁё])';
    return `(?:${source})|${plateNoun}`;
  }
  return source;
}

function textMatchesAny(text, patterns) {
  return compilePatterns(patterns).some((pattern) => pattern.test(text));
}

function textMatchesAll(text, patterns) {
  const compiled = compilePatterns(patterns);
  return compiled.length === 0 || compiled.every((pattern) => pattern.test(text));
}

function collectMetadata(parsed) {
  return allTurns(parsed)
    .map((turn) => turn.metadata)
    .filter((metadata) => metadata && typeof metadata === 'object');
}

function addToolWithAliases(tools, tool) {
  if (!tool) return;
  tools.add(tool);
  if (tool === 'catalog.search') {
    tools.add('searchCatalog');
    tools.add('selectProducts');
  }
  if (tool === 'catalog.getProductDetails') tools.add('getProductDetails');
  if (tool === 'web.researchProductFacts') tools.add('webFactSearch');
  if (tool === 'lead.capture') tools.add('createLead');
  if (tool === 'calculator.generatorLoad') tools.add('calculateGeneratorLoad');
}

function collectToolNames(parsed) {
  const tools = new Set();
  for (const metadata of collectMetadata(parsed)) {
    for (const step of Array.isArray(metadata.toolTrace) ? metadata.toolTrace : []) {
      addToolWithAliases(tools, step?.tool);
    }
    for (const step of Array.isArray(metadata.toolResults) ? metadata.toolResults : []) {
      addToolWithAliases(tools, step?.tool);
    }
    for (const request of Array.isArray(metadata.intentContract?.toolRequests) ? metadata.intentContract.toolRequests : []) {
      addToolWithAliases(tools, request?.tool);
    }
  }
  return tools;
}

function collectRequiredSources(parsed) {
  const sources = new Set(collectMetadata(parsed).flatMap((metadata) => {
    const required = metadata.sourcePolicy?.required || metadata.agentContractV2?.sourcePolicy?.required || [];
    return Array.isArray(required) ? required : [];
  }));
  for (const metadata of collectMetadata(parsed)) {
    const leadAction = metadata.answerContract?.leadAction;
    const toolNames = new Set();
    for (const step of Array.isArray(metadata.toolResults) ? metadata.toolResults : []) addToolWithAliases(toolNames, step?.tool);
    for (const request of Array.isArray(metadata.intentContract?.toolRequests) ? metadata.intentContract.toolRequests : []) addToolWithAliases(toolNames, request?.tool);
    if (
      toolNames.has('createLead') ||
      ['offer_form', 'request_contact', 'collect_contact', 'create_lead'].includes(String(leadAction || ''))
    ) {
      sources.add('specialist');
    }
    if (toolNames.has('webFactSearch')) sources.add('web');
  }
  return sources;
}

function collectTaskTypes(parsed) {
  const taskTypes = new Set();
  for (const metadata of collectMetadata(parsed)) {
    for (const value of [
      metadata.executionContract?.taskType,
      metadata.agentContractV2?.taskType,
      metadata.turnContract?.taskType
    ]) {
      if (value) taskTypes.add(value);
    }
    const tools = new Set();
    for (const step of Array.isArray(metadata.toolResults) ? metadata.toolResults : []) addToolWithAliases(tools, step?.tool);
    for (const request of Array.isArray(metadata.intentContract?.toolRequests) ? metadata.intentContract.toolRequests : []) addToolWithAliases(tools, request?.tool);
    if (tools.has('searchCatalog') || tools.has('selectProducts') || metadata.cardSelection?.products?.length || metadata.productCards?.length) {
      taskTypes.add('product_selection');
    }
    if (tools.has('webFactSearch')) taskTypes.add('technical_answer');
    if (tools.has('createLead') || ['offer_form', 'request_contact', 'collect_contact', 'create_lead'].includes(String(metadata.answerContract?.leadAction || ''))) {
      taskTypes.add('delivery_or_discount');
      taskTypes.add('pure_delivery');
      taskTypes.add('product_selection_with_delivery');
    }
  }
  return taskTypes;
}

function collectLeadPolicies(parsed) {
  const policies = new Set();
  for (const metadata of collectMetadata(parsed)) {
    const explicit = metadata.executionContract?.leadPolicy || metadata.agentContractV2?.leadPolicy;
    if (explicit) policies.add(explicit);
    const leadAction = String(metadata.answerContract?.leadAction || '');
    if (leadAction === 'offer_form') policies.add('optional_after_answer');
    if (['request_contact', 'collect_contact', 'create_lead'].includes(leadAction)) policies.add('required_now');
    const tools = new Set();
    for (const step of Array.isArray(metadata.toolResults) ? metadata.toolResults : []) addToolWithAliases(tools, step?.tool);
    for (const request of Array.isArray(metadata.intentContract?.toolRequests) ? metadata.intentContract.toolRequests : []) addToolWithAliases(tools, request?.tool);
    if (tools.has('createLead')) policies.add('required_now');
  }
  return policies;
}

function collectFactPolicies(parsed) {
  const policies = new Set();
  for (const metadata of collectMetadata(parsed)) {
    const explicit = metadata.executionContract?.factPolicy;
    if (explicit) policies.add(explicit);
  }
  if (collectToolNames(parsed).has('webFactSearch')) policies.add('web_required');
  return policies;
}

function collectIntents(parsed) {
  const intents = new Set();
  for (const metadata of collectMetadata(parsed)) {
    const explicit = metadata.agentContractV2?.intent;
    if (explicit) intents.add(explicit);
    const tools = new Set();
    for (const step of Array.isArray(metadata.toolResults) ? metadata.toolResults : []) addToolWithAliases(tools, step?.tool);
    for (const request of Array.isArray(metadata.intentContract?.toolRequests) ? metadata.intentContract.toolRequests : []) addToolWithAliases(tools, request?.tool);
    if (tools.has('searchCatalog') || tools.has('selectProducts') || metadata.cardSelection?.products?.length || metadata.productCards?.length) {
      intents.add('product_selection');
    }
  }
  return intents;
}

function collectProductClasses(parsed) {
  const classes = new Set();
  for (const metadata of collectMetadata(parsed)) {
    for (const value of [
      metadata.selectionReadiness?.productClass,
      metadata.cardSelection?.intent,
      metadata.answerContract?.selectionReadiness?.productClass
    ]) {
      if (typeof value === 'string' && value.trim()) classes.add(value.trim());
    }
  }
  return classes;
}

function hasExpectedProductClass(parsed, expectedProductClasses) {
  if (!Array.isArray(expectedProductClasses) || expectedProductClasses.length === 0) return true;
  const classes = collectProductClasses(parsed);
  return expectedProductClasses.some((productClass) => classes.has(productClass));
}

function productCardTitle(card) {
  if (!card || typeof card !== 'object') return '';
  return [
    card.title,
    card.name,
    card.productName,
    card.category,
    card.model,
    card.sku
  ].filter(Boolean).join(' ');
}

function latestVisibleEvidenceText(parsed) {
  const turn = latestTurn(parsed);
  const cardText = Array.isArray(turn?.productCards)
    ? turn.productCards.map(productCardTitle).filter(Boolean).join('\n')
    : '';
  return [String(turn?.answer || ''), cardText].filter(Boolean).join('\n');
}

function fallbackUsed(metadata) {
  const diagnostics = metadata?.aiDiagnostics || {};
  const validatorWarnings = [
    ...(Array.isArray(metadata?.validatorWarnings) ? metadata.validatorWarnings : []),
    ...(Array.isArray(metadata?.turnContract?.validatorWarnings) ? metadata.turnContract.validatorWarnings : [])
  ];
  return Boolean(
    diagnostics.needExtractionFallback?.used ||
    diagnostics.turnPlanningFallback?.used ||
    diagnostics.answerGenerationFallback?.used ||
    metadata?.answerGenerationFallback?.used ||
    validatorWarnings.some((warning) => String(warning).includes('legacy_text_fallback'))
  );
}

const criticalAnswerPatterns = [
  /AI FALLBACK|network error|server finished without a done payload/iu,
  /не смог.{0,80}сформировать ответ/iu,
  /ответ не успел|не успел сформироваться/iu,
  /повторите.{0,40}через пару минут/iu,
  /\bundefined\b|\bnull\b/iu
];

const deliveryTopicFragments = ['достав'];
const discountTopicFragments = ['скид'];
const stockTopicFragments = ['налич'];
const commercialTopicFragments = [
  ...deliveryTopicFragments,
  ...discountTopicFragments,
  ...stockTopicFragments,
  'самовывоз',
  'услов'
];
const specialistHandoffFragments = ['логист', 'менеджер', 'специалист', 'уточн', 'контакт', 'телефон', 'номер', 'форма'];

const safeCommercialNonConfirmationFragments = [
  'точно не подтверж',
  'не подтверждаю',
  'не подтвержу',
  'не подтверждаем',
  'не подтвержден',
  'не подтверждено',
  'не могу подтверд',
  'не можем подтверд',
  'не могу сказать',
  'не можем сказать',
  'не обещаю',
  'не обещаем',
  'не гарантирую',
  'не гарантируем',
  'нельзя подтверд',
  'нельзя обещ',
  'нет точных условий',
  'нет точных данных',
  'нет данных',
  'в данных этого нет',
  'нужно уточнить',
  'надо уточнить',
  'требует уточнения',
  'лучше оставить контакт',
  'оставить контакт',
  'форма с контактом',
  'менеджер проверит',
  'логистика проверит',
  'проверим условия',
  'проверить условия'
];

const stockPromiseFragments = ['точно', 'гарантир', 'подтверждено', 'подтверждаем'];
const deliveryPromiseFragments = ['точно', 'гарантир', 'завтра', 'сегодня', 'будет сегодня', 'будет завтра'];
const discountPromiseFragments = ['точно', 'гарантир', 'будет', 'сделаем', 'дадим', 'предоставим', '%'];

function isWhitespaceChar(char) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v' || char === '\u00a0';
}

function normalizeText(text) {
  const source = String(text || '').toLocaleLowerCase('ru-RU').split('ё').join('е');
  let resultText = '';
  let previousWasSpace = false;
  for (const char of source) {
    if (isWhitespaceChar(char)) {
      if (!previousWasSpace) resultText += ' ';
      previousWasSpace = true;
      continue;
    }
    resultText += char;
    previousWasSpace = false;
  }
  return resultText.trim();
}

function splitSentences(text) {
  const sentences = [];
  let sentence = '';
  const pushSentence = () => {
    const trimmed = sentence.trim();
    if (trimmed) sentences.push(trimmed);
    sentence = '';
  };
  for (const char of String(text || '')) {
    if (char === '.' || char === '!' || char === '?' || char === '…' || char === '\r' || char === '\n') {
      pushSentence();
      continue;
    }
    sentence += char;
  }
  pushSentence();
  return sentences;
}

function hasNegatedCommercialConfirmation(text) {
  return textContainsAny(text, safeCommercialNonConfirmationFragments);
}

function textContainsAny(text, fragments) {
  const normalized = normalizeText(text);
  return fragments.some((fragment) => normalized.includes(normalizeText(fragment)));
}

function hasSafeCommercialNonConfirmation(text) {
  return textContainsAny(text, commercialTopicFragments) && hasNegatedCommercialConfirmation(text);
}

function hasDigit(text) {
  for (const char of String(text || '')) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) return true;
  }
  return false;
}

function hasTopicPromise(text, topicFragments, promiseFragments) {
  return textContainsAny(text, topicFragments) && textContainsAny(text, promiseFragments);
}

function hasDeliveryPriceOrTimingPromise(text) {
  if (!textContainsAny(text, deliveryTopicFragments)) return false;
  if (!hasDigit(text)) return false;
  return textContainsAny(text, ['за ', 'руб', 'час', 'дн', 'стоимость', 'итогов']);
}

function findOverconfidentCommercialPatternInSegment(segment) {
  if (hasSafeCommercialNonConfirmation(segment)) return null;
  if (hasTopicPromise(segment, stockTopicFragments, stockPromiseFragments)) return 'stock_overpromise';
  if (hasTopicPromise(segment, deliveryTopicFragments, deliveryPromiseFragments)) return 'delivery_overpromise';
  if (hasDeliveryPriceOrTimingPromise(segment)) return 'delivery_cost_or_timing_overpromise';
  if (hasTopicPromise(segment, discountTopicFragments, discountPromiseFragments)) return 'discount_overpromise';
  if (textContainsAny(segment, ['итогов', 'стоимость']) && textContainsAny(segment, deliveryTopicFragments) && hasDigit(segment)) {
    return 'delivery_final_cost_overpromise';
  }
  return null;
}

function findOverconfidentCommercialPattern(answer) {
  const sentences = splitSentences(answer);
  const segments = sentences.length ? sentences : [String(answer || '')];
  for (const segment of segments) {
    const finding = findOverconfidentCommercialPatternInSegment(segment);
    if (finding) return finding;
  }
  return null;
}

function assertNoRuntimeFailure(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const turns = allTurns(parsed);
  const minTurns = Number(config.minTurns || 1);

  if (parsed.parseError) return result(false, `Provider output is not valid JSON: ${parsed.parseError}`);

  for (const [index, turn] of turns.entries()) {
    if (!turn.ok) return result(false, `Turn ${index + 1} failed: ${turn.error || 'missing done payload'}`);
    if (!String(turn.answer || '').trim()) return result(false, `Turn ${index + 1} returned an empty answer.`);
    const critical = criticalAnswerPatterns.find((pattern) => pattern.test(String(turn.answer || '')));
    if (critical) return result(false, `Turn ${index + 1} contains critical runtime text (${critical}).`);
    if (turn.metadata && fallbackUsed(turn.metadata) && config.allowFallback !== true) {
      return result(false, `Turn ${index + 1} used AI fallback diagnostics.`);
    }
  }

  if (turns.length < minTurns) return result(false, `Expected at least ${minTurns} turn(s), got ${turns.length}.`);

  return result(true, 'All turns completed without runtime/fallback failure text.');
}

function assertSupportAnswerQuality(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const turns = allTurns(parsed);
  const minAnswerChars = Number(config.minAnswerChars || 80);

  for (const [index, turn] of turns.entries()) {
    const answer = String(turn.answer || '').trim();
    if (answer.length < minAnswerChars) {
      return result(false, `Turn ${index + 1} answer is too short: ${answer.length} chars.`);
    }
  }

  const finalAnswer = String(latestTurn(parsed)?.answer || '');
  const positiveEvidence = latestVisibleEvidenceText(parsed);
  if (!hasExpectedProductClass(parsed, config.expectedProductClasses)) {
    return result(false, `Expected product class ${JSON.stringify(config.expectedProductClasses)}. Saw: ${JSON.stringify([...collectProductClasses(parsed)])}`);
  }
  if (!textMatchesAll(positiveEvidence, config.finalMustContainAll)) {
    return result(false, `Final answer does not match all required patterns: ${JSON.stringify(config.finalMustContainAll || [])}`);
  }
  if (Array.isArray(config.finalMustContainAny) && config.finalMustContainAny.length && !textMatchesAny(positiveEvidence, config.finalMustContainAny)) {
    return result(false, `Final answer does not match any required pattern: ${JSON.stringify(config.finalMustContainAny)}`);
  }
  if (Array.isArray(config.finalMustNotContainTextAny) && textContainsAny(finalAnswer, config.finalMustNotContainTextAny)) {
    return result(false, `Final answer contains a forbidden text fragment: ${JSON.stringify(config.finalMustNotContainTextAny)}`);
  }
  if (Array.isArray(config.finalMustNotContain) && textMatchesAny(finalAnswer, config.finalMustNotContain)) {
    return result(false, `Final answer contains a forbidden scenario-specific pattern: ${JSON.stringify(config.finalMustNotContain)}`);
  }

  return result(true, 'Answer text meets scenario quality constraints.');
}

function assertBusinessRules(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const answers = allTurns(parsed).map((turn) => String(turn.answer || ''));

  for (const [index, answer] of answers.entries()) {
    const forbidden = findOverconfidentCommercialPattern(answer);
    if (forbidden) return result(false, `Turn ${index + 1} overpromises commercial facts (${forbidden}).`);
  }

  if (config.requireSpecialistHandoff) {
    const combined = answers.join('\n');
    if (!textContainsAny(combined, specialistHandoffFragments)) {
      return result(false, 'Commercial scenario did not route delivery/discount/stock terms to a specialist/contact handoff.');
    }
  }

  return result(true, 'Business-rule assertions passed.');
}

function assertRetrievalGrounding(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const turns = allTurns(parsed);
  const allCards = turns.flatMap((turn) => Array.isArray(turn.productCards) ? turn.productCards : []);
  const minCards = Number(config.minCards || 1);

  if (config.expectCards && allCards.length < minCards) {
    return result(false, `Expected at least ${minCards} product card(s), got ${allCards.length}.`);
  }
  if (config.expectNoCards && allCards.length > 0) {
    return result(false, `Expected no product cards, got ${allCards.length}.`);
  }

  for (const [index, turn] of turns.entries()) {
    const metadata = turn.metadata || {};
    if (
      turn.productCards?.length &&
      !metadata.cardManifest &&
      !metadata.productEvidenceRegistry &&
      !metadata.cardSelection &&
      !metadata.productCards
    ) {
      return result(false, `Turn ${index + 1} returned product cards without cardManifest/productEvidenceRegistry metadata.`);
    }
    if (metadata.postAnswerVerification?.status === 'error') {
      return result(false, `Turn ${index + 1} postAnswerVerification is error: ${JSON.stringify(metadata.postAnswerVerification.issues || [])}`);
    }
    const warnings = [
      ...(metadata.productEvidenceRegistry?.warnings || []),
      ...(metadata.cardManifest?.warnings || []),
      ...(metadata.factClaimAudit?.warnings || []),
      ...(metadata.cardSelection?.warnings || []),
      ...(metadata.warnings || [])
    ].map(String);
    const groundingWarning = warnings.find((warning) => /ungrounded|disallowed_product|visible_card_constraint_violation/iu.test(warning));
    if (groundingWarning) return result(false, `Turn ${index + 1} grounding warning: ${groundingWarning}`);
  }

  if (config.expectWebRequired) {
    const requiredSources = collectRequiredSources(parsed);
    const toolNames = collectToolNames(parsed);
    const usedWeb = turns.some((turn) => turn.usedWebSearch);
    if (!requiredSources.has('web') && !toolNames.has('webFactSearch') && !usedWeb) {
      return result(false, 'Expected web-required grounding but no sourcePolicy/webFactSearch/usedWebSearch evidence was present.');
    }
  }

  return result(true, 'Retrieval and grounding assertions passed.');
}

function assertToolCallCorrectness(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const toolNames = collectToolNames(parsed);
  const requiredSources = collectRequiredSources(parsed);

  for (const tool of (config.requiredToolsAll || [])) {
    if (!toolNames.has(tool)) return result(false, `Expected toolTrace to include ${tool}. Saw: ${JSON.stringify([...toolNames])}`);
  }
  if (Array.isArray(config.requiredToolsAny) && config.requiredToolsAny.length) {
    if (!config.requiredToolsAny.some((tool) => toolNames.has(tool))) {
      return result(false, `Expected one of tools ${JSON.stringify(config.requiredToolsAny)}. Saw: ${JSON.stringify([...toolNames])}`);
    }
  }
  for (const source of (config.requiredSourcesAll || [])) {
    if (!requiredSources.has(source)) return result(false, `Expected sourcePolicy.required to include ${source}. Saw: ${JSON.stringify([...requiredSources])}`);
  }
  if (Array.isArray(config.expectedLeadPolicies) && config.expectedLeadPolicies.length) {
    const policies = collectLeadPolicies(parsed);
    if (!config.expectedLeadPolicies.some((policy) => policies.has(policy))) {
      return result(false, `Expected one of lead policies ${JSON.stringify(config.expectedLeadPolicies)}. Saw: ${JSON.stringify([...policies])}`);
    }
  }
  if (Array.isArray(config.expectedFactPolicies) && config.expectedFactPolicies.length) {
    const policies = collectFactPolicies(parsed);
    if (!config.expectedFactPolicies.some((policy) => policies.has(policy))) {
      return result(false, `Expected one of fact policies ${JSON.stringify(config.expectedFactPolicies)}. Saw: ${JSON.stringify([...policies])}`);
    }
  }
  if (Array.isArray(config.expectedTaskTypes) && config.expectedTaskTypes.length) {
    const taskTypes = collectTaskTypes(parsed);
    if (!config.expectedTaskTypes.some((taskType) => taskTypes.has(taskType))) {
      return result(false, `Expected task type ${JSON.stringify(config.expectedTaskTypes)}. Saw: ${JSON.stringify([...taskTypes])}`);
    }
  }

  return result(true, 'Tool/source/contract assertions passed.');
}

function assertAgentTaskCompletion(output, context) {
  const parsed = parseOutput(output);
  const config = assertionConfig(context);
  const positiveEvidence = latestVisibleEvidenceText(parsed);

  if (config.expectLeadRequested === true && !allTurns(parsed).some((turn) => turn.leadRequested || turn.metadata?.leadStateMachine?.nextAction === 'ask_for_missing_contact')) {
    return result(false, 'Expected lead request or missing-contact action, but neither appeared.');
  }
  if (Array.isArray(config.expectedTaskTypes) && config.expectedTaskTypes.length) {
    const taskTypes = collectTaskTypes(parsed);
    if (!config.expectedTaskTypes.some((taskType) => taskTypes.has(taskType))) {
      return result(false, `Expected task type ${JSON.stringify(config.expectedTaskTypes)}. Saw: ${JSON.stringify([...taskTypes])}`);
    }
  }
  if (Array.isArray(config.expectedIntents) && config.expectedIntents.length) {
    const intents = collectIntents(parsed);
    if (!config.expectedIntents.some((intent) => intents.has(intent))) {
      return result(false, `Expected intent ${JSON.stringify(config.expectedIntents)}. Saw: ${JSON.stringify([...intents])}`);
    }
  }
  if (!hasExpectedProductClass(parsed, config.expectedProductClasses)) {
    return result(false, `Expected product class ${JSON.stringify(config.expectedProductClasses)}. Saw: ${JSON.stringify([...collectProductClasses(parsed)])}`);
  }
  if (!textMatchesAll(positiveEvidence, config.taskMustContainAll)) {
    return result(false, `Final task answer did not satisfy all completion patterns: ${JSON.stringify(config.taskMustContainAll || [])}`);
  }

  return result(true, 'Agent task completion assertions passed.');
}

module.exports = {
  assertNoRuntimeFailure,
  assertSupportAnswerQuality,
  assertBusinessRules,
  assertRetrievalGrounding,
  assertToolCallCorrectness,
  assertAgentTaskCompletion
};
