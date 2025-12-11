import fs from 'fs';

export async function loadSpec<T = any>(
  options: any,
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<T> {
  let specData: any;

  if (options?.file) {
    const content = fs.readFileSync(options.file, 'utf-8');
    specData = JSON.parse(content);
  } else if (options?.spec) {
    specData = JSON.parse(options.spec);
  } else {
    let input = '';
    stdin.setEncoding('utf-8');
    for await (const chunk of stdin) {
      input += chunk;
    }
    specData = JSON.parse(input);
  }

  return specData as T;
}

