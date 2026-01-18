import { Readable } from 'stream';

function normalizeSseLine(line: string): { field: string; value: string } | undefined {
  const idx = line.indexOf(':');
  if (idx === -1) return undefined;
  const field = line.slice(0, idx).trim();
  if (!field) return undefined;
  const value = line.slice(idx + 1).replace(/^\s/, '');
  return { field, value };
}

export async function streamSseJsonLines(options: {
  res: Response;
  onJson: (value: any) => Promise<void> | void;
}): Promise<void> {
  const body = options.res.body;
  if (!body) return;

  const stream = Readable.fromWeb(body as any);
  stream.setEncoding('utf-8');

  let buffer = '';
  let dataLines: string[] = [];

  const flush = async () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    const parsed = JSON.parse(raw);
    await options.onJson(parsed);
  };

  for await (const chunk of stream) {
    buffer += String(chunk).replace(/\r/g, '');

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = block.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        if (line.startsWith(':')) continue;
        const kv = normalizeSseLine(line);
        if (!kv) continue;
        if (kv.field === 'data') {
          dataLines.push(kv.value);
        }
      }
      await flush();
    }
  }

  // Flush trailing buffered event if stream ended without a final blank line.
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith(':')) continue;
      const kv = normalizeSseLine(line);
      if (!kv) continue;
      if (kv.field === 'data') {
        dataLines.push(kv.value);
      }
    }
    await flush();
  }
}
