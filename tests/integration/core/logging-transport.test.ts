import { jest } from '@jest/globals';

// IMPORTANT: Set env vars BEFORE importing logging module
// The module evaluates disableConsoleLogs at import time
process.env.LLM_ADAPTER_DISABLE_FILE_LOGS = '1';
delete process.env.LLM_ADAPTER_DISABLE_CONSOLE_LOGS;

import { AdapterLogger, LogLevel } from '@/core/logging.ts';

/**
 * Integration test for FlushingConsoleTransport
 * This test covers lines 28-45 of logging.ts by:
 * 1. Creating a real AdapterLogger (not mocked)
 * 2. Waiting for async stdout/stderr writes to complete
 * 3. Verifying both stdout and stderr code paths
 */
describe('core/logging FlushingConsoleTransport integration', () => {

  test('FlushingConsoleTransport.log executes and writes to stdout/stderr', async () => {
    // Track write completions with promises
    const stdoutWrites: Array<{ resolve: () => void }> = [];
    const stderrWrites: Array<{ resolve: () => void }> = [];

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => {
      if (typeof callback === 'function') {
        // Capture the promise resolver
        let resolver: () => void;
        const promise = new Promise<void>(resolve => {
          resolver = resolve;
        });
        stdoutWrites.push({ resolve: resolver! });

        // Call callback asynchronously to match real behavior
        setImmediate(() => {
          callback();
          resolver!();
        });

        return promise as any;
      }
      return true;
    });

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any, callback?: any) => {
      if (typeof callback === 'function') {
        // Capture the promise resolver
        let resolver: () => void;
        const promise = new Promise<void>(resolve => {
          resolver = resolve;
        });
        stderrWrites.push({ resolve: resolver! });

        // Call callback asynchronously to match real behavior
        setImmediate(() => {
          callback();
          resolver!();
        });

        return promise as any;
      }
      return true;
    });

    try {
      // Create real logger (this will create FlushingConsoleTransport)
      const logger = new AdapterLogger(LogLevel.DEBUG, 'test-transport');

      // Test info level - should go to stdout (tests line 36: useStderr check, stdout path)
      logger.info('test-info-message', { data: 'value' });

      // Wait for stdout write to complete - give time for setImmediate
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify stdout was called
      expect(stdoutSpy).toHaveBeenCalled();

      // Test error level - should go to stderr (tests line 35-36: useStderr check, stderr path)
      logger.error('test-error-message', { code: 500 });

      // Wait for stderr write
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify stderr was called
      expect(stderrSpy).toHaveBeenCalled();

      // Test warning - also goes to stderr
      logger.warning('test-warn-message');

      await new Promise(resolve => setTimeout(resolve, 150));

      // Cleanup without waiting for close (which might hang)
      // Just verify the transports were used
      expect(stdoutWrites.length).toBeGreaterThan(0);
      expect(stderrWrites.length).toBeGreaterThan(0);

    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('FlushingConsoleTransport handles null format output (lines 30-31)', async () => {
    // This tests the early return path when format.transform returns null
    // We need to directly test the transport with a null-returning format

    let callbackCalled = false;

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => {
      if (typeof callback === 'function') {
        setImmediate(callback);
      }
      return true;
    });

    try {
      // Create a logger and access its internal transport
      const logger = new AdapterLogger(LogLevel.DEBUG, 'test-null-format');

      // Get the logger's transports to access FlushingConsoleTransport
      const winstonLogger = (logger as any).logger;
      const transports = winstonLogger.transports;
      const consoleTransport = transports.find((t: any) => t.constructor.name === 'FlushingConsoleTransport');

      if (consoleTransport) {
        // Mock the format to return null
        const originalFormat = consoleTransport.format;
        consoleTransport.format = {
          transform: () => null,  // Return null to trigger lines 30-31
          options: {}
        };

        // Call log method directly with a callback
        const callback = () => {
          callbackCalled = true;
        };

        consoleTransport.log({ level: 'info', message: 'test' }, callback);

        // Wait for setImmediate
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify callback was called even though format returned null
        expect(callbackCalled).toBe(true);

        // Verify write was NOT called (because format returned null)
        expect(writeSpy).not.toHaveBeenCalled();

        // Restore original format
        consoleTransport.format = originalFormat;
      }

    } finally {
      writeSpy.mockRestore();
    }
  });

  test('FlushingConsoleTransport with custom stderrLevels (lines 21-23)', async () => {
    // This tests the LEFT branch where options.stderrLevels IS provided
    // We need to access the FlushingConsoleTransport class directly

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => {
      if (typeof callback === 'function') {
        setImmediate(callback);
      }
      return true;
    });

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any, callback?: any) => {
      if (typeof callback === 'function') {
        setImmediate(callback);
      }
      return true;
    });

    try {
      // First, create logger to access FlushingConsoleTransport class
      const logger = new AdapterLogger(LogLevel.DEBUG, 'test-get-class');
      const winstonLogger = (logger as any).logger;
      const transports = winstonLogger.transports;
      const consoleTransport = transports.find((t: any) => t.constructor.name === 'FlushingConsoleTransport');

      expect(consoleTransport).toBeDefined();
      const TransportClass = consoleTransport.constructor;

      // Now create an instance with CUSTOM stderrLevels to test left branch of line 23
      const customTransport = new TransportClass({
        stderrLevels: ['debug', 'info']  // Custom levels - tests LEFT branch
      });

      expect(customTransport.stderrLevels).toBeDefined();
      expect(customTransport.stderrLevels.has('debug')).toBe(true);
      expect(customTransport.stderrLevels.has('info')).toBe(true);
      expect(customTransport.stderrLevels.has('error')).toBe(false);  // Not in custom set

      // Verify the default case still works (right branch of line 23)
      const defaultTransport = new TransportClass({});
      expect(defaultTransport.stderrLevels.has('error')).toBe(true);
      expect(defaultTransport.stderrLevels.has('warn')).toBe(true);

      // Test constructor with NO arguments (tests line 21 default parameter = {})
      const noArgsTransport = new TransportClass();
      expect(noArgsTransport.stderrLevels.has('error')).toBe(true);
      expect(noArgsTransport.stderrLevels.has('warn')).toBe(true);

      // Don't close - causes hang with mocked streams

    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('FlushingConsoleTransport Symbol.for(message) path and JSON.stringify fallback (line 34)', async () => {
    // Tests BOTH branches of line 34:
    // LEFT: Symbol.for('message') exists (normal Winston case)
    // RIGHT: JSON.stringify fallback when Symbol is missing

    let capturedWrites: string[] = [];
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any, callback?: any) => {
      capturedWrites.push(chunk.toString());
      if (typeof callback === 'function') {
        setImmediate(callback);
      }
      return true;
    });

    try {
      const logger = new AdapterLogger(LogLevel.DEBUG, 'test-symbol-path');
      const winstonLogger = (logger as any).logger;
      const transports = winstonLogger.transports;
      const consoleTransport = transports.find((t: any) => t.constructor.name === 'FlushingConsoleTransport');

      // Test LEFT branch: Symbol.for('message') exists (normal operation)
      logger.info('test-with-symbol');
      await new Promise(resolve => setTimeout(resolve, 150));

      // The winston format should have added Symbol.for('message')
      expect(capturedWrites.length).toBeGreaterThan(0);
      const firstWrite = capturedWrites[0];
      // Should be formatted JSON with the winston format
      expect(firstWrite).toContain('test-with-symbol');

      capturedWrites = [];

      // Test RIGHT branch: JSON.stringify when Symbol.for('message') is missing
      // We need to call transport.log directly with an object lacking the symbol
      if (consoleTransport) {
        const outputWithoutSymbol = {
          level: 'info',
          message: 'test-without-symbol',
          timestamp: '2025-10-19T00:00:00.000Z'
        };

        // Mock format to return object without Symbol.for('message')
        const originalFormat = consoleTransport.format;
        consoleTransport.format = {
          transform: () => outputWithoutSymbol,  // Returns object without Symbol
          options: {}
        };

        let callbackInvoked = false;
        consoleTransport.log({ level: 'info', message: 'trigger' }, () => {
          callbackInvoked = true;
        });

        await new Promise(resolve => setTimeout(resolve, 150));

        // Should have used JSON.stringify since Symbol.for('message') wasn't present
        expect(callbackInvoked).toBe(true);
        expect(capturedWrites.length).toBeGreaterThan(0);
        const jsonWrite = capturedWrites[capturedWrites.length - 1];
        // JSON.stringify should produce valid JSON
        const parsed = JSON.parse(jsonWrite.trim());
        expect(parsed.message).toBe('test-without-symbol');

        // Restore
        consoleTransport.format = originalFormat;
      }

      // Don't close - causes hang with mocked streams

    } finally {
      writeSpy.mockRestore();
    }
  });
});
