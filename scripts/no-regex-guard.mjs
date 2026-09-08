import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ts from 'typescript';

const ROOT_DIR = process.cwd();
const configuredBaselinePath = process.env.NO_REGEX_BASELINE_PATH;
const BASELINE_PATH = configuredBaselinePath
  ? path.resolve(ROOT_DIR, configuredBaselinePath)
  : path.join(ROOT_DIR, 'scripts', 'no-regex-baseline.json');
// Regex is a semantic hazard only in the modules that decide meaning,
// evidence, selection, or action policy. Protocol parsing, formatting,
// sanitization, tests, and evaluation harnesses are intentionally outside
// this guard and keep their own focused tests.
const SEMANTIC_SCOPE_FILES = [
  'src/ai/agentManagerContracts.ts',
  'src/ai/agentManagerContinuation.ts',
  'src/ai/agentManagerCardSelection.ts',
  'src/ai/agentManagerGeneratorLoad.ts',
  'src/ai/agentManagerModelContext.ts',
  'src/ai/agentManagerOrchestrator.ts',
  'src/ai/agentManagerOutputGuard.ts',
  'src/ai/agentManagerPolicyGate.ts',
  'src/ai/agentManagerTurnBudget.ts',
  'src/ai/readContinuationController.ts',
  'src/ai/recoveryCoordinator.ts',
  'src/ai/adaptiveConversationPolicy.ts',
  'src/ai/decisionArtifact.ts',
  'src/ai/dialogueLedgerReducer.ts',
  'src/ai/leadReviewGuards.ts',
  'src/ai/needState.ts',
  'src/ai/productClassifier.ts',
  'src/ai/productComparisonResearch.ts',
  'src/ai/requirementProofs.ts',
  'src/ai/salesManagerBehaviorPolicy.ts',
  'src/ai/verifiedFactMemory.ts'
];
const SCAN_ROOTS = ['semantic decision modules'];
const ROOT_FILES = [];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const REGEX_ARGUMENT_METHODS = new Set(['match', 'matchAll', 'replace', 'replaceAll', 'search', 'split']);
const REGEX_OWN_METHODS = new Set(['exec', 'test']);

const args = new Set(process.argv.slice(2));
const updateBaseline = args.has('--update-baseline');

function toProjectPath(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  return relativePath.split(path.sep).join('/');
}

function scriptKindFor(filePath) {
  const extension = path.extname(filePath);
  if (extension === '.tsx') {
    return ts.ScriptKind.TSX;
  }
  if (extension === '.jsx') {
    return ts.ScriptKind.JSX;
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function collectScanFiles() {
  return SEMANTIC_SCOPE_FILES
    .map((projectPath) => path.join(ROOT_DIR, ...projectPath.split('/')))
    .filter((filePath) => fs.existsSync(filePath) && CODE_EXTENSIONS.has(path.extname(filePath)))
    .sort((left, right) => toProjectPath(left).localeCompare(toProjectPath(right)));
}

function isRegExpIdentifier(node) {
  return ts.isIdentifier(node) && node.text === 'RegExp';
}

function isSyntacticRegexExpression(node) {
  if (!node) {
    return false;
  }
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return true;
  }
  if (ts.isNewExpression(node) && isRegExpIdentifier(node.expression)) {
    return true;
  }
  return ts.isCallExpression(node) && isRegExpIdentifier(node.expression);
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function pushFinding(findings, sourceFile, projectPath, node, kind) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const text = node.getText(sourceFile);
  const lf = text.replaceAll('\r\n', '\n');
  findings.push({
    file: projectPath,
    line: position.line + 1,
    column: position.character + 1,
    kind,
    hash: sourceHash(node.getText(sourceFile)),
    // Historical entries contain both Git LF and Windows CRLF. Only line-ending
    // variants of the identical AST expression are accepted; patterns cannot change.
    compatibleHashes: [...new Set([sourceHash(lf), sourceHash(lf.replaceAll('\n', '\r\n'))])],
  });
}

function visitNode(node, sourceFile, projectPath, findings) {
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    pushFinding(findings, sourceFile, projectPath, node, 'regular_expression_literal');
  }

  if (ts.isNewExpression(node) && isRegExpIdentifier(node.expression)) {
    pushFinding(findings, sourceFile, projectPath, node, 'regexp_constructor_new');
  }

  if (ts.isCallExpression(node)) {
    if (isRegExpIdentifier(node.expression)) {
      pushFinding(findings, sourceFile, projectPath, node, 'regexp_constructor_call');
    }

    if (ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const receiver = node.expression.expression;
      const firstArgument = node.arguments[0];

      if (REGEX_ARGUMENT_METHODS.has(methodName) && isSyntacticRegexExpression(firstArgument)) {
        pushFinding(findings, sourceFile, projectPath, node, `${methodName}_regex_argument`);
      }

      if (REGEX_OWN_METHODS.has(methodName) && isSyntacticRegexExpression(receiver)) {
        pushFinding(findings, sourceFile, projectPath, node, `regex_${methodName}_call`);
      }
    }
  }

  ts.forEachChild(node, (child) => visitNode(child, sourceFile, projectPath, findings));
}

function collectFindings() {
  const findings = [];
  for (const filePath of collectScanFiles()) {
    const projectPath = toProjectPath(filePath);
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(filePath),
    );
    visitNode(sourceFile, sourceFile, projectPath, findings);
  }

  const occurrences = new Map();
  return findings
    .sort((left, right) => {
      if (left.file !== right.file) {
        return left.file.localeCompare(right.file);
      }
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.column - right.column;
    })
    .map((finding) => {
      const compatibleIds = finding.compatibleHashes.map(hash => {
        const key = [finding.file, finding.kind, hash].join('|');
        const count = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, count);
        return `${key}|${count}`;
      });
      const occurrenceKey = [finding.file, finding.kind, finding.hash].join('|');
      const occurrence = occurrences.get(occurrenceKey);
      return {
        id: [finding.file, finding.kind, finding.hash, String(occurrence)].join('|'),
        file: finding.file,
        line: finding.line,
        column: finding.column,
        kind: finding.kind,
        hash: finding.hash,
        occurrence,
        compatibleIds,
      };
    });
}

function baselinePayload(findings) {
  return {
    version: 1,
    note: 'Targeted semantic regex baseline. Regex in protocol parsing, formatting, sanitization, tests, and evals is out of scope. Entries store hashes, not regex pattern text.',
    semanticScopeFiles: SEMANTIC_SCOPE_FILES,
    scannedRoots: SCAN_ROOTS,
    rootFiles: ROOT_FILES,
    count: findings.length,
    findings: findings.map((finding) => ({
      id: finding.id,
      file: finding.file,
      kind: finding.kind,
      hash: finding.hash,
      occurrence: finding.occurrence,
    })),
  };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`Missing ${toProjectPath(BASELINE_PATH)}.`);
    console.error('Run npm run lint:no-regex -- --update-baseline after reviewing the legacy findings.');
    process.exit(1);
  }
  let baselineText = fs.readFileSync(BASELINE_PATH, 'utf8');
  if (baselineText.charCodeAt(0) === 0xfeff) {
    baselineText = baselineText.slice(1);
  }
  return JSON.parse(baselineText);
}

function writeBaseline(findings) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baselinePayload(findings), null, 2)}\n`);
  console.log(`Updated ${toProjectPath(BASELINE_PATH)} with ${findings.length} legacy findings.`);
}

function formatFinding(finding) {
  return `${finding.file}:${finding.line}:${finding.column} ${finding.kind} ${finding.hash}`;
}

function main() {
  const findings = collectFindings();
  if (updateBaseline) {
    writeBaseline(findings);
    return;
  }

  const baseline = readBaseline();
  const baselineIds = new Set(baseline.findings.map((finding) => finding.id));
  const currentIds = new Set(findings.flatMap((finding) => finding.compatibleIds));
  const newFindings = findings.filter((finding) => !finding.compatibleIds.some(id => baselineIds.has(id)));
  const removedBaseline = baseline.findings.filter((finding) => !currentIds.has(finding.id));

  if (newFindings.length > 0) {
    console.error(`New regex constructs detected: ${newFindings.length}`);
    for (const finding of newFindings) {
      console.error(`- ${formatFinding(finding)}`);
    }
    console.error('Replace with typed parsing, semantic LLM planning, or explicit deterministic checks.');
    process.exit(1);
  }

  console.log(`No new regex constructs. Legacy baseline: ${baseline.findings.length}.`);
  if (removedBaseline.length > 0) {
    console.log(`Legacy findings removed since baseline: ${removedBaseline.length}.`);
    console.log('Run npm run lint:no-regex -- --update-baseline after reviewing the removal.');
  }
}

main();
