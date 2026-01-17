import type http from 'http';

export interface TokenExtractConfig {
  allowBearer: boolean;
  allowHeader: boolean;
  headerName: string;
}

export function extractToken(req: http.IncomingMessage, config: TokenExtractConfig): string | null {
  const headers = (req as any)?.headers ?? {};
  if (headers && typeof headers !== 'object') return null;

  if (config.allowBearer) {
    const authHeader = (headers as any)['authorization'];
    if (typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) return match[1].trim();
    }
  }

  if (config.allowHeader) {
    const raw = (headers as any)[String(config.headerName).toLowerCase()];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

