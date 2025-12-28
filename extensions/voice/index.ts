import type http from 'http';

function parsePathname(rawUrl: string | undefined): string {
  const raw = rawUrl ?? '/';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return raw.split('?')[0];
  }
}

function writeJson(res: http.ServerResponse, status: number, payload: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export default {
  name: 'voice',
  registerServer: async (_ctx: {
    server: http.Server;
    registry: any;
    pluginsPath: string;
    upgradeRouter: any;
  }) => {
    return {
      handleHttp: async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const pathname = parsePathname(req.url);
        if (pathname === '/voice' || pathname.startsWith('/voice/')) {
          writeJson(res, 501, {
            type: 'error',
            error: { message: 'Voice extension not yet implemented', code: 'not_implemented' }
          });
          return true;
        }
        return false;
      }
    };
  }
};
