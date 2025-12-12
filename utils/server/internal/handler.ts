import type http from 'http';
import { readJsonBody } from './body-parser.js';
import { writeSseEvent } from './sse.js';
import {
  runWithCoordinatorLifecycle,
  streamWithCoordinatorLifecycle
} from '../../coordinator-lifecycle/index.js';
import type { LLMCallSpec, LLMStreamEvent } from '../../../core/types.js';
import type { PluginRegistryLike } from '../../coordinator-lifecycle/index.js';
import type { ServerDependencies } from '../index.js';

interface HandlerOptions {
  registry: PluginRegistryLike;
  pluginsPath: string;
  batchId?: string;
  closeLoggerAfterRequest: boolean;
  deps: ServerDependencies;
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createServerHandler(options: HandlerOptions): http.RequestListener {
  const { registry, pluginsPath, batchId, closeLoggerAfterRequest, deps } = options;

  return async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method !== 'POST') {
      writeJson(res, 405, { type: 'error', error: { message: 'Method not allowed' } });
      return;
    }

    try {
      if (url === '/run') {
        const spec = (await readJsonBody(req)) as LLMCallSpec;

        const response = await runWithCoordinatorLifecycle<LLMCallSpec, any, any, any>({
          spec,
          pluginsPath,
          registry,
          batchId,
          closeLoggerAfter: closeLoggerAfterRequest,
          deps,
          run: (coordinator: any, s) => coordinator.run(s)
        });

        writeJson(res, 200, { type: 'response', data: response });
        return;
      }

      if (url === '/stream') {
        const spec = (await readJsonBody(req)) as LLMCallSpec;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        (res as any).flushHeaders?.();

        for await (const event of streamWithCoordinatorLifecycle<
          LLMCallSpec,
          any,
          any,
          LLMStreamEvent
        >({
          spec,
          pluginsPath,
          registry,
          batchId,
          closeLoggerAfter: closeLoggerAfterRequest,
          deps,
          stream: (coordinator: any, s) => coordinator.runStream(s)
        })) {
          writeSseEvent(res, event);
        }

        res.end();
        return;
      }

      writeJson(res, 404, { type: 'error', error: { message: 'Not found' } });
    } catch (error: any) {
      const status = Number(error?.statusCode) || 500;
      const message = error?.message ?? 'Server error';

      if (req.url === '/stream' && res.headersSent) {
        writeSseEvent(res, { type: 'error', error: { message } });
        res.end();
        return;
      }

      writeJson(res, status, { type: 'error', error: { message } });
    }
  };
}

