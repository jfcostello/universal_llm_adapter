import { ROOT_DIR } from './paths.ts';
import { findGodFileViolations, formatGodFileViolations } from './god-files.ts';

const MAX_LINES = 400;

const violations = findGodFileViolations({ rootDir: ROOT_DIR, maxLines: MAX_LINES });
if (violations.length === 0) {
  process.stdout.write(`OK: no non-exempt code files over ${MAX_LINES} lines\n`);
  process.exitCode = 0;
} else {
  process.stderr.write(`FAIL: ${violations.length} non-exempt code file(s) exceed ${MAX_LINES} lines\n`);
  process.stderr.write(`${formatGodFileViolations(violations)}\n`);
  process.stderr.write(`\nHint: run "wc -l <file>" and split into cohesive modules.\n`);
  process.exitCode = 1;
}
