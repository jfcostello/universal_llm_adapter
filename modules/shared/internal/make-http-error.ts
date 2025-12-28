export function makeHttpError(options: { message: string; statusCode: number; code?: string }): Error {
  const error = new Error(String(options.message ?? ''));
  (error as any).statusCode = Number(options.statusCode);
  if (options.code !== undefined) {
    (error as any).code = String(options.code);
  }
  return error;
}
