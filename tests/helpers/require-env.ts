export function requireEnv(options: {
  required: string[];
  env?: NodeJS.ProcessEnv;
  label?: string;
}): void {
  const env = options.env ?? process.env;
  const missing = options.required.filter(key => !env?.[key] || String(env[key]).trim() === '');
  if (missing.length === 0) return;

  const label = options.label ? ` (${options.label})` : '';
  throw new Error(`Missing required env var(s)${label}: ${missing.join(', ')}`);
}

