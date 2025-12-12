import type http from 'http';

export interface CorsConfig {
  enabled: boolean;
  allowedOrigins: string[] | '*';
  allowedHeaders: string[];
  allowCredentials: boolean;
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[] | '*'): string | undefined {
  if (!origin) return undefined;
  if (allowedOrigins === '*') return '*';
  return allowedOrigins.includes(origin) ? origin : undefined;
}

export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Partial<CorsConfig>
): boolean {
  if (!config?.enabled) return false;

  const origin = (req.headers?.origin as string | undefined) ?? undefined;
  const allowedOrigin = isOriginAllowed(origin, (config.allowedOrigins ?? []) as any);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', (config.allowedHeaders ?? []).join(', '));
  if (config.allowCredentials && allowedOrigin && allowedOrigin !== '*') {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

