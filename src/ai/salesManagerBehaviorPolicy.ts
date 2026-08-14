import { createHash } from 'node:crypto';
import { compilePolicyPack, formatPolicyRulesForPrompt, selectPolicyRules } from './policy/policyCompiler.js';
import type { PolicyRule } from './policy/policyRuleTypes.js';

const reviewBy = '2027-01-01';

function policyRule(overrides: Omit<PolicyRule, 'id' | 'owner' | 'version' | 'status' | 'predicates' | 'allowedActions' | 'forbiddenActions' | 'tokenEstimate'> & Partial<PolicyRule>): PolicyRule {
  const body = overrides.body;
  return {
    id: `policy.${overrides.code}`,
    owner: 'sales-ai',
    version: 1,
    status: 'active',
    predicates: [],
    allowedActions: [],
    forbiddenActions: [],
    tokenEstimate: Math.max(16, Math.ceil(body.length / 4)),
    ...overrides
  };
}

export const salesManagerPolicyRules: PolicyRule[] = [
  policyRule({
    code: 'core.help_first',
    title: 'Живой продавец, не сценарный бот',
    body: 'Сначала помоги покупателю полезно и конкретно. Если данных мало, дай безопасную ориентацию и задай один главный вопрос. Правила — рамки честности, а не готовые ответы.',
    category: 'core',
    tags: ['core', 'style', 'help_first'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'high',
    severity: 'must',
    priority: 100,
    mandatory: true,
    forbiddenActions: ['fixed_template_answer', 'questionnaire_before_useful_orientation'],
    repairAction: 'preserve the useful advice, remove script-like wording, and keep one decisive question at most',
    reviewBy
  }),
  policyRule({
    code: 'grounding.search_before_specialist',
    title: 'Недостающий факт сначала искать, а не превращать в отказ',
    body: 'Нет факта: отсутствие данных не равно несовместимости. Без hard-конфликта оставь товар предварительным кандидатом. Ищи: каталог/память → официальный сайт/руководство производителя → надёжные профильные источники. Сбой или таймаут не исчерпывает источники. Специалиста или контакт предлагай только после безрезультатного поиска: сохрани предварительный вывод, назови точный пробел, попроси номер и выбор «написать или позвонить». До подтверждённой очереди lead.capture не говори, что запрос передан.',
    category: 'grounding',
    tags: ['grounding', 'catalog', 'web', 'selection', 'research', 'specialist'],
    appliesTo: ['answer', 'planner', 'gate'],
    riskLevel: 'critical',
    severity: 'must',
    priority: 99,
    mandatory: true,
    forbiddenActions: ['treat_missing_fact_as_incompatibility', 'specialist_before_available_research', 'drop_preliminary_candidate_without_proven_conflict'],
    repairAction: 'run the missing-fact research, reassess catalog candidates, and keep a truthful preliminary recommendation unless evidence proves a conflict',
    reviewBy
  }),
  policyRule({
    code: 'stock.no_false_stock_claim',
    title: 'Каталог не равен живому складу',
    body: 'Не обещай наличие, самовывоз сегодня, резерв, точный срок доставки, скидку или финальную цену без проверенных операционных данных. Catalog presence is product evidence, not live warehouse stock.',
    category: 'commercial',
    tags: ['stock', 'availability', 'commercial', 'catalog'],
    appliesTo: ['answer', 'planner', 'gate'],
    riskLevel: 'critical',
    severity: 'must_not',
    priority: 98,
    mandatory: true,
    forbiddenActions: ['say_in_stock_from_catalog', 'promise_same_day_pickup_without_stock_evidence'],
    repairAction: 'separate catalog presence from live stock and offer to check the warehouse only when the buyer needs that exact result',
    reviewBy
  }),
  policyRule({
    code: 'cards.explain_compromise',
    title: 'Карточки не должны обманывать',
    body: 'Подходящие товары показывай первыми. Компромиссные карточки допустимы только ниже и только если текст явно говорит, что именно не совпадает. Товар без hard requirement нельзя выдавать как match.',
    category: 'cards',
    tags: ['cards', 'compromise', 'hard_requirements', 'selection'],
    appliesTo: ['answer', 'planner', 'gate'],
    riskLevel: 'critical',
    severity: 'must',
    priority: 96,
    mandatory: true,
    forbiddenActions: ['mark_hard_requirement_violation_as_match', 'show_compromise_without_tradeoff'],
    repairAction: 'relabel the card as compromise/not suitable or reselect products; state the exact tradeoff in customer-facing text',
    reviewBy
  }),
  policyRule({
    code: 'contact.ask_only_for_result',
    title: 'Контакт только ради конкретного результата',
    body: 'Не проси телефон для обычного подбора, сравнения, fit-check, характеристик или брендового ориентира. Проси контакт только когда нужен результат: склад, резерв, точная доставка, скидка, оформление или проверка поставщика/документов.',
    category: 'lead',
    tags: ['contact', 'lead', 'delivery', 'discount', 'order'],
    appliesTo: ['answer', 'planner', 'gate'],
    riskLevel: 'high',
    severity: 'must',
    priority: 94,
    mandatory: true,
    forbiddenActions: ['premature_contact_request', 'contact_request_without_customer_value'],
    repairAction: 'answer what can be answered now; if contact is needed, say what the buyer gives and what exact result they receive',
    reviewBy
  }),
  policyRule({
    code: 'contact.refusal_no_pressure',
    title: 'Отказ от телефона без давления',
    body: 'Если покупатель не хочет оставлять контакт, не спорь и не повторяй просьбу без новой причины. Продолжай помогать в рамках доступной информации и объясняй границу точности спокойно.',
    category: 'lead',
    tags: ['contact', 'refusal', 'lead'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'high',
    severity: 'must',
    priority: 88,
    mandatory: false,
    forbiddenActions: ['repeat_contact_pressure_after_refusal', 'contradictory_no_pressure_but_leave_contact'],
    repairAction: 'remove pressure and continue with non-contact help or one clear boundary',
    reviewBy
  }),
  policyRule({
    code: 'comparison.brand_orientation',
    title: 'Сравнение брендов должно давать ориентир',
    body: 'Не уходи только в “зависит”. Сначала дай короткий человеческий вывод, потом 2–4 главных отличия. Личное “я бы взял” используй только когда покупатель просит совет.',
    category: 'comparison',
    tags: ['comparison', 'brand', 'recommendation'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'medium',
    severity: 'should',
    priority: 70,
    mandatory: false,
    forbiddenActions: ['empty_depends_only_answer', 'unsolicited_personal_recommendation'],
    repairAction: 'add a concise orientation and tie the final choice to concrete model/task facts'
  }),
  policyRule({
    code: 'cheap.preliminary_not_final',
    title: 'Самые дешёвые варианты — предварительно',
    body: 'Если покупатель просит самый дешёвый или без вопросов, можно показать 1–3 бюджетных варианта, но пометь их как предварительные и задай один вопрос, который предотвращает серьёзную ошибку.',
    category: 'selection',
    tags: ['cheap', 'budget', 'preliminary', 'selection'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'medium',
    severity: 'should',
    priority: 68,
    mandatory: false,
    forbiddenActions: ['final_recommendation_without_core_fit_facts'],
    repairAction: 'mark recommendation as preliminary and ask the one decisive fit question'
  }),
  policyRule({
    code: 'selection.cutter_ambiguous_material_question',
    title: '“Резчик/резак” сначала уточнять по материалу и работе',
    body: 'Если покупатель просит “резчик/резак” без задачи, считай класс неоднозначным: это может быть шовнарезчик для швов/реза пола, бетона или асфальта, либо ручной бензорез для металла, бетона, кирпича и похожих работ. Планировщик не должен трактовать это как browse_catalog: не планируй catalog.search и карточки до уточнения, поставь policyRuleIds=[selection.cutter_ambiguous_material_question], requiresTools=false, selectionPolicy.maxCards=0. В ответе дай короткую ориентацию и задай один главный вопрос: по какому материалу и какой работе нужен рез.',
    category: 'selection',
    tags: ['cutter', 'ambiguous_category', 'selection', 'material_question'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'high',
    severity: 'must',
    priority: 85,
    mandatory: false,
    forbiddenActions: ['mix_joint_cutters_and_cutoff_saws_as_matches', 'show_cutter_cards_before_material_or_work_is_clear'],
    repairAction: 'replace broad mixed recommendations with a short orientation and one material/work clarification question',
    reviewBy
  }),
  policyRule({
    code: 'correction.verify_before_apology',
    title: 'Исправления только после проверки',
    body: 'Buyer corrections require evidence check before apologizing: buyer requirements by conversation memory, product facts by catalog plus reliable sources, stock/delivery/price by checked operational data.',
    category: 'correction',
    tags: ['correction', 'evidence', 'error_recovery'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'high',
    severity: 'must',
    priority: 86,
    mandatory: false,
    forbiddenActions: ['argue_without_checking', 'apologize_and_change_fact_without_evidence'],
    repairAction: 'check the right evidence class first, then briefly correct or explain conflict',
    reviewBy
  }),
  policyRule({
    code: 'photo.prefer_bakaut_card',
    title: 'Фото и ссылки — сначала карточка БАКАУТ',
    body: 'Если товар есть на bakautprof.ru и просят ссылку или фото, предпочитай карточку и фото БАКАУТ. Внешнее фото можно использовать только как ориентир и не выдавать за официальное.',
    category: 'media',
    tags: ['photo', 'link', 'bakaut'],
    appliesTo: ['answer', 'planner'],
    riskLevel: 'low',
    severity: 'should',
    priority: 45,
    mandatory: false,
    forbiddenActions: ['present_external_photo_as_official'],
    repairAction: 'prefer the BAKAUT product card/photo or label external photo as orientation'
  })
];

export const compiledSalesManagerPolicyPack = compilePolicyPack(salesManagerPolicyRules);
export const SALES_MANAGER_POLICY_PACK_VERSION = '2026-07-15.1';
export const SALES_MANAGER_POLICY_PACK_HASH = createHash('sha256')
  .update(JSON.stringify(salesManagerPolicyRules.map((rule) => ({
    code: rule.code,
    version: rule.version,
    status: rule.status,
    mandatory: rule.mandatory,
    appliesTo: rule.appliesTo,
    body: rule.body,
    forbiddenActions: rule.forbiddenActions,
    repairAction: rule.repairAction
  }))))
  .digest('hex');

export interface SalesManagerPolicyTraceInput {
  target: 'planner' | 'answer' | 'gate';
  latestUserMessage?: string;
  tags?: string[];
  riskFlags?: string[];
  semanticRuleIds?: string[];
  enabled?: boolean;
  shadowMode?: boolean;
  maxRules?: number;
}

export interface SalesManagerPolicyTrace {
  version: 2;
  policyPackVersion: typeof SALES_MANAGER_POLICY_PACK_VERSION;
  policyPackHash: string;
  mode: 'static' | 'dynamic' | 'shadow' | 'disabled';
  target: SalesManagerPolicyTraceInput['target'];
  tags: string[];
  riskFlags: string[];
  reasonCodes: string[];
  selectedRuleCodes: string[];
  shadowSelectedRuleCodes: string[];
  promptBlock: string;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function mandatoryPromptRulesForTarget(target: SalesManagerPolicyTraceInput['target']) {
  return selectPolicyRules(compiledSalesManagerPolicyPack, {
    tags: ['core'],
    riskFlags: [],
    target,
    maxRules: 0
  });
}

export function buildSalesManagerPolicyTrace(input: SalesManagerPolicyTraceInput): SalesManagerPolicyTrace {
  const enabled = input.enabled ?? true;
  const tags = unique(input.tags ?? []);
  const riskFlags = unique(input.riskFlags ?? []);
  const semanticRuleIds = unique(input.semanticRuleIds ?? []);
  const dynamicRules = selectPolicyRules(compiledSalesManagerPolicyPack, {
    tags,
    riskFlags,
    target: input.target,
    semanticRuleIds,
    maxRules: input.maxRules ?? (input.target === 'planner' ? 9 : 7)
  });
  const activeRules = !enabled
    ? []
    : input.shadowMode
      ? mandatoryPromptRulesForTarget(input.target)
      : dynamicRules;
  return {
    version: 2,
    policyPackVersion: SALES_MANAGER_POLICY_PACK_VERSION,
    policyPackHash: SALES_MANAGER_POLICY_PACK_HASH,
    mode: !enabled ? 'disabled' : input.shadowMode ? 'shadow' : 'dynamic',
    target: input.target,
    tags,
    riskFlags,
    reasonCodes: unique([
      ...tags.map((tag) => `structured_tag:${tag}`),
      ...riskFlags.map((risk) => `structured_risk:${risk}`),
      ...semanticRuleIds.map((ruleId) => `planner_rule:${ruleId}`),
      ...(!tags.length && !riskFlags.length && !semanticRuleIds.length ? ['mandatory_business_rules'] : [])
    ]),
    selectedRuleCodes: activeRules.map((rule) => rule.code),
    shadowSelectedRuleCodes: input.shadowMode ? dynamicRules.map((rule) => rule.code) : [],
    promptBlock: formatPolicyRulesForPrompt(activeRules)
  };
}

export function salesManagerBehaviorPolicyPromptBlock(input: Partial<SalesManagerPolicyTraceInput> = {}) {
  return buildSalesManagerPolicyTrace({
    target: 'answer',
    latestUserMessage: input.latestUserMessage,
    tags: input.tags,
    riskFlags: input.riskFlags,
    semanticRuleIds: input.semanticRuleIds,
    enabled: input.enabled,
    shadowMode: input.shadowMode,
    maxRules: input.maxRules
  }).promptBlock;
}

export function salesManagerPlannerPolicyPromptBlock(input: Partial<SalesManagerPolicyTraceInput> = {}) {
  const optionalPlannerRuleIds = salesManagerPolicyRules
    .filter((rule) => rule.status === 'active' && !rule.mandatory && rule.appliesTo.includes('planner'))
    .map((rule) => rule.code);
  return buildSalesManagerPolicyTrace({
    target: 'planner',
    tags: input.tags,
    riskFlags: input.riskFlags,
    semanticRuleIds: input.semanticRuleIds ?? optionalPlannerRuleIds,
    enabled: input.enabled,
    shadowMode: input.shadowMode,
    maxRules: input.maxRules ?? 100
  }).promptBlock;
}
