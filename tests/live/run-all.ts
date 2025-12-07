#!/usr/bin/env tsx
/**
 * Combined test runner that runs unit tests and live tests,
 * then displays a unified summary at the end.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: string;
  coverage?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
}

function parseJestOutput(output: string): TestResult {
  const result: TestResult = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    duration: ''
  };

  // Parse test counts: "Tests:       144 skipped, 2415 passed, 2559 total"
  // or "Tests:       3 failed, 158 passed, 161 total"
  const testsMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/);
  if (testsMatch) {
    result.failed = parseInt(testsMatch[1] || '0', 10);
    result.skipped = parseInt(testsMatch[2] || '0', 10);
    result.passed = parseInt(testsMatch[3], 10);
    result.total = parseInt(testsMatch[4], 10);
  }

  // Parse time: "Time:        98.483 s"
  const timeMatch = output.match(/Time:\s+([\d.]+)\s*s/);
  if (timeMatch) {
    result.duration = `${timeMatch[1]}s`;
  }

  // Parse coverage from summary lines like:
  // "All files                                         |     100 |      100 |     100 |     100 |"
  const coverageMatch = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
  if (coverageMatch) {
    result.coverage = {
      statements: parseFloat(coverageMatch[1]),
      branches: parseFloat(coverageMatch[2]),
      functions: parseFloat(coverageMatch[3]),
      lines: parseFloat(coverageMatch[4])
    };
  }

  return result;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';

    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      output += text;
    });

    child.stderr?.on('data', (data) => {
      const text = data.toString();
      process.stderr.write(text);
      output += text;
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  RUNNING ALL TESTS (Unit + Live)');
  console.log('='.repeat(70) + '\n');

  const jestBin = path.join(rootDir, 'node_modules', 'jest', 'bin', 'jest.js');
  const nodeArgs = ['--experimental-vm-modules'];

  // Run unit tests
  console.log('\n' + '-'.repeat(70));
  console.log('  UNIT TESTS');
  console.log('-'.repeat(70) + '\n');

  const unitResult = await runCommand(
    process.execPath,
    [...nodeArgs, jestBin, '--runInBand', '--forceExit'],
    { ...process.env }
  );
  const unitParsed = parseJestOutput(unitResult.output);

  // Run live tests
  console.log('\n' + '-'.repeat(70));
  console.log('  LIVE TESTS');
  console.log('-'.repeat(70) + '\n');

  const liveResult = await runCommand(
    process.execPath,
    [
      ...nodeArgs,
      jestBin,
      '--testPathPattern=live',
      '--maxWorkers=4',
      '--forceExit',
      '--coverage=false',
      '--testTimeout=300000'
    ],
    { ...process.env, LLM_LIVE: '1' }
  );
  const liveParsed = parseJestOutput(liveResult.output);

  // Print combined summary
  console.log('\n' + '='.repeat(70));
  console.log('  COMBINED TEST SUMMARY');
  console.log('='.repeat(70) + '\n');

  console.log('UNIT TESTS:');
  console.log(`  Passed:  ${unitParsed.passed}`);
  console.log(`  Failed:  ${unitParsed.failed}`);
  console.log(`  Skipped: ${unitParsed.skipped}`);
  console.log(`  Total:   ${unitParsed.total}`);
  console.log(`  Time:    ${unitParsed.duration}`);
  if (unitParsed.coverage) {
    console.log(`  Coverage: ${unitParsed.coverage.statements}% statements, ${unitParsed.coverage.branches}% branches, ${unitParsed.coverage.functions}% functions, ${unitParsed.coverage.lines}% lines`);
  }

  console.log('\nLIVE TESTS:');
  console.log(`  Passed:  ${liveParsed.passed}`);
  console.log(`  Failed:  ${liveParsed.failed}`);
  console.log(`  Skipped: ${liveParsed.skipped}`);
  console.log(`  Total:   ${liveParsed.total}`);
  console.log(`  Time:    ${liveParsed.duration}`);

  const totalPassed = unitParsed.passed + liveParsed.passed;
  const totalFailed = unitParsed.failed + liveParsed.failed;
  const totalSkipped = unitParsed.skipped + liveParsed.skipped;
  const totalTests = unitParsed.total + liveParsed.total;

  console.log('\n' + '-'.repeat(70));
  console.log('OVERALL:');
  console.log(`  Passed:  ${totalPassed}`);
  console.log(`  Failed:  ${totalFailed}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Total:   ${totalTests}`);
  console.log('-'.repeat(70));

  const overallSuccess = unitResult.code === 0 && liveResult.code === 0;

  if (overallSuccess) {
    console.log('\n  ALL TESTS PASSED\n');
  } else {
    console.log('\n  SOME TESTS FAILED\n');
    if (unitResult.code !== 0) console.log('  - Unit tests failed');
    if (liveResult.code !== 0) console.log('  - Live tests failed');
  }

  console.log('='.repeat(70) + '\n');

  process.exitCode = overallSuccess ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
