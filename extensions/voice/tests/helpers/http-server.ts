export function trackServerSockets(server: any): Set<any> {
  const sockets = new Set<any>();
  server.on('connection', (socket: any) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (typeof socket?.unref === 'function') {
      try { socket.unref(); } catch {}
    }
  });
  return sockets;
}

export function unrefServer(server: any): void {
  if (typeof server?.unref === 'function') {
    try { server.unref(); } catch {}
  }
}

export async function closeServerAndSockets(server: any, sockets: Set<any>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err: any) => (err ? reject(err) : resolve()));
    try { server.closeIdleConnections?.(); } catch {}
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch {}
    }
    for (const socket of sockets) {
      try { socket.destroy(); } catch {}
    }
  });

  for (let i = 0; i < 25 && sockets.size > 0; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

