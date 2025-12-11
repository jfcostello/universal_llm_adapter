export interface WriteJsonToStdoutOptions {
  pretty?: boolean;
  timeoutMs?: number;
  stdout?: NodeJS.WritableStream;
}

export async function writeJsonToStdout(
  value: unknown,
  options: WriteJsonToStdoutOptions = {}
): Promise<void> {
  const pretty = options.pretty === true;
  const timeoutMs = options.timeoutMs ?? 100;
  const stdout = options.stdout ?? process.stdout;

  const output = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);

  const writeComplete = new Promise<void>((resolve) => {
    (stdout as any).write(output + '\n', () => resolve());
  });

  await Promise.race([
    writeComplete,
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

