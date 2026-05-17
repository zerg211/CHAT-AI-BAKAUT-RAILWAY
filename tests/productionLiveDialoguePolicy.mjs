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

function validateDialogueTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error('production_live_dialogue_policy_requires_turns');
  }
  const invalidIndex = turns.findIndex((turn) =>
    !turn ||
    typeof turn !== 'object' ||
    !String(turn.phase ?? '').trim() ||
    !String(turn.user ?? '').trim()
  );
  if (invalidIndex >= 0) {
    const error = new Error('production_live_dialogue_turn_invalid');
    error.details = { invalidIndex };
    throw error;
  }
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
    validateDialogueTurns(turns);
    return {
      turns,
      scenarioName: String(parsed.scenarioName || env.PRODUCTION_LIVE_SCENARIO_NAME || defaultScenarioName),
      source: 'file',
      scenarioFile
    };
  }

  validateDialogueTurns(defaultTurns);

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
