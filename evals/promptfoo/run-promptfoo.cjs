const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { writeSummaryForFile } = require('./summarize-results.cjs');

const promptfooIndexPath = require.resolve('promptfoo');
const promptfooRoot = path.resolve(path.dirname(promptfooIndexPath), '..', '..');
const promptfooEntrypoint = path.join(promptfooRoot, 'dist', 'src', 'entrypoint.js');
const args = process.argv.slice(2);

function outputPathFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '-o' || arg === '--output') && typeof argv[index + 1] === 'string') {
      return argv[index + 1];
    }
    const outputPrefix = '--output=';
    if (typeof arg === 'string' && arg.startsWith(outputPrefix)) {
      return arg.slice(outputPrefix.length);
    }
  }
  return null;
}

const result = spawnSync(process.execPath, [promptfooEntrypoint, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK || '1',
    PROMPTFOO_DISABLE_TELEMETRY: process.env.PROMPTFOO_DISABLE_TELEMETRY || '1',
    PROMPTFOO_DISABLE_UPDATE: process.env.PROMPTFOO_DISABLE_UPDATE || '1'
  }
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const outputPath = outputPathFromArgs(args);
if (outputPath && fs.existsSync(outputPath)) {
  try {
    const { summary, summaryPath } = writeSummaryForFile(outputPath);
    console.log(`Promptfoo summary: ${summaryPath}`);
    console.log(`Deterministic average: ${summary.deterministic.averageScore ?? 'n/a'}`);
    console.log(`LLM average status: ${summary.llm.llmAverageStatus}`);
  } catch (error) {
    console.error(`Failed to write Promptfoo summary: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(result.status ?? 1);
  }
}

process.exit(result.status ?? 1);
