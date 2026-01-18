export type CliError = Error & { statusCode?: number; code?: string };

export function makeCliError(options: { message: string; statusCode: number; code: string }): CliError {
  return Object.assign(new Error(options.message), {
    statusCode: options.statusCode,
    code: options.code,
  });
}
