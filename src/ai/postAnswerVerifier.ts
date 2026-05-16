import type {
  CardManifest,
  FactClaimAudit,
  FactClaimPlanner,
  LeadStateMachine,
  PostAnswerVerification,
  PostAnswerVerificationIssue
} from '../shared/types.js';

function normalized(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasContactAsk(answer: string) {
  return /(?:leave|send|write|provide|fill).{0,80}(?:phone|number|contact|name)|(?:callback|call\s+you)/iu.test(answer) ||
    /(?:\u043e\u0441\u0442\u0430\u0432|\u043d\u0430\u043f\u0438\u0448|\u0443\u043a\u0430\u0436|\u043f\u0440\u0438\u0448\u043b|\u0437\u0430\u043f\u043e\u043b\u043d).{0,100}(?:\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440|\u043a\u043e\u043d\u0442\u0430\u043a\u0442|\u0438\u043c\u044f)|(?:\u0438\u043c\u044f|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440|\u043a\u043e\u043d\u0442\u0430\u043a\u0442).{0,80}(?:\u0444\u043e\u0440\u043c|\u0437\u0430\u044f\u0432\u043a)/iu.test(answer);
}

function stripContactAskSentences(answer: string) {
  const sentences = answer.split(/(?<=[.!?\n])\s+/u);
  const kept = sentences.filter((sentence) => !hasContactAsk(sentence));
  return (kept.length ? kept : sentences).join(' ').replace(/\s{2,}/gu, ' ').trim();
}

function hasVerificationWording(answer: string) {
  return /(?:verify|confirm|check|calculate|logistics|before\s+(?:ordering|checkout))/iu.test(answer) ||
    /(?:\u0441\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u0440\u043e\u0432\u0435\u0440|\u043f\u043e\u0441\u0447\u0438\u0442|\u0441\u043e\u0433\u043b\u0430\u0441|\u043b\u043e\u0433\u0438\u0441\u0442|\u043f\u0435\u0440\u0435\u0434\s+\u043e\u0444\u043e\u0440\u043c\u043b)/iu.test(answer);
}

function hasFinalCommercialPromise(answer: string) {
  return /(?:in\s+stock|available\s+(?:now|today)|delivery\s+(?:is|costs|will)|discount\s+(?:is|will)|ships\s+today)/iu.test(answer) ||
    /(?:\u0442\u043e\u0447\u043d\u043e\s+)?(?:\u0435\u0441\u0442\u044c\s+\u0432\s+\u043d\u0430\u043b\u0438\u0447\u0438\u0438|\u043d\u0430\s+\u0441\u043a\u043b\u0430\u0434\u0435|\u043e\u0442\u0433\u0440\u0443\u0437\u0438\u043c\s+(?:\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\u0437\u0430\u0432\u0442\u0440\u0430)|\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430\s+(?:\u0441\u0442\u043e\u0438\u0442|\u0431\u0443\u0434\u0435\u0442|\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d)|\u0441\u043a\u0438\u0434\u043a\u0430\s+(?:\u0431\u0443\u0434\u0435\u0442|\u0435\u0441\u0442\u044c|\u0441\u043e\u0441\u0442\u0430\u0432\u0438\u0442))/iu.test(answer);
}

function softenCommercialPromises(answer: string) {
  return answer
    .replace(/(?:\u0442\u043e\u0447\u043d\u043e\s+)?\u0435\u0441\u0442\u044c\s+\u0432\s+\u043d\u0430\u043b\u0438\u0447\u0438\u0438/giu, '\u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u043e\u0435 \u043d\u0430\u043b\u0438\u0447\u0438\u0435 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c')
    .replace(/\u043d\u0430\s+\u0441\u043a\u043b\u0430\u0434\u0435/giu, '\u0441\u043a\u043b\u0430\u0434 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c')
    .replace(/\u043e\u0442\u0433\u0440\u0443\u0437\u0438\u043c\s+(?:\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\u0437\u0430\u0432\u0442\u0440\u0430)/giu, '\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u044c \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c')
    .replace(/\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430\s+(?:\u0441\u0442\u043e\u0438\u0442|\u0431\u0443\u0434\u0435\u0442|\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d)[^.!?\n]*/giu, '\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0438 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0438 \u043f\u043e\u0441\u0447\u0438\u0442\u0430\u044e \u0447\u0435\u0440\u0435\u0437 \u043b\u043e\u0433\u0438\u0441\u0442\u0438\u043a\u0443')
    .replace(/\u0441\u043a\u0438\u0434\u043a\u0430\s+(?:\u0431\u0443\u0434\u0435\u0442|\u0435\u0441\u0442\u044c|\u0441\u043e\u0441\u0442\u0430\u0432\u0438\u0442)[^.!?\n]*/giu, '\u043a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u0438\u0435 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function answerMentionsName(answer: string, name: string) {
  const cleanAnswer = normalized(answer);
  const cleanName = normalized(name);
  if (!cleanName) return false;
  if (cleanAnswer.includes(cleanName)) return true;
  const distinctiveTokens = cleanName
    .split(/[^a-z0-9\u0430-\u044f\u0451]+/iu)
    .filter((token) => token.length >= 4);
  return distinctiveTokens.length >= 2 && distinctiveTokens.every((token) => cleanAnswer.includes(token));
}

function statusForIssues(issues: PostAnswerVerificationIssue[]): PostAnswerVerification['status'] {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length) return 'warn';
  return 'pass';
}

function factClaimAuditSeverity(warning: string): PostAnswerVerificationIssue['severity'] {
  if (
    warning === 'availability_claim_without_specialist_verification_wording' ||
    warning === 'delivery_claim_without_specialist_verification_wording' ||
    warning === 'terms_claim_without_specialist_verification_wording' ||
    warning === 'current_lineup_claim_without_web_policy'
  ) {
    return 'error';
  }
  return 'warning';
}

const deterministicRepairableIssueCodes = new Set([
  'lead_contact_ask_forbidden',
  'unverified_specialist_fact_promise',
  'fact_claim_audit:availability_claim_without_specialist_verification_wording',
  'fact_claim_audit:delivery_claim_without_specialist_verification_wording',
  'fact_claim_audit:terms_claim_without_specialist_verification_wording'
]);

export function classifyPostAnswerRecovery(verification: PostAnswerVerification) {
  const errorCodes = verification.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
  const repairableIssues = errorCodes.filter((code) => deterministicRepairableIssueCodes.has(code));
  const unrecoverableIssues = errorCodes.filter((code) => !deterministicRepairableIssueCodes.has(code));
  return {
    repairableIssues,
    unrecoverableIssues,
    canAttemptDeterministicRepair: repairableIssues.length > 0,
    requiresRegenerationOrTooling: unrecoverableIssues.length > 0
  };
}

export function verifyPostAnswer(input: {
  answer: string;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
  cardManifest: CardManifest;
  factClaimAudit?: FactClaimAudit;
}): PostAnswerVerification {
  const issues: PostAnswerVerificationIssue[] = [];

  if (input.leadStateMachine.nextAction === 'do_not_ask_contact' && hasContactAsk(input.answer)) {
    issues.push({
      code: 'lead_contact_ask_forbidden',
      severity: 'error',
      message: 'Answer asks for contact while lead policy forbids contact collection.'
    });
  }

  if (
    input.factClaimPlanner.forbiddenClaims.includes('do_not_promise_live_stock_delivery_discount_or_exact_terms') &&
    hasFinalCommercialPromise(input.answer) &&
    !hasVerificationWording(input.answer)
  ) {
    issues.push({
      code: 'unverified_specialist_fact_promise',
      severity: 'error',
      message: 'Answer appears to promise stock, delivery, discount, or exact terms without verification wording.'
    });
  }

  const violatingVisibleItems = input.cardManifest.items.filter((item) =>
    item.visible && item.constraintStatus === 'violates_hard_constraints'
  );
  for (const item of violatingVisibleItems) {
    if (answerMentionsName(input.answer, item.name)) {
      issues.push({
        code: 'violating_card_named_as_recommendation',
        severity: 'error',
        message: `Answer names visible card ${item.productId} even though it violates hard constraints.`
      });
    } else {
      issues.push({
        code: 'visible_card_constraint_violation_present',
        severity: 'warning',
        message: `Visible card ${item.productId} violates hard constraints.`
      });
    }
  }

  for (const warning of input.factClaimPlanner.warnings) {
    issues.push({
      code: warning,
      severity: warning.startsWith('visible_card_constraint_violation:') ? 'error' : 'warning',
      message: `Fact claim planner warning: ${warning}`
    });
  }
  for (const warning of input.factClaimAudit?.warnings ?? []) {
    issues.push({
      code: `fact_claim_audit:${warning}`,
      severity: factClaimAuditSeverity(warning),
      message: `Fact claim audit warning: ${warning}`
    });
  }

  return {
    version: 1,
    status: statusForIssues(issues),
    issues,
    checkedPolicies: [
      'lead_contact_policy',
      'specialist_fact_policy',
      'visible_card_constraint_policy',
      'fact_claim_planner_warnings',
      'fact_claim_audit_warnings'
    ]
  };
}

export function repairAnswerForPostAnswerVerification(input: {
  answer: string;
  verification: PostAnswerVerification;
}) {
  const recovery = classifyPostAnswerRecovery(input.verification);
  if (!recovery.canAttemptDeterministicRepair) return input.answer.trim();

  let repaired = input.answer.trim();
  const issueCodes = new Set(input.verification.issues.map((issue) => issue.code));

  if (issueCodes.has('lead_contact_ask_forbidden')) {
    repaired = stripContactAskSentences(repaired);
  }
  if (issueCodes.has('unverified_specialist_fact_promise')) {
    repaired = softenCommercialPromises(repaired);
  }
  if (
    issueCodes.has('fact_claim_audit:availability_claim_without_specialist_verification_wording') ||
    issueCodes.has('fact_claim_audit:delivery_claim_without_specialist_verification_wording') ||
    issueCodes.has('fact_claim_audit:terms_claim_without_specialist_verification_wording')
  ) {
    repaired = softenCommercialPromises(repaired);
  }

  return repaired || input.answer.trim();
}
