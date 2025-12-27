import fs from 'fs';

function parseJsonOrThrow(raw: string, context: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(`Invalid JSON ${context}`);
    (error as any).statusCode = 400;
    (error as any).code = 'invalid_json';
    throw error;
  }
}

export async function loadSpec<T = any>(
  options: any,
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<T> {
  let specData: any;

  if (options?.file) {
    const content = fs.readFileSync(options.file, 'utf-8');
    specData = parseJsonOrThrow(content, `in file '${options.file}'`);
  } else if (options?.spec) {
    specData = parseJsonOrThrow(options.spec, 'in --spec');
  } else {
    let input = '';
    stdin.setEncoding('utf-8');
    for await (const chunk of stdin) {
      input += chunk;
    }
    specData = parseJsonOrThrow(input, 'from stdin');
  }

  return specData as T;
}
