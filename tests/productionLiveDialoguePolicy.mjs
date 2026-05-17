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
    const files = [];
    for (const entry of entries) {
      const filePath = path.join(artifactDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await readCandidateFiles(filePath));
        continue;
      }
      if (entry.isFile() && /\.(production\.md|json)$/iu.test(filePath)) {
        files.push(filePath);
      }
    }
    return files;
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
  validateProductionLiveDialogueTurns(turns);

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

export function analyzeProductionLiveDialogueTurns(turns, { minTurns = 1, minUserLength = 12 } = {}) {
  const issues = [];
  if (!Array.isArray(turns) || turns.length < minTurns) {
    issues.push({
      code: 'not_enough_turns',
      expectedMinTurns: minTurns,
      actualTurns: Array.isArray(turns) ? turns.length : 0
    });
    return { ok: false, issues };
  }

  const seenUsers = new Set();
  turns.forEach((turn, index) => {
    const phase = String(turn?.phase ?? '').trim();
    const user = String(turn?.user ?? '').trim();
    if (!turn || typeof turn !== 'object' || !phase || !user) {
      issues.push({ code: 'invalid_turn_shape', index });
      return;
    }
    if (user.length < minUserLength) {
      issues.push({ code: 'user_text_too_short', index, minUserLength, actualLength: user.length });
    }
    if (/undefined|null|\[object Object\]/iu.test(user)) {
      issues.push({ code: 'technical_placeholder_in_user_text', index });
    }
    if (/[\u0400\u0402-\u040F\u0490-\u052F]/u.test(user) || /(?:Р[—–ґµ»«]|С[Ѓ‚ѓ„…†‡€‰‹ЊЋЏ])/u.test(user)) {
      issues.push({ code: 'suspicious_cyrillic_encoding_artifacts', index });
    }
    const normalized = normalizeDialogueText(user);
    if (seenUsers.has(normalized)) {
      issues.push({ code: 'duplicate_user_text', index });
    }
    seenUsers.add(normalized);
  });

  return { ok: issues.length === 0, issues };
}

export function validateProductionLiveDialogueTurns(turns, options = {}) {
  const quality = analyzeProductionLiveDialogueTurns(turns, options);
  if (!quality.ok) {
    const error = new Error('production_live_dialogue_turns_not_ready');
    error.details = quality;
    throw error;
  }
  return true;
}

export async function loadProductionLiveDialogue({
  defaultTurns,
  defaultScenarioName = 'bundled-production-live-dialogue',
  scenarioFile = process.env.PRODUCTION_LIVE_DIALOGUE_FILE,
  env = process.env
} = {}) {
  if (scenarioFile) {
    const raw = await fs.readFile(scenarioFile, 'utf8');
    const parsed = JSON.parse(raw);
    const turns = Array.isArray(parsed) ? parsed : parsed.turns;
    validateProductionLiveDialogueTurns(turns, { minTurns: 6, minUserLength: 20 });
    return {
      turns,
      scenarioName: String(parsed.scenarioName || env.PRODUCTION_LIVE_SCENARIO_NAME || defaultScenarioName),
      source: 'file',
      scenarioFile
    };
  }

  validateProductionLiveDialogueTurns(defaultTurns);

  if (env.ALLOW_BUNDLED_PRODUCTION_LIVE_DIALOGUE !== '1') {
    const error = new Error('bundled_production_live_dialogue_not_approved');
    error.details = {
      policy: 'Final production live dialogs must use a fresh PRODUCTION_LIVE_DIALOGUE_FILE unless the bundled scenario is explicitly approved.',
      requiredEnv: {
        PRODUCTION_LIVE_DIALOGUE_FILE: 'path to a fresh JSON scenario with { "scenarioName": "...", "turns": [{ "phase": "...", "user": "..." }] }',
        ALLOW_BUNDLED_PRODUCTION_LIVE_DIALOGUE: '1 only for an intentional bundled scenario run'
      }
    };
    throw error;
  }

  return {
    turns: defaultTurns,
    scenarioName: String(env.PRODUCTION_LIVE_SCENARIO_NAME || defaultScenarioName),
    source: 'bundled',
    scenarioFile: null
  };
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
