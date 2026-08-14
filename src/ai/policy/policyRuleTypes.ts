export type PolicyRuleApplyTarget = 'planner' | 'answer' | 'gate';
export type PolicyRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PolicySeverity = 'may' | 'should' | 'must' | 'must_not';
export type PolicyRuleStatus = 'active' | 'draft' | 'deprecated';

export interface PolicyRulePredicate {
  field: string;
  operator: 'equals' | 'includes' | 'exists';
  value?: string | boolean | number;
}

export interface PolicyRule {
  id: string;
  code: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  appliesTo: PolicyRuleApplyTarget[];
  riskLevel: PolicyRiskLevel;
  severity: PolicySeverity;
  priority: number;
  mandatory: boolean;
  predicates: PolicyRulePredicate[];
  allowedActions: string[];
  forbiddenActions: string[];
  repairAction: string;
  owner: string;
  version: number;
  status: PolicyRuleStatus;
  tokenEstimate: number;
  reviewBy?: string;
  dependsOn?: string[];
}

export interface CompiledPolicyPack {
  version: 1;
  rules: PolicyRule[];
  activeRules: PolicyRule[];
  mandatoryRules: PolicyRule[];
  byCode: Map<string, PolicyRule>;
  byTag: Map<string, PolicyRule[]>;
}

export interface PolicySelectionInput {
  tags: string[];
  riskFlags: string[];
  target?: PolicyRuleApplyTarget;
  semanticRuleIds?: string[];
  maxRules?: number;
}
