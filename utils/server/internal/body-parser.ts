import type http from 'http';

export interface ReadJsonBodyOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export async function readJsonBody(
  req: http.IncomingMessage,
  options: ReadJsonBodyOptions = {}
): Promise<any> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const timeoutMs = options.timeoutMs ?? 0;

  let input = '';
  let bytes = 0;
  let timeout: NodeJS.Timeout | undefined;

  const readPromise = (async () => {
    req.setEncoding('utf-8');
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        const error = new Error('Request body too large');
        (error as any).statusCode = 413;
        (error as any).code = 'payload_too_large';
        throw error;
      }
      input += chunk;
    }
    return input;
  })();

  try {
    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Request body read timed out');
          (error as any).statusCode = 408;
          (error as any).code = 'body_read_timeout';
          reject(error);
        }, timeoutMs);
      });

      input = await Promise.race([readPromise, timeoutPromise]);
    } else {
      input = await readPromise;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!input) return {};

  try {
    return JSON.parse(input);
  } catch {
    const error = new Error('Invalid JSON body');
    (error as any).statusCode = 400;
    (error as any).code = 'invalid_json';
    throw error;
  }
}
