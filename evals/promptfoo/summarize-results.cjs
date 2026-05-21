const fs = require('node:fs');
const path = require('node:path');

const LLM_ASSERTION_TYPES = new Set(['llm-rubric']);

function readJson(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return JSON.parse(text);
}

function toNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function average(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function lowerText(value) {
  return String(value || '').toLocaleLowerCase('en-US');
}

function includesAny(text, needles) {
  const haystack = lowerText(text);
  return needles.some((needle) => haystack.includes(needle));
}

function resultRows(promptfooOutput) {
  const rows = promptfooOutput?.results?.results;
  return Array.isArray(rows) ? rows : [];
}

function statsBlock(promptfooOutput) {
  const stats = promptfooOutput?.results?.stats;
  return stats && typeof stats === 'object' ? stats : {};
}

function promptMetrics(promptfooOutput) {
  const prompts = promptfooOutput?.results?.prompts;
  return Array.isArray(prompts) ? prompts.map((prompt) => prompt?.metrics || {}) : [];
}

function assertionComponents(row) {
  const components = row?.gradingResult?.componentResults;
  return Array.isArray(components) ? components : [];
}

function assertionType(component) {
  const assertion = component?.assertion;
  return typeof assertion?.type === 'string' ? assertion.type : '';
}

function isLlmComponent(component) {
  return LLM_ASSERTION_TYPES.has(assertionType(component));
}

function hasGraderBlocker(component) {
  const reason = [
    component?.reason,
    component?.error,
    component?.metadata?.error,
    component?.metadata?.graderError ? 'graderError' : '',
  ].filter(Boolean).join(' ');
  return Boolean(component?.metadata?.graderError) || includesAny(reason, [
    'api error',
    '403',
    'unsupported_country_region_territory',
    'country, region, or territory not supported',
    'forbidden',
    'gradererror',
  ]);
}

function collectLlmScores(rows) {
  const components = rows.flatMap(assertionComponents).filter(isLlmComponent);
  const scored = [];
  for (const component of components) {
    const score = toNumber(component.score);
    if (score !== null && !hasGraderBlocker(component)) {
      scored.push(score);
    }
  }
  return {
    componentCount: components.length,
    blockedCount: components.filter(hasGraderBlocker).length,
    scores: scored,
  };
}

function namedScoreAverage(promptfooOutput, names) {
  const values = [];
  for (const metrics of promptMetrics(promptfooOutput)) {
    const namedScores = metrics.namedScores;
    if (!namedScores || typeof namedScores !== 'object') continue;
    for (const name of names) {
      const value = toNumber(namedScores[name]);
      if (value !== null) values.push(value);
    }
  }
  return average(values);
}

function deterministicStats(promptfooOutput) {
  const rows = resultRows(promptfooOutput);
  const stats = statsBlock(promptfooOutput);
  const resultScores = rows
    .map((row) => toNumber(row.score))
    .filter((score) => score !== null);
  const componentResults = rows.flatMap(assertionComponents);
  const assertionPassCount = componentResults.filter((component) => component.pass === true).length;
  const assertionFailCount = componentResults.filter((component) => component.pass === false).length;
  const assertionCount = assertionPassCount + assertionFailCount;
  const statsSuccesses = toNumber(stats.successes);
  const statsFailures = toNumber(stats.failures);
  const statsErrors = toNumber(stats.errors);

  return {
    resultCount: rows.length,
    successes: statsSuccesses ?? rows.filter((row) => row.success === true).length,
    failures: statsFailures ?? rows.filter((row) => row.success === false).length,
    errors: statsErrors ?? rows.filter((row) => row.error).length,
    averageScore: average(resultScores),
    assertionPassRate: assertionCount ? assertionPassCount / assertionCount : null,
    assertionPassCount,
    assertionFailCount,
    assertionCount,
  };
}

function llmAverageStats(promptfooOutput) {
  const rows = resultRows(promptfooOutput);
  const collected = collectLlmScores(rows);
  const namedAverage = namedScoreAverage(promptfooOutput, ['llmAverage', 'llm_average', 'llm']);
  const componentAverage = average(collected.scores);
  const llmAverage = componentAverage ?? namedAverage;

  if (llmAverage !== null) {
    return {
      llmAverage,
      llmAverageStatus: 'ready',
      llmComponentCount: collected.componentCount,
      llmBlockedCount: collected.blockedCount,
    };
  }

  if (collected.componentCount > 0 && collected.blockedCount === collected.componentCount) {
    return {
      llmAverage: null,
      llmAverageStatus: 'blocked',
      llmComponentCount: collected.componentCount,
      llmBlockedCount: collected.blockedCount,
    };
  }

  return {
    llmAverage: null,
    llmAverageStatus: 'not_configured',
    llmComponentCount: collected.componentCount,
    llmBlockedCount: collected.blockedCount,
  };
}

function summarizePromptfooOutput(promptfooOutput, inputPath = null) {
  const deterministic = deterministicStats(promptfooOutput);
  const llm = llmAverageStats(promptfooOutput);
  return {
    source: inputPath ? path.normalize(inputPath) : null,
    generatedAt: new Date().toISOString(),
    deterministic,
    llm,
    gates: {
      deterministicAbove90: deterministic.averageScore !== null ? deterministic.averageScore > 0.9 : false,
      llmAverageAbove90: llm.llmAverage !== null ? llm.llmAverage > 0.9 : false,
      llmAverageUsable: llm.llmAverageStatus === 'ready',
    },
  };
}

function summaryPathFor(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.summary.json`);
}

function writeSummaryForFile(outputPath) {
  const promptfooOutput = readJson(outputPath);
  const summary = summarizePromptfooOutput(promptfooOutput, outputPath);
  const summaryPath = summaryPathFor(outputPath);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, summaryPath };
}

function cli() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error('Usage: node evals/promptfoo/summarize-results.cjs <promptfoo-output.json>');
    process.exit(1);
  }
  const { summaryPath } = writeSummaryForFile(outputPath);
  console.log(`Wrote ${summaryPath}`);
}

if (require.main === module) {
  cli();
}

module.exports = {
  summarizePromptfooOutput,
  summaryPathFor,
  writeSummaryForFile,
};
