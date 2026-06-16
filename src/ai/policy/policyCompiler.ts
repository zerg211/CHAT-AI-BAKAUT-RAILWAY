import type { CompiledPolicyPack, PolicyRule, PolicySelectionInput } from './policyRuleTypes.js';

const riskRank: Record<PolicyRule['riskLevel'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function assertPolicyRule(rule: PolicyRule) {
  if (!rule.code.trim()) throw new Error('Policy rule code is required');
  if (!rule.id.trim()) throw new Error(`Policy rule id is required for ${rule.code}`);
  if (rule.priority < 0 || rule.priority > 100) {
    throw new Error(`Invalid priority for policy rule ${rule.code}: expected 0..100`);
  }
  if (rule.status === 'active' && (rule.riskLevel === 'critical' || rule.riskLevel === 'high')) {
    if (!rule.owner.trim() || !rule.reviewBy) {
      throw new Error(`High-risk policy rule ${rule.code} requires owner and reviewBy`);
    }
  }
  if (rule.mandatory && rule.status !== 'active') {
    throw new Error(`Mandatory policy rule ${rule.code} must be active`);
  }
}

function pushByTag(map: Map<string, PolicyRule[]>, rule: PolicyRule) {
  for (const tag of rule.tags) {
    const current = map.get(tag) ?? [];
    current.push(rule);
    map.set(tag, current);
  }
}

function sortRules(rules: PolicyRule[]) {
  return [...rules].sort((left, right) => {
    if (left.mandatory !== right.mandatory) return left.mandatory ? -1 : 1;
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (riskRank[right.riskLevel] !== riskRank[left.riskLevel]) {
      return riskRank[right.riskLevel] - riskRank[left.riskLevel];
    }
    return left.code.localeCompare(right.code);
  });
}

export function compilePolicyPack(rules: PolicyRule[]): CompiledPolicyPack {
  const byCode = new Map<string, PolicyRule>();
  const byTag = new Map<string, PolicyRule[]>();
  for (const rule of rules) {
    assertPolicyRule(rule);
    if (byCode.has(rule.code)) throw new Error(`Duplicate policy rule code: ${rule.code}`);
    byCode.set(rule.code, rule);
    if (rule.status === 'active') pushByTag(byTag, rule);
  }
  const activeRules = sortRules(rules.filter((rule) => rule.status === 'active'));
  const mandatoryRules = activeRules.filter((rule) => rule.mandatory);
  return { version: 1, rules, activeRules, mandatoryRules, byCode, byTag };
}

export function selectPolicyRules(pack: CompiledPolicyPack, input: PolicySelectionInput): PolicyRule[] {
  const appliesToTarget = (rule: PolicyRule) => !input.target || rule.appliesTo.includes(input.target!);
  const selectedMandatory = pack.mandatoryRules.filter(appliesToTarget);
  const optional = new Map<string, PolicyRule>();

  const lookupTags = Array.from(new Set([...input.tags, ...input.riskFlags]));
  for (const tag of lookupTags) {
    for (const rule of pack.byTag.get(tag) ?? []) {
      if (!rule.mandatory && appliesToTarget(rule)) optional.set(rule.code, rule);
    }
  }

  for (const code of input.semanticRuleIds ?? []) {
    const rule = pack.byCode.get(code);
    if (rule?.status === 'active' && !rule.mandatory && appliesToTarget(rule)) optional.set(rule.code, rule);
  }

  const sortedMandatory = sortRules(selectedMandatory);
  const sortedOptional = sortRules(Array.from(optional.values()));
  if (input.maxRules === undefined) return [...sortedMandatory, ...sortedOptional];
  const optionalSlots = Math.max(0, input.maxRules - sortedMandatory.length);
  return [...sortedMandatory, ...sortedOptional.slice(0, optionalSlots)];
}

export function formatPolicyRulesForPrompt(rules: PolicyRule[]) {
  if (!rules.length) return '';
  const lines = [
    'DYNAMIC SALES POLICY — принципы и ограничения на этот ход.',
    'Это не готовые ответы и не скрипты: формулируй живо под диалог, сохраняя смысл правил.',
    ''
  ];
  for (const rule of rules) {
    lines.push(`- [${rule.code}] ${rule.title}: ${rule.body}`);
    if (rule.forbiddenActions.length) lines.push(`  Запрещено: ${rule.forbiddenActions.join(', ')}.`);
    if (rule.repairAction) lines.push(`  Если нарушено: ${rule.repairAction}.`);
  }
  return lines.join('\n');
}
