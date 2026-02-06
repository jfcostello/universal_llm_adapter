import { randomUUID } from 'crypto';

import type {
  AdapterLogger,
  LLMCallSettings,
  LLMResponse,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool,
  RunContext
} from '../../../../../kernel/index.js';
import { ProviderExecutionError } from '../../../../../kernel/index.js';

import type { AxiosInstance } from 'axios';

import { aggregateSystemMessages } from '../../../../messages/index.js';
import { monotonicNowNs } from '../../../../shared/index.js';

import { callProviderViaSdk } from './call-provider-sdk.js';
import { callProviderViaHttp } from './call-provider-http.js';
import { isHttpUrlTemplate } from './http-utils.js';

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function callProvider(options: {
  httpClient: AxiosInstance;
  reasoningUnsupportedByProviderModel: Set<string>;
  registry: any;
  provider: ProviderManifest;
  model: string;
  settings: LLMCallSettings;
  messages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerExtras: Record<string, any>;
  logger?: AdapterLogger;
  context: RunContext;
}): Promise<LLMResponse> {
  const startTimeMs = Date.now();
  const startTimeMonoNs = monotonicNowNs();
  const generationId = options.context.observability
    ? readTrimmedString(options.context.generationId) ?? randomUUID()
    : undefined;
  const requestTimestampMs = startTimeMs;
  const normalizedMessages = aggregateSystemMessages(options.messages);
  const shouldLogLive = process.env.LLM_LIVE === '1';
  const compat = typeof options.registry.getCompatModuleForProvider === 'function'
    ? await options.registry.getCompatModuleForProvider(options.provider.id)
    : await options.registry.getCompatModule(options.provider.compat);
  const providerRequestsHttp = isHttpUrlTemplate(options.provider.endpoint?.urlTemplate);

  // SDK-based providers: if compat has callSDK method, use it instead of HTTP
  if (!providerRequestsHttp && typeof compat.callSDK === 'function') {
    try {
      return await callProviderViaSdk({
        compat,
        provider: options.provider,
        model: options.model,
        settings: options.settings,
        normalizedMessages,
        tools: options.tools,
        toolChoice: options.toolChoice,
        providerExtras: options.providerExtras,
        logger: options.logger,
        context: options.context,
        generationId,
        requestTimestampMs,
        startTimeMonoNs,
        shouldLogLive
      });
    } catch (error: any) {
      if (error instanceof ProviderExecutionError) {
        throw error;
      }
      throw new ProviderExecutionError(options.provider.id, error.message);
    }
  }

  return callProviderViaHttp({
    httpClient: options.httpClient,
    reasoningUnsupportedByProviderModel: options.reasoningUnsupportedByProviderModel,
    provider: options.provider,
    model: options.model,
    settings: options.settings,
    normalizedMessages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    providerExtras: options.providerExtras,
    logger: options.logger,
    context: options.context,
    generationId,
    requestTimestampMs,
    startTimeMonoNs,
    shouldLogLive,
    compat
  });
}
