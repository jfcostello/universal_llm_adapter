import { describe, expect, jest, test } from '@jest/globals';

const unstableMockModule = (jest as unknown as { unstable_mockModule?: typeof jest.unstable_mockModule }).unstable_mockModule;
if (!unstableMockModule) {
  throw new Error('jest.unstable_mockModule is required for this test suite');
}

function makeSpan(envelopeId?: string) {
  return {
    traceIdHex: '0123456789abcdef0123456789abcdef',
    spanIdHex: '0123456789abcdef',
    name: 'llm.generation',
    startTimeIso: '2024-01-01T00:00:00.000Z',
    endTimeIso: '2024-01-01T00:00:01.000Z',
    attributes: {
      'langfuse.observation.model.name': 'model-a',
      'langfuse.observation.input': '{"messages":["hi"]}',
      'langfuse.observation.output': '{"content":["ok"]}'
    },
    ...(envelopeId ? { envelopeId } : {})
  };
}

describe('modules/observability OTLP encode worker', () => {
  test('installOtlpEncodeWorkerMessageHandler encodes spans and transfers bodies', async () => {
    const { installOtlpEncodeWorkerMessageHandler } = await import('@/modules/observability/internal/otlp/encode-worker.ts');

    let handler: ((msg: unknown) => void) | null = null;
    const postMessage = jest.fn();
    const port = {
      on: (_event: 'message', fn: (msg: unknown) => void) => {
        handler = fn;
      },
      postMessage
    };

    installOtlpEncodeWorkerMessageHandler(port as any);
    expect(handler).toBeInstanceOf(Function);

    handler?.({ id: 1, spans: [makeSpan('env-1')], maxBatchBytes: 1024 * 1024 });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [msg, transferList] = postMessage.mock.calls[0];
    expect(msg).toMatchObject({ id: 1, ok: true });
    expect((msg as any).chunks[0].envelopeIds).toEqual(['env-1']);
    expect((msg as any).chunks[0].body).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(transferList)).toBe(true);
    expect(transferList.length).toBe(1);
  });

  test('worker handler responds with ok:false when postMessage throws', async () => {
    const { installOtlpEncodeWorkerMessageHandler } = await import('@/modules/observability/internal/otlp/encode-worker.ts');

    let handler: ((msg: unknown) => void) | null = null;
    let calls = 0;
    const postMessage = jest.fn((_msg: any) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('postMessage failed');
      }
    });

    const port = {
      on: (_event: 'message', fn: (msg: unknown) => void) => {
        handler = fn;
      },
      postMessage
    };

    installOtlpEncodeWorkerMessageHandler(port as any);

    handler?.({ spans: null, maxBatchBytes: 0 });

    expect(postMessage).toHaveBeenCalledTimes(2);
    const second = postMessage.mock.calls[1][0];
    expect(second).toMatchObject({ ok: false });
  });

  test('worker handler stringifies non-Error thrown values', async () => {
    const { installOtlpEncodeWorkerMessageHandler } = await import('@/modules/observability/internal/otlp/encode-worker.ts');

    let handler: ((msg: unknown) => void) | null = null;
    let calls = 0;
    const postMessage = jest.fn((_msg: any) => {
      calls += 1;
      if (calls === 1) {
        throw 'boom-string';
      }
    });

    const port = {
      on: (_event: 'message', fn: (msg: unknown) => void) => {
        handler = fn;
      },
      postMessage
    };

    installOtlpEncodeWorkerMessageHandler(port as any);

    handler?.({ spans: null, maxBatchBytes: 0 });

    expect(postMessage).toHaveBeenCalledTimes(2);
    const second = postMessage.mock.calls[1][0];
    expect(second).toMatchObject({ ok: false, error: 'boom-string' });
  });

  test('auto-installs handler when parentPort is present', async () => {
    jest.resetModules();

    const on = jest.fn();
    const postMessage = jest.fn();
    unstableMockModule('node:worker_threads', () => ({ parentPort: { on, postMessage } }));

    await import('@/modules/observability/internal/otlp/encode-worker.ts');
    expect(on).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
