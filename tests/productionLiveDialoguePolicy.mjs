import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeDialogueText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function dialogueSignature(turns) {
  const canonical = turns.map((turn) => ({
    phase: normalizeDialogueText(turn.phase),
    user: normalizeDialogueText(turn.user)
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

async function readCandidateFiles(artifactDir) {
  try {
    const entries = await fs.readdir(artifactDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(artifactDir, entry.name))
      .filter((filePath) => /\.(production\.md|json)$/iu.test(filePath));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function findPriorDialogueSignature({
  artifactDir = 'local-live-tests',
  signature,
  excludePaths = []
} = {}) {
  const excluded = new Set(excludePaths.map((candidate) => path.resolve(candidate)));
  const files = await readCandidateFiles(artifactDir);
  const matches = [];

  for (const filePath of files) {
    if (excluded.has(path.resolve(filePath))) continue;
    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (!content.includes(signature)) continue;
    matches.push(filePath);
  }

  return matches;
}

export async function assertNonRepeatingProductionDialogue({
  scriptName,
  scenarioName = 'unnamed-production-live-dialogue',
  turns,
  artifactDir = 'local-live-tests',
  env = process.env,
  excludePaths = []
} = {}) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error('production_live_dialogue_policy_requires_turns');
  }

  const signature = dialogueSignature(turns);
  const metadata = {
    policy: 'non_repeating_production_live_dialogue',
    scriptName,
    scenarioName,
    dialogueSignature: signature,
    turnCount: turns.length,
    turnPhases: turns.map((turn) => String(turn.phase ?? 'unknown'))
  };

  if (env.ALLOW_REPEAT_PRODUCTION_LIVE_DIALOGUE === '1') {
    return { ...metadata, repeatedDialogueOverride: true, priorMatches: [] };
  }

  const priorMatches = await findPriorDialogueSignature({ artifactDir, signature, excludePaths });
  if (priorMatches.length) {
    const error = new Error('production_live_dialogue_signature_repeated');
    error.details = { ...metadata, priorMatches };
    throw error;
  }

  return { ...metadata, repeatedDialogueOverride: false, priorMatches: [] };
}

export function dialoguePolicyMarkdown(policy) {
  return [
    `Live dialogue policy: ${policy.policy}`,
    `Scenario: ${policy.scenarioName}`,
    `Dialogue signature: ${policy.dialogueSignature}`,
    `Turns: ${policy.turnCount}`,
    `Repeated dialogue override: ${policy.repeatedDialogueOverride ? 'yes' : 'no'}`
  ];
}
