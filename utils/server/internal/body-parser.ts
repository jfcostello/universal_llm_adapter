import type http from 'http';

export async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  let input = '';
  req.setEncoding('utf-8');
  for await (const chunk of req) {
    input += chunk;
  }

  if (!input) return {};

  try {
    return JSON.parse(input);
  } catch {
    const error = new Error('Invalid JSON body');
    (error as any).statusCode = 400;
    throw error;
  }
}

