export type CliError = Error & { statusCode?: number; code?: string };

export function makeCliError(options: { message: string; statusCode: number; code: string }): CliError {
  const err: any = new Error(options.message);
  err.statusCode = options.statusCode;
  err.code = options.code;
  return err;
}

