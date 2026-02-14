export function createConfigError(message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'config_error';
  return error;
}
