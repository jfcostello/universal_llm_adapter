import { parentPort } from 'node:worker_threads';
import type { OtlpSpanSpec } from './types.js';
import { chunkAndEncodeOtlpTraceSpans, type EncodedOtlpChunk } from './chunk-and-encode.js';

export type OtlpEncodeWorkerRequest = {
  id: number;
  spans: OtlpSpanSpec[];
  maxBatchBytes: number;
};

export type OtlpEncodeWorkerResponse =
  | { id: number; ok: true; chunks: EncodedOtlpChunk[] }
  | { id: number; ok: false; error: string };

export function installOtlpEncodeWorkerMessageHandler(port: {
  on: (event: 'message', handler: (message: unknown) => void) => void;
  postMessage: (message: unknown, transferList?: Array<ArrayBufferLike>) => void;
}): void {
  port.on('message', (message: unknown) => {
    const id = typeof (message as any)?.id === 'number' ? (message as any).id : -1;
    try {
      const spans = Array.isArray((message as any)?.spans) ? ((message as any).spans as OtlpSpanSpec[]) : [];
      const maxBatchBytes =
        typeof (message as any)?.maxBatchBytes === 'number' && Number.isFinite((message as any).maxBatchBytes) && (message as any).maxBatchBytes > 0
          ? Math.floor((message as any).maxBatchBytes)
          : 1;

      const chunks = chunkAndEncodeOtlpTraceSpans(spans, maxBatchBytes);
      const transferList: Array<ArrayBufferLike> = chunks.map(chunk => chunk.body.buffer);

      const response: OtlpEncodeWorkerResponse = { id, ok: true, chunks };
      port.postMessage(response, transferList);
    } catch (error: any) {
      const response: OtlpEncodeWorkerResponse = {
        id,
        ok: false,
        error: (error as Error)?.message ?? String(error)
      };
      port.postMessage(response);
    }
  });
}

if (parentPort) {
  installOtlpEncodeWorkerMessageHandler(parentPort as any);
}
