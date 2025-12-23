import { jest } from '@jest/globals';
import type { LLMCallSpec, ObservabilitySpec } from '@/modules/kernel/index.ts';
import { Role } from '@/modules/kernel/index.ts';

describe('observability-spec-types', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe('ObservabilitySpec', () => {
    test('exports ObservabilitySpec type from kernel', async () => {
      const kernel = await import('@/modules/kernel/index.ts');

      // Type is exported - we can't test it directly but can verify it doesn't break imports
      expect(kernel).toBeDefined();
    });

    test('LLMCallSpec accepts observability field', () => {
      // Create a minimal LLMCallSpec with observability
      const spec: LLMCallSpec = {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
        llmPriority: [{ provider: 'test', model: 'test' }],
        settings: {},
        observability: {
          enabled: true,
          provider: 'langfuse',
          traceId: 'trace-123',
          sessionId: 'session-456'
        }
      };

      expect(spec.observability).toBeDefined();
      expect(spec.observability?.enabled).toBe(true);
      expect(spec.observability?.provider).toBe('langfuse');
      expect(spec.observability?.traceId).toBe('trace-123');
      expect(spec.observability?.sessionId).toBe('session-456');
    });

    test('LLMCallSpec works without observability field (optional)', () => {
      // Create a minimal LLMCallSpec without observability
      const spec: LLMCallSpec = {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
        llmPriority: [{ provider: 'test', model: 'test' }],
        settings: {}
      };

      expect(spec.observability).toBeUndefined();
    });

    test('ObservabilitySpec accepts all optional queue knobs', () => {

      const observability: ObservabilitySpec = {
        enabled: true,
        provider: 'langfuse',
        traceId: 'custom-trace',
        sessionId: 'custom-session',
        providerConfig: { customKey: 'customValue' },
        flushAt: 5,
        flushIntervalMs: 2000,
        maxQueueSize: 500,
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 10000,
        timeoutMs: 5000
      };

      const spec: LLMCallSpec = {
        messages: [{ role: Role.USER, content: [{ type: 'text', text: 'test' }] }],
        llmPriority: [{ provider: 'test', model: 'test' }],
        settings: {},
        observability
      };

      expect(spec.observability?.flushAt).toBe(5);
      expect(spec.observability?.flushIntervalMs).toBe(2000);
      expect(spec.observability?.maxQueueSize).toBe(500);
      expect(spec.observability?.maxAttempts).toBe(5);
      expect(spec.observability?.baseDelayMs).toBe(100);
      expect(spec.observability?.maxDelayMs).toBe(10000);
      expect(spec.observability?.timeoutMs).toBe(5000);
      expect(spec.observability?.providerConfig).toEqual({ customKey: 'customValue' });
    });
  });

  describe('ObservabilityDefaults', () => {
    test('getDefaults returns observability defaults with disabled by default', async () => {
      const { getDefaults } = await import('@/modules/kernel/index.ts');
      const defaults = getDefaults();

      expect(defaults.observability).toBeDefined();
      expect(defaults.observability.enabled).toBe(false);
    });

    test('observability defaults fallback works when JSON missing', async () => {
      jest.resetModules();

      const originalFs = await import('fs');

      // Mock fs.existsSync to return false for defaults.json
      const fsMock: any = {
        __esModule: true,
        existsSync: jest.fn((path: string) => {
          if (path.includes('defaults.json')) {
            return false;
          }
          return originalFs.existsSync(path);
        }),
        readFileSync: originalFs.readFileSync
      };
      fsMock.default = fsMock;

      (jest as any).unstable_mockModule('fs', () => fsMock);

      const { getDefaults } = await import('@/modules/kernel/index.ts');
      const defaults = getDefaults();

      // Fallback should have observability disabled
      expect(defaults.observability).toBeDefined();
      expect(defaults.observability.enabled).toBe(false);
      expect(defaults.observability.flushAt).toBe(10);
      expect(defaults.observability.flushIntervalMs).toBe(5000);
      expect(defaults.observability.maxQueueSize).toBe(1000);
      expect(defaults.observability.maxAttempts).toBe(3);
      expect(defaults.observability.baseDelayMs).toBe(250);
      expect(defaults.observability.maxDelayMs).toBe(30000);
      expect(defaults.observability.timeoutMs).toBe(10000);

      jest.resetModules();
    });
  });
});
