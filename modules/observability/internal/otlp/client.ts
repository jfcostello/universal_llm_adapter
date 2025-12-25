import type { ObservabilityEnvelopeOutcome } from '../../../kernel/index.js';
import type { OtlpSpanSpec } from './types.js';
import { sleep } from '../../../shared/index.js';
import { chunkAndEncodeOtlpTraceSpans, type EncodedOtlpChunk } from './chunk-and-encode.js';

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function parseRetryAfterMs(headerValue: unknown): number | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // Retry-After: <seconds>
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  // Retry-After: <http-date>
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  const deltaMs = dateMs - Date.now();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  return Math.floor(deltaMs);
}

function shouldUseOtlpEncodeWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  const isDist = new URL(import.meta.url).pathname.endsWith('.js');
  const flag = String(env.LLM_ADAPTER_OBSERVABILITY_OTLP_WORKER || '').trim();
  if (flag === '1') return true;
  if (flag === '0') return false;

  // Jest can use fake timers; avoid workers by default in unit tests to prevent hangs.
  if (typeof env.JEST_WORKER_ID === 'string' && env.JEST_WORKER_ID.trim() !== '') {
    return false;
  }

  // Default to enabled only for compiled JS bundles (dist); TS runtimes (tsx/jest/ts-node) fall back to sync.
  return isDist;
}

type OtlpEncodeWorkerResponse =
  | { id: number; ok: true; chunks: EncodedOtlpChunk[] }
  | { id: number; ok: false; error: string };

type OtlpEncodeWorkerPending = {
  resolve: (chunks: EncodedOtlpChunk[]) => void;
  reject: (error: unknown) => void;
};

type OtlpEncodeWorkerState = {
  worker: any;
  ready: Promise<void>;
  nextId: number;
  pendingById: Map<number, OtlpEncodeWorkerPending>;
};

let encodeWorkerState: OtlpEncodeWorkerState | null = null;
let encodeWorkerDisabled = false;

async function getEncodeWorkerState(): Promise<OtlpEncodeWorkerState> {
  if (encodeWorkerDisabled) {
    throw new Error('OTLP encode worker disabled');
  }

  if (encodeWorkerState) {
    await encodeWorkerState.ready;
    return encodeWorkerState;
  }

  const { Worker } = await import('node:worker_threads');

  const worker = new Worker(new URL('./encode-worker.js', import.meta.url));
  (worker as any)?.unref?.();

  const state: OtlpEncodeWorkerState = {
    worker,
    ready: Promise.resolve(),
    nextId: 1,
    pendingById: new Map()
  };

  const failAll = (error: unknown) => {
    encodeWorkerDisabled = true;
    encodeWorkerState = null;
    for (const pending of state.pendingById.values()) {
      pending.reject(error);
    }
    state.pendingById.clear();
    try {
      (worker as any)?.terminate?.();
    } catch {
      // ignore
    }
  };

  state.ready = new Promise<void>((resolve, reject) => {
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`OTLP encode worker exited (code ${code})`));
    };
    const cleanup = () => {
      (worker as any)?.off?.('online', onOnline);
      (worker as any)?.off?.('error', onError);
      (worker as any)?.off?.('exit', onExit);
    };

    (worker as any)?.once?.('online', onOnline);
    (worker as any)?.once?.('error', onError);
    (worker as any)?.once?.('exit', onExit);
  });

  (worker as any)?.on?.('message', (message: unknown) => {
    const id = typeof (message as any)?.id === 'number' ? (message as any).id : null;
    if (id === null) return;
    const pending = state.pendingById.get(id);
    if (!pending) return;
    state.pendingById.delete(id);

    const ok = (message as any)?.ok === true;
    if (!ok) {
      pending.reject(new Error(String((message as any)?.error || 'encode worker error')));
      return;
    }

    const chunks = Array.isArray((message as any)?.chunks) ? ((message as any).chunks as EncodedOtlpChunk[]) : [];
    pending.resolve(chunks);
  });

  (worker as any)?.on?.('error', (err: unknown) => failAll(err));
  (worker as any)?.on?.('exit', (code: number) => failAll(new Error(`OTLP encode worker exited (code ${code})`)));

  encodeWorkerState = state;
  await state.ready;
  return state;
}

async function chunkAndEncodeWithWorker(
  spans: OtlpSpanSpec[],
  maxBatchBytes: number
): Promise<EncodedOtlpChunk[]> {
  const state = await getEncodeWorkerState();
  const id = state.nextId++;

  return await new Promise<EncodedOtlpChunk[]>((resolve, reject) => {
    state.pendingById.set(id, { resolve, reject });
    try {
      state.worker.postMessage({ id, spans, maxBatchBytes });
    } catch (error) {
      state.pendingById.delete(id);
      reject(error);
    }
  });
}

async function chunkAndEncode(
  spans: OtlpSpanSpec[],
  maxBatchBytes: number
): Promise<EncodedOtlpChunk[]> {
  if (!shouldUseOtlpEncodeWorker()) {
    return chunkAndEncodeOtlpTraceSpans(spans, maxBatchBytes);
  }

  try {
    return await chunkAndEncodeWithWorker(spans, maxBatchBytes);
  } catch {
    // Best-effort fallback to sync encoding; observability must never take down the caller.
    encodeWorkerDisabled = true;
    encodeWorkerState = null;
    return chunkAndEncodeOtlpTraceSpans(spans, maxBatchBytes);
  }
}

export async function sendOtlpTraceSpans(options: {
  spans: OtlpSpanSpec[];
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBatchBytes?: number;
}): Promise<{ success: boolean; outcomes: ObservabilityEnvelopeOutcome[] }> {
  const spans = Array.isArray(options.spans) ? options.spans : [];
  const url = String(options.url);
  const headers = { ...(options.headers ?? {}) };
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : undefined;

  // Conservative default to avoid oversized protobuf exports.
  const maxBatchBytes = typeof options.maxBatchBytes === 'number' && options.maxBatchBytes > 0
    ? Math.floor(options.maxBatchBytes)
    : 3_670_016; // ~3.5 MiB

  if (spans.length === 0) {
    return { success: true, outcomes: [] };
  }

  const chunks = await chunkAndEncode(spans, maxBatchBytes);

  const outcomes: ObservabilityEnvelopeOutcome[] = [];
  let overallSuccess = true;

  for (const chunk of chunks) {
    const envelopeIds = chunk.envelopeIds;

    if (chunk.oversize) {
      overallSuccess = false;
      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          error: `OTLP payload exceeds maxBatchBytes (${maxBatchBytes})`,
          retryable: false
        });
      }
      continue;
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: chunk.body,
        signal: controller.signal
      });

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      if (res.ok) {
        for (const envelopeId of envelopeIds) {
          outcomes.push({ envelopeId, success: true, status: res.status });
        }
        continue;
      }

      overallSuccess = false;
      const retryable = isRetryableStatus(res.status);
      const statusText = typeof (res as any).statusText === 'string' ? String((res as any).statusText) : '';
      const errorText = statusText ? `HTTP ${res.status}: ${statusText}` : `HTTP ${res.status}`;

      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          status: res.status,
          error: errorText,
          retryable
        });
      }

      if (res.status === 429) {
        const retryAfterHeader = (res as any)?.headers?.get?.('retry-after');
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
        if (retryAfterMs && retryAfterMs > 0) {
          await sleep(retryAfterMs);
        }
      }
    } catch (error: any) {
      overallSuccess = false;
      const message = (error as Error)?.message ?? String(error);
      for (const envelopeId of envelopeIds) {
        outcomes.push({
          envelopeId,
          success: false,
          error: message,
          retryable: true
        });
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  return {
    success: overallSuccess && outcomes.every(o => o.success),
    outcomes
  };
}
