import type {
  CardManifest,
  FactClaimPlanner,
  LeadStateMachine,
  PostAnswerVerificationRecovery,
  ProductEvidenceRegistry
} from '../shared/types.js';
import { auditAnswerFactClaims } from './factClaimPlanner.js';
import {
  classifyPostAnswerRecovery,
  repairAnswerForPostAnswerVerification,
  verifyPostAnswer
} from './postAnswerVerifier.js';

export function applyPostAnswerVerificationPolicy(input: {
  answer: string;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
  cardManifest: CardManifest;
  productEvidenceRegistry?: ProductEvidenceRegistry;
}) {
  let answer = input.answer.trim();
  let factClaimAudit = auditAnswerFactClaims({
    answer,
    factClaimPlanner: input.factClaimPlanner,
    cardManifest: input.cardManifest
  });
  let postAnswerVerification = verifyPostAnswer({
    answer,
    factClaimPlanner: input.factClaimPlanner,
    leadStateMachine: input.leadStateMachine,
    cardManifest: input.cardManifest,
    factClaimAudit,
    productEvidenceRegistry: input.productEvidenceRegistry
  });
  const postAnswerVerificationRecovery: PostAnswerVerificationRecovery = {
    attempted: false,
    recovered: false,
    issuesBefore: postAnswerVerification.issues.map((issue) => issue.code),
    issuesAfter: postAnswerVerification.issues.map((issue) => issue.code),
    method: 'none',
    repairableIssues: [],
    unrecoverableIssues: [],
    reason: undefined
  };

  if (postAnswerVerification.status === 'error') {
    const recoveryPolicy = classifyPostAnswerRecovery(postAnswerVerification);
    postAnswerVerificationRecovery.repairableIssues = recoveryPolicy.repairableIssues;
    postAnswerVerificationRecovery.unrecoverableIssues = recoveryPolicy.unrecoverableIssues;
    postAnswerVerificationRecovery.reason = recoveryPolicy.requiresRegenerationOrTooling
      ? 'unrecoverable_issues_require_regeneration_or_tooling'
      : 'deterministic_text_repair_available';
    const repairedAnswer = repairAnswerForPostAnswerVerification({ answer, verification: postAnswerVerification });
    if (repairedAnswer !== answer) {
      postAnswerVerificationRecovery.attempted = true;
      postAnswerVerificationRecovery.method = 'deterministic_text_repair';
      answer = repairedAnswer;
      factClaimAudit = auditAnswerFactClaims({
        answer,
        factClaimPlanner: input.factClaimPlanner,
        cardManifest: input.cardManifest
      });
      postAnswerVerification = verifyPostAnswer({
        answer,
        factClaimPlanner: input.factClaimPlanner,
        leadStateMachine: input.leadStateMachine,
        cardManifest: input.cardManifest,
        factClaimAudit,
        productEvidenceRegistry: input.productEvidenceRegistry
      });
      postAnswerVerificationRecovery.recovered = postAnswerVerification.status !== 'error';
      postAnswerVerificationRecovery.issuesAfter = postAnswerVerification.issues.map((issue) => issue.code);
      if (!postAnswerVerificationRecovery.recovered) {
        const afterRecoveryPolicy = classifyPostAnswerRecovery(postAnswerVerification);
        postAnswerVerificationRecovery.unrecoverableIssues = afterRecoveryPolicy.unrecoverableIssues;
        postAnswerVerificationRecovery.reason = afterRecoveryPolicy.requiresRegenerationOrTooling
          ? 'deterministic_text_repair_left_unrecoverable_issues'
          : 'deterministic_text_repair_did_not_clear_errors';
      }
    }
  }

  return {
    answer,
    factClaimAudit,
    postAnswerVerification,
    postAnswerVerificationRecovery
  };
}
