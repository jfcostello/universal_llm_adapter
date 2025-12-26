import { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorStoreConfig } from '../../../../../kernel/index.js';
import { VectorStoreConnectionError } from '../../../../../kernel/index.js';
import { redactUrlCredentials } from '../../../../../modules/security/index.js';

export type QdrantClientFactory = (options: {
  host?: string;
  port?: number;
  url?: string;
  apiKey?: string;
}) => QdrantClient;

export function createClientFromConnection(options: {
  storeId: string;
  connection: VectorStoreConfig['connection'];
  clientFactory: QdrantClientFactory;
}): QdrantClient {
  const conn = options.connection;

  if (conn.url) {
    return options.clientFactory({
      url: conn.url as string,
      apiKey: conn.apiKey as string | undefined
    });
  }

  if (conn.host) {
    return options.clientFactory({
      host: conn.host as string,
      port: (conn.port as number) || 6333
    });
  }

  throw new VectorStoreConnectionError(
    options.storeId,
    'Invalid connection config: must specify either "url" or "host"'
  );
}

export function redactConnectionUrlForLogs(connection: VectorStoreConfig['connection']): string | undefined {
  if (!connection.url) return undefined;
  return redactUrlCredentials(String(connection.url));
}

