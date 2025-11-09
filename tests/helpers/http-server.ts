import http, { Server } from 'http';
import { AddressInfo } from 'net';

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface StubServer {
  url: string;
  close: () => Promise<void>;
}

export async function startStubServer(handler: RequestHandler): Promise<StubServer> {
  const server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}
