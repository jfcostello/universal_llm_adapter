import fs from 'fs';
import path from 'path';

describe('dependency security floors', () => {
  test('locks undici to a patched release for GHSA-g9mf-h72j-4rw9', () => {
    const lockPath = path.resolve(process.cwd(), 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as any;
    const version = String(lock?.packages?.['node_modules/undici']?.version || '').trim();

    expect(version).not.toBe('');

    const [majorRaw, minorRaw, patchRaw] = version.split('.');
    const major = Number(majorRaw);
    const minor = Number(minorRaw);
    const patch = Number(String(patchRaw || '').replace(/\D.*$/, ''));

    const isPatched =
      major > 6 ||
      (major === 6 && (minor > 23 || (minor === 23 && patch >= 0)));

    expect(isPatched).toBe(true);
  });
});
