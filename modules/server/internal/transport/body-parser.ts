import type http from 'http';

export interface ReadJsonBodyOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

function makeError(message: string, statusCode: number, code: string) {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  (error as any).code = code;
  return error;
}

async function readBody(req: http.IncomingMessage, options: Required<ReadJsonBodyOptions>): Promise<Buffer> {
  const { maxBytes, timeoutMs } = options;

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const settle = (fn: () => void) => {
      cleanup();
      fn();
    };

    const fail = (error: any) => {
      settle(() => {
        try {
          req.pause();
        } catch {}
        reject(error);
      });
    };

    const onData = (chunk: any) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
      bytes += buf.length;
      if (bytes > maxBytes) {
        fail(makeError('Request body too large', 413, 'payload_too_large'));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      settle(() => {
        resolve(bytes === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, bytes));
      });
    };

    const onError = (err: any) => {
      fail(err);
    };

    const onAborted = () => {
      fail(makeError('Client disconnected', 499, 'client_aborted'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        fail(makeError('Request body read timed out', 408, 'body_read_timeout'));
      }, timeoutMs);
    }
  });
}

export async function readJsonBody(
  req: http.IncomingMessage,
  options: ReadJsonBodyOptions = {}
): Promise<any> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const timeoutMs = options.timeoutMs ?? 0;

  const buffer = await readBody(req, { maxBytes, timeoutMs });
  if (buffer.length === 0) return {};

  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch {
    throw makeError('Invalid JSON body', 400, 'invalid_json');
  }
}
