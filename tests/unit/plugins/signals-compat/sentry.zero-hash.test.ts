import { jest, describe, it, expect } from '@jest/globals';

describe('SentrySignalsCompat deriveSentryEventIdHex (coverage)', () => {
  const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
  if (!unstableMockModule) {
    throw new Error('jest.unstable_mockModule is required for this test suite');
  }

  it('patches all-zero sha256 output to avoid an all-zero event_id', async () => {
    await jest.isolateModulesAsync(async () => {
      unstableMockModule('crypto', () => {
        const digest = new Uint8Array(32); // all zeros
        const hash: any = {
          update: () => hash,
          digest: () => digest
        };
        const createHash = () => hash;
        return { __esModule: true, createHash, default: { createHash } };
      });

      const { SentrySignalsCompat } = await import('@/plugins/signals-compat/sentry/internal/sentry.ts');

      const compat = new SentrySignalsCompat();
      const batch = compat.buildBatch(
        [
          {
            traceId: 'trace-1',
            generationId: 'gen-1',
            timestampMs: 1704067200000,
            level: 'error',
            message: 'boom',
            metadata: {}
          }
        ],
        {
          id: 'sentry',
          compat: 'sentry',
          endpoint: { urlTemplate: 'https://publickey@o0.ingest.sentry.io/123', method: 'POST', headers: {} }
        } as any,
        { eventIds: ['event-1'] } as any
      );

      const payload = batch.payload as any;
      const body = String(payload.envelopes[0].body);
      const header = JSON.parse(body.split('\n').filter(Boolean)[0]);
      expect(String(header.event_id)).toMatch(/^[0-9a-f]{32}$/);
      expect(String(header.event_id)).not.toBe('0'.repeat(32));
      // Our mock forces an all-zero digest slice, so the compat patches the final byte to 0x01.
      expect(String(header.event_id)).toMatch(/01$/);
    });
  });
});
