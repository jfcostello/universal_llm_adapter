import type {
  ProcessRouteManifest,
  RealtimeProviderManifest,
  RealtimeAudioFrame,
  RealtimeCompatSession,
  RealtimeEvent,
  RealtimeHistoryItem,
  RealtimeSessionSpec,
  UnifiedTool
} from '../../../../../kernel/index.js';
import type { ObservabilityRuntime } from '../../../../observability/index.js';

export interface RealtimeSession {
  sendText: (options: { text: string; role?: 'system' | 'user' }) => Promise<void>;
  injectContext: (items: RealtimeHistoryItem[]) => Promise<void>;
  sendDTMF: (digit: string) => Promise<void>;
  sendAudio: (frame: RealtimeAudioFrame) => Promise<void>;
  commit: () => Promise<void>;
  interrupt: (options?: { reason?: string }) => Promise<void>;
  close: () => Promise<void>;
  events: () => AsyncIterable<RealtimeEvent>;
}

export type RealtimeSessionLogger = {
  withCorrelation: (correlationId: string | string[]) => RealtimeSessionLogger;
  debug: (message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  warning: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
};

export interface RealtimeSessionControllerOptions {
  registry: { getProcessRoutes: () => Promise<ProcessRouteManifest[]> };
  provider: RealtimeProviderManifest;
  spec: RealtimeSessionSpec;
  compatSession: RealtimeCompatSession;
  tools?: UnifiedTool[];
  observability?: ObservabilityRuntime;
  logger?: RealtimeSessionLogger;
}
