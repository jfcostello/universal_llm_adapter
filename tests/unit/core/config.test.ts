import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { substituteEnv, loadJsonFile } from '@/core/config.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';
import { withTempCwd, writeJson } from '@tests/helpers/temp-files.ts';

describe('core/config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('replaces environment variables in strings and nested structures', async () => {
    process.env.TEST_VALUE = 'hello';
    process.env.OPTIONAL_VALUE = 'optional';
    process.env.EMPTY_VALUE = '';

    const input = {
      text: '${TEST_VALUE}',
      optional: '${OPTIONAL_VALUE?}',
      missingOptional: '${MISSING_OPTIONAL?}',
      empty: '${EMPTY_VALUE}',
      nested: ['${TEST_VALUE}', { inner: '${TEST_VALUE}' }]
    };

    const result = substituteEnv(input);
    expect(result.text).toBe('hello');
    expect(result.optional).toBe('optional');
    expect(result.missingOptional).toBe('');
    expect(result.empty).toBe('');
    expect(result.nested).toEqual(['hello', { inner: 'hello' }]);
  });

  test('throws when required variable absent', () => {
    delete process.env.REQUIRED_VALUE;
    expect(() => substituteEnv('${REQUIRED_VALUE}')).toThrow(
      "Environment variable 'REQUIRED_VALUE' required but not set"
    );
  });

  test('loadJsonFile applies substitution recursively', async () => {
    await withTempCwd('config-json', async (dir) => {
      const filePath = path.join(dir, 'config.json');
      process.env.FILE_VALUE = 'from-file';
      writeJson(filePath, {
        key: '${FILE_VALUE}',
        nested: {
          items: ['${FILE_VALUE}']
        }
      });

      const loaded = loadJsonFile(filePath);
      expect(loaded).toEqual({ key: 'from-file', nested: { items: ['from-file'] } });
    });
  });

  test('loadRootDotenv loads nearest .env file', async () => {
    const envPath = path.join(ROOT_DIR, 'modules', 'kernel', 'internal', '.env');

    fs.writeFileSync(envPath, 'TEST_ENV_FROM_FILE=loaded', 'utf-8');
    delete process.env.TEST_ENV_FROM_FILE;
    jest.resetModules();

    try {
      const configModule = await import('@/core/config.ts');
      expect(configModule.substituteEnv('${TEST_ENV_FROM_FILE}')).toBe('loaded');
    } finally {
      if (fs.existsSync(envPath)) {
        fs.unlinkSync(envPath);
      }
      jest.resetModules();
    }
  });

  test('loadRootDotenv marks environment loaded when no dotenv present', async () => {
    jest.resetModules();
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const configModule = await import('@/core/config.ts');
    expect(configModule.substituteEnv('plain')).toBe('plain');
    expect(existsSpy).toHaveBeenCalled();
    existsSpy.mockRestore();
    jest.resetModules();
  });
});
