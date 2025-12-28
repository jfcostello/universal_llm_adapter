import type http from 'http';
import type net from 'net';

export interface UpgradeHandlerContext {
  req: http.IncomingMessage;
  socket: net.Socket;
  head: Buffer;
  pathname: string;
}

export type UpgradeHandler = (
  ctx: UpgradeHandlerContext
) => boolean | Promise<boolean>;

export interface UpgradeRouter {
  register: (handler: UpgradeHandler) => () => void;
  close: () => void;
}

function parseWsPath(req: http.IncomingMessage): string {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://localhost').pathname;
  } catch {
    return raw.split('?')[0];
  }
}

export function writeHttpUpgradeResponse(
  socket: net.Socket,
  statusCode: number,
  statusText: string,
  body: string
): void {
  const payload = String(body);
  const buf = Buffer.from(payload, 'utf-8');
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${buf.length}`,
      '',
      payload
    ].join('\r\n')
  );
}

export function attachUpgradeRouter(server: http.Server): UpgradeRouter {
  const handlers: UpgradeHandler[] = [];

  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    void (async () => {
      const pathname = parseWsPath(req);
      for (const handler of handlers) {
        try {
          const handled = await handler({ req, socket, head, pathname });
          if (handled) {
            return;
          }
        } catch {
          writeHttpUpgradeResponse(socket, 500, 'Internal Server Error', 'Internal Server Error');
          socket.destroy();
          return;
        }
      }

      writeHttpUpgradeResponse(socket, 404, 'Not Found', 'Not Found');
      socket.destroy();
    })();
  };

  server.on('upgrade', onUpgrade);

  return {
    register: (handler: UpgradeHandler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    close: () => {
      server.off('upgrade', onUpgrade);
      handlers.length = 0;
    }
  };
}
