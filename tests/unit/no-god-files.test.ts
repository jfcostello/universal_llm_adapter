import { ROOT_DIR } from '@tests/helpers/paths.ts';
import { findGodFileViolations, formatGodFileViolations } from '@tests/helpers/god-files.ts';

describe('repo hygiene: no god files', () => {
  it('keeps non-exempt code files <= 400 lines', () => {
    const violations = findGodFileViolations({ rootDir: ROOT_DIR, maxLines: 400 });

    expect(violations).toEqual([]);
    expect(formatGodFileViolations(violations)).toBe('');
  });
});

