import { PassThrough, Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { loadSpec, writeJsonToStdout } from '@/utils/cli/index.ts';
import { ROOT_DIR } from '@tests/helpers/paths.ts';

describe('utils/cli loadSpec', () => {
  test('loads spec from file when options.file provided', async () => {
    const tempFile = path.join(ROOT_DIR, 'tests', 'fixtures', 'temp-cli-spec.json');
    fs.writeFileSync(tempFile, JSON.stringify({ via: 'file' }));
    try {
      const spec = await loadSpec<{ via: string }>({ file: tempFile });
      expect(spec).toEqual({ via: 'file' });
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  test('parses inline JSON when options.spec provided', async () => {
    const spec = await loadSpec<{ inline: boolean }>({ spec: '{"inline":true}' });
    expect(spec).toEqual({ inline: true });
  });

  test('falls back to stdin when file/spec missing', async () => {
    const stdin = Readable.from(['{"path":"stdin"}']);
    const spec = await loadSpec<{ path: string }>({}, stdin);
    expect(spec).toEqual({ path: 'stdin' });
  });

  test('handles undefined options by reading stdin', async () => {
    const stdin = Readable.from(['{"undef":true}']);
    const spec = await loadSpec<{ undef: boolean }>(undefined as any, stdin);
    expect(spec).toEqual({ undef: true });
  });

  test('file takes precedence over inline spec when both provided', async () => {
    const tempFile = path.join(ROOT_DIR, 'tests', 'fixtures', 'temp-cli-spec-precedence.json');
    fs.writeFileSync(tempFile, JSON.stringify({ via: 'file' }));
    try {
      const spec = await loadSpec<{ via: string }>({ file: tempFile, spec: '{"via":"spec"}' });
      expect(spec).toEqual({ via: 'file' });
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  test('throws on invalid inline JSON', async () => {
    await expect(loadSpec({ spec: '{bad json}' })).rejects.toThrow();
  });

  test('throws on invalid stdin JSON', async () => {
    const stdin = new PassThrough();
    const promise = loadSpec({}, stdin as unknown as NodeJS.ReadableStream);
    stdin.write('{bad json}');
    stdin.end();
    await expect(promise).rejects.toThrow();
  });
});

describe('utils/cli writeJsonToStdout', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('writes compact JSON with trailing newline when pretty=false', async () => {
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, cb?: any) => {
        if (cb) cb();
        return true;
      });

    await writeJsonToStdout({ ok: true }, { pretty: false });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [payload] = writeSpy.mock.calls[0];
    expect(String(payload)).toContain('{"ok":true}');
    expect(String(payload)).toMatch(/\n$/);
  });

  test('uses defaults when options omitted', async () => {
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, cb?: any) => {
        if (cb) cb();
        return true;
      });

    await writeJsonToStdout({ ok: true });

    expect(writeSpy).toHaveBeenCalled();
  });

  test('pretty prints JSON when pretty=true', async () => {
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, cb?: any) => {
        if (cb) cb();
        return true;
      });

    await writeJsonToStdout({ ok: true }, { pretty: true });

    const [payload] = writeSpy.mock.calls[0];
    expect(String(payload)).toContain('\n  ');
  });

  test('resolves via timeout if stdout callback never fires', async () => {
    jest.useFakeTimers();

    jest.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);

    const promise = writeJsonToStdout({ ok: true }, { pretty: false });
    jest.advanceTimersByTime(100);
    await promise;
  });

  test('supports custom stdout and timeoutMs options', async () => {
    const customWrite = jest.fn((chunk: any, cb?: any) => {
      if (cb) cb();
      return true;
    });
    const fakeStdout = { write: customWrite } as any;

    await writeJsonToStdout({ ok: true }, { pretty: false, stdout: fakeStdout, timeoutMs: 5 });

    expect(customWrite).toHaveBeenCalled();
  });
});
