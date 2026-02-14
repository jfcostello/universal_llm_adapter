import type {
  AdapterLogger,
  EmbeddingPriorityItem,
  JsonObject,
  PluginRegistry,
  VectorContextConfig,
  VectorQueryCandidate,
  VectorQueryResult
} from '../../../../../kernel/index.js';
import type { EmbeddingManager } from '../../../../embeddings/index.js';
import type { VectorStoreManager } from '../../vector-store-manager.js';

export interface QueryPriorityResolvedCandidate {
  stores: string[];
  collection: string;
  embeddingPriority: EmbeddingPriorityItem[];
  topK: number;
  scoreThreshold?: number;
  filter?: JsonObject;
}

export interface QueryPriorityExecutionResult {
  completed: boolean;
  results: VectorQueryResult[];
  storeId?: string;
  candidateIndex?: number;
  effectiveCandidate?: QueryPriorityResolvedCandidate;
}

export type ResolveQueryPriorityCandidate = (
  candidate: VectorQueryCandidate,
  candidateIndex: number,
  contextConfig: VectorContextConfig
) => QueryPriorityResolvedCandidate;

export interface ExecuteQueryPriorityOptions {
  query: string;
  contextConfig: VectorContextConfig;
  registry: PluginRegistry;
  embeddingManager: EmbeddingManager;
  vectorManager: VectorStoreManager;
  logger: AdapterLogger;
  contextIndex?: number;
  embeddingCache?: Map<string, number[]>;
  abortSignal?: AbortSignal;
  queryTimeoutMs?: number;
  resolveCandidate?: ResolveQueryPriorityCandidate;
}

export interface ExecuteQueryPriorityInternalOptions {
  query: string;
  contextConfig: VectorContextConfig;
  candidates: VectorQueryCandidate[];
  registry: PluginRegistry;
  embeddingManager: EmbeddingManager;
  vectorManager: VectorStoreManager;
  logger: AdapterLogger;
  contextIndex?: number;
  embeddingCache?: Map<string, number[]>;
  abortSignal?: AbortSignal;
  queryTimeoutMs?: number;
  resolveCandidate: ResolveQueryPriorityCandidate;
}
