import type { ChatResponsePayload } from '../shared/types.js';

export type AdminDiagnosticFlag = { label: string; warn?: boolean };

export function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function shortReason(reason: unknown) {
  const value = String(reason ?? '').trim();
  if (!value) return 'unknown';
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

export function adminReadinessLabel(metadata?: ChatResponsePayload['metadata']) {
  const current = metadataRecord(metadata?.selectionReadiness);
  const status = typeof current?.status === 'string' ? current.status : '';
  if (status) return status;
  const legacy = metadataRecord(metadata?.cardSelection);
  return legacy?.readinessBlocked === true ? 'blocked' : 'unknown';
}

export function adminRuntimeFlags(metadata?: ChatResponsePayload['metadata']): AdminDiagnosticFlag[] {
  if (!metadata) return [];
  const flags: AdminDiagnosticFlag[] = [];
  const runtimeMode = metadata.runtimeMode ?? (metadata.agentManager ? 'agent_manager' : undefined);
  if (runtimeMode === 'agent_manager') {
    const runtimeReason = metadata.runtimeModeReason ?? metadata.agentManagerRuntime?.reason ?? 'unknown';
    flags.push({ label: `mode: ${runtimeMode} (${shortReason(runtimeReason)})` });
  }
  const execution = metadata.executionContract;
  if (execution) flags.push({
    label: `exec: cards ${execution.cardsPolicy}, fact ${execution.factPolicy}, lead ${execution.leadPolicy}`,
    warn: execution.warnings.length > 0
  });
  const ledger = metadata.requirementLedger;
  if (ledger) flags.push({
    label: `req: ${ledger.items.length}, hard ${ledger.hardConstraintKeys.length}, alt ${ledger.alternativeMode}`,
    warn: ledger.warnings.length > 0
  });
  const manifest = metadata.cardManifest;
  if (manifest) {
    const visibleViolations = manifest.items.filter((item) => item.visible && item.constraintStatus === 'violates_hard_constraints').length;
    flags.push({ label: `cards: ${manifest.visibleProductIds.length}/${manifest.items.length}, ${manifest.cardsPolicy}`,
      warn: manifest.warnings.length > 0 || visibleViolations > 0 });
  }
  const factClaimAudit = metadata.factClaimAudit;
  const factClaimPlanner = metadata.factClaimPlanner;
  if (factClaimPlanner || factClaimAudit) flags.push({
    label: `facts: ${factClaimPlanner?.risk ?? 'n/a'}, claims ${factClaimAudit?.claims.length ?? 0}`,
    warn: Boolean(factClaimPlanner?.risk === 'high' || factClaimPlanner?.warnings.length || factClaimAudit?.warnings.length)
  });
  const leadState = metadata.leadStateMachine;
  if (leadState) flags.push({ label: `lead: ${leadState.state}, ${leadState.nextAction}`,
    warn: leadState.warnings.length > 0 || leadState.state === 'failed' });
  const verification = metadata.postAnswerVerification;
  if (verification) {
    const recovery = metadata.postAnswerVerificationRecovery;
    const recoveryLabel = recovery?.attempted ? `, recovered ${recovery.recovered ? 'yes' : 'no'}` : '';
    flags.push({ label: `verify: ${verification.status}, issues ${verification.issues.length}${recoveryLabel}`,
      warn: verification.status !== 'pass' || Boolean(recovery?.attempted && !recovery.recovered) });
  }
  const build = metadataRecord(metadata.build);
  if (typeof build?.commitSha === 'string' && build.commitSha) flags.push({ label: `build: ${build.commitSha.slice(0, 8)}` });
  const taskOutcome = metadataRecord(metadata.taskOutcome);
  if (taskOutcome) {
    const unresolved = arrayLength(taskOutcome.unresolvedFacts);
    const status = String(taskOutcome.status ?? 'unknown');
    flags.push({ label: `outcome: ${status}, unresolved ${unresolved}`, warn: status !== 'resolved' || unresolved > 0 });
  }
  const enforcement = metadataRecord(metadata.policyGateEnforcement);
  const failedRequiredTools = Array.isArray(enforcement?.failedRequiredTools)
    ? enforcement.failedRequiredTools.map(String).filter(Boolean) : [];
  if (failedRequiredTools.length) flags.push({ label: `required incomplete: ${failedRequiredTools.join(', ')}`, warn: true });
  const toolResults = Array.isArray(metadata.toolResults) ? metadata.toolResults : [];
  const research = toolResults.flatMap((raw) => {
    const result = metadataRecord(raw);
    if (result?.tool !== 'web.researchProductFacts') return [];
    const payload = metadataRecord(result.payload);
    return payload ? [payload] : [];
  });
  if (research.length) {
    const incomplete = research.some((payload) => payload.researchOutcome === 'partial' ||
      ['timed_out', 'failed', 'aborted', 'skipped_budget'].includes(String(payload.searchDisposition ?? '')));
    const exhausted = research.every((payload) => payload.sourcesExhausted === true);
    flags.push({ label: `research: ${incomplete ? 'partial' : 'complete'}, exhausted ${exhausted ? 'yes' : 'no'}`,
      warn: incomplete || !exhausted });
  }
  const warningCount = arrayLength(metadata.contractWarnings) + arrayLength(metadata.validatorWarnings) +
    arrayLength(metadata.warnings) + toolResults.reduce((count, raw) => count + arrayLength(metadataRecord(raw)?.warnings), 0) +
    (execution?.warnings.length ?? 0) + (ledger?.warnings.length ?? 0) + (manifest?.warnings.length ?? 0) +
    (factClaimPlanner?.warnings.length ?? 0) + (factClaimAudit?.warnings.length ?? 0) + (leadState?.warnings.length ?? 0);
  if (warningCount > 0) flags.push({ label: `warnings: ${warningCount}`, warn: true });
  return flags;
}

export function shouldShowLeadPanel(messages: ReadonlyArray<{
  role: string;
  leadRequested?: boolean;
  status?: string;
}>) {
  const latestAssistant = [...messages].reverse().find((message) =>
    message.role === 'assistant' && (message.status === undefined || message.status === 'done'));
  return latestAssistant?.leadRequested === true;
}
