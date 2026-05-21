import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  summarizePromptfooOutput,
  summaryPathFor,
  writeSummaryForFile
} = require('../evals/promptfoo/summarize-results.cjs') as {
  summarizePromptfooOutput: (output: unknown, inputPath?: string | null) => {
    deterministic: {
      resultCount: number;
      averageScore: number | null;
      assertionPassRate: number | null;
    };
    llm: {
      llmAverage: number | null;
      llmAverageStatus: string;
      llmComponentCount: number;
      llmBlockedCount: number;
    };
    gates: {
      deterministicAbove90: boolean;
      llmAverageAbove90: boolean;
      llmAverageUsable: boolean;
    };
  };
  summaryPathFor: (outputPath: string) => string;
  writeSummaryForFile: (outputPath: string) => { summaryPath: string };
};

const tempDirs: string[] = [];

function makeTempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'promptfoo-summary-'));
  tempDirs.push(directory);
  return directory;
}

function row(score: number, success: boolean, componentScores: Array<{ score: number; pass: boolean }> = []) {
  return {
    score,
    success,
    gradingResult: {
      componentResults: componentScores.map((component) => ({
        pass: component.pass,
        score: component.score,
        assertion: { type: 'javascript' }
      }))
    }
  };
}

describe('promptfoo result summary', () => {
  afterEach(() => {
    while (tempDirs.length) {
      const directory = tempDirs.pop();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('summarizes deterministic-only Promptfoo output and marks LLM average not configured', () => {
    const summary = summarizePromptfooOutput({
      results: {
        stats: { successes: 1, failures: 1, errors: 0 },
        results: [
          row(1, true, [{ score: 1, pass: true }, { score: 1, pass: true }]),
          row(0.5, false, [{ score: 1, pass: true }, { score: 0, pass: false }])
        ],
        prompts: []
      }
    });

    expect(summary.deterministic.resultCount).toBe(2);
    expect(summary.deterministic.averageScore).toBe(0.75);
    expect(summary.deterministic.assertionPassRate).toBe(0.75);
    expect(summary.llm.llmAverage).toBeNull();
    expect(summary.llm.llmAverageStatus).toBe('not_configured');
    expect(summary.gates.llmAverageUsable).toBe(false);
  });

  it('marks LLM average blocked when llm-rubric components only contain grader errors', () => {
    const summary = summarizePromptfooOutput({
      results: {
        stats: { successes: 0, failures: 1, errors: 0 },
        results: [
          {
            score: 0,
            success: false,
            gradingResult: {
              componentResults: [
                {
                  pass: false,
                  score: 0,
                  reason: 'API error: 403 Forbidden unsupported_country_region_territory',
                  metadata: { graderError: true },
                  assertion: { type: 'llm-rubric' }
                }
              ]
            }
          }
        ],
        prompts: []
      }
    });

    expect(summary.llm.llmAverage).toBeNull();
    expect(summary.llm.llmAverageStatus).toBe('blocked');
    expect(summary.llm.llmComponentCount).toBe(1);
    expect(summary.llm.llmBlockedCount).toBe(1);
  });

  it('averages scored LLM grader components and writes sibling summary artifacts', () => {
    const output = {
      results: {
        stats: { successes: 2, failures: 0, errors: 0 },
        results: [
          {
            score: 1,
            success: true,
            gradingResult: {
              componentResults: [
                { pass: true, score: 0.95, assertion: { type: 'llm-rubric' } }
              ]
            }
          },
          {
            score: 1,
            success: true,
            gradingResult: {
              componentResults: [
                { pass: true, score: 0.91, assertion: { type: 'llm-rubric' } }
              ]
            }
          }
        ],
        prompts: []
      }
    };
    const directory = makeTempDir();
    const outputPath = join(directory, 'promptfoo-output.json');
    writeFileSync(outputPath, JSON.stringify(output), 'utf8');

    const { summaryPath } = writeSummaryForFile(outputPath);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

    expect(summaryPath).toBe(summaryPathFor(outputPath));
    expect(summary.llm.llmAverage).toBe(0.9299999999999999);
    expect(summary.llm.llmAverageStatus).toBe('ready');
    expect(summary.gates.llmAverageAbove90).toBe(true);
  });

  it('prefers actual LLM component scores over Promptfoo named metric totals', () => {
    const summary = summarizePromptfooOutput({
      results: {
        stats: { successes: 1, failures: 0, errors: 0 },
        results: [
          {
            score: 1,
            success: true,
            gradingResult: {
              componentResults: [
                { pass: true, score: 0.9, assertion: { type: 'llm-rubric' } },
                { pass: true, score: 0.8, assertion: { type: 'llm-rubric' } }
              ]
            }
          }
        ],
        prompts: [
          { metrics: { namedScores: { llmAverage: 1.7 } } }
        ]
      }
    });

    expect(summary.llm.llmAverage).toBe(0.8500000000000001);
    expect(summary.llm.llmAverageStatus).toBe('ready');
  });
});
