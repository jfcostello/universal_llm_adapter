import { ROOT_DIR } from '@tests/helpers/paths.ts';
import { findGodFileViolations, formatGodFileViolations } from '@tests/helpers/god-files.ts';

describe('repo hygiene: no god files', () => {
  it('keeps non-exempt code files <= 400 lines', () => {
    const violations = findGodFileViolations({ rootDir: ROOT_DIR, maxLines: 400 });

    if (violations.length > 0) {
      throw new Error(
        [
          `FAIL: ${violations.length} non-exempt code file(s) exceed 400 lines`,
          '',
          formatGodFileViolations(violations),
          '',
          'Hint: run "wc -l <file>" and split into cohesive modules.'
        ].join('\n')
      );
    }

    expect(violations).toEqual([]);
    expect(formatGodFileViolations(violations)).toBe('');
  });
});
