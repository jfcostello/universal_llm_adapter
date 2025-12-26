import type { QdrantClient } from '@qdrant/js-client-rest';
import type { IVectorOperationLogger, VectorStoreConfig } from '../../../../../kernel/index.js';
import { VectorStoreConnectionError } from '../../../../../kernel/index.js';
import { createClientFromConnection, redactConnectionUrlForLogs, type QdrantClientFactory } from '../client/create-client.js';

export async function connectQdrant(options: {
  config: VectorStoreConfig;
  clientFactory: QdrantClientFactory;
  logger?: IVectorOperationLogger;
}): Promise<QdrantClient> {
  const config = options.config;
  const conn = config.connection;
  const startTime = Date.now();

  // Log connect request
  options.logger?.logVectorRequest({
    operation: 'connect',
    store: config.id,
    params: {
      url: redactConnectionUrlForLogs(conn),
      host: conn.host as string | undefined,
      port: conn.port as number | undefined,
      hasApiKey: !!conn.apiKey
    }
  });

  try {
    const client = createClientFromConnection({
      storeId: config.id,
      connection: conn,
      clientFactory: options.clientFactory
    });

    // Verify connection by listing collections
    await client.getCollections();

    // Log success
    options.logger?.logVectorResponse({
      operation: 'connect',
      store: config.id,
      result: 'success',
      duration: Date.now() - startTime
    });

    return client;
  } catch (error: any) {
    // Log failure
    options.logger?.logVectorResponse({
      operation: 'connect',
      store: config.id,
      result: { error: error.message },
      duration: Date.now() - startTime
    });

    if (error instanceof VectorStoreConnectionError) {
      throw error;
    }
    throw new VectorStoreConnectionError(config.id, error.message);
  }
}

