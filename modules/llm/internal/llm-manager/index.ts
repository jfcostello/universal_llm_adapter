import axios, { type AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';

import type {
  AdapterLogger,
  LLMCallSettings,
  LLMResponse,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool,
  RunContext
} from '../../../../kernel/index.js';
import { getDefaults } from '../../../../kernel/index.js';

import { normalizeFlag } from '../../../shared/index.js';

import { callProvider } from './internal/call-provider.js';
import { streamProvider } from './internal/stream-provider.js';
import {
  isRateLimitResponse,
  isReasoningDisabledNotAllowedError,
  isReasoningExplicitlyDisabled,
  isUnsupportedReasoningParamError,
  stripReasoning
} from './internal/http-utils.js';
import { recordObservabilityResponse } from './internal/observability.js';

type KeepAliveAgentPair = {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
};

let keepAliveAgents: KeepAliveAgentPair | null = null;
let keepAliveAgentsConfig: { maxSockets: number; maxFreeSockets: number } | null = null;

function unrefSocketIfPossible(socket: any): void {
  if (socket && typeof socket.unref === 'function') {
    socket.unref();
  }
}

function createKeepAliveAgents(config: { maxSockets: number; maxFreeSockets: number }): KeepAliveAgentPair {
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: config.maxSockets, maxFreeSockets: config.maxFreeSockets });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: config.maxSockets, maxFreeSockets: config.maxFreeSockets });

  httpAgent.on('free', unrefSocketIfPossible);
  httpsAgent.on('free', unrefSocketIfPossible);

  return { httpAgent, httpsAgent };
}

function getOrCreateKeepAliveAgents(config: { maxSockets: number; maxFreeSockets: number }): KeepAliveAgentPair {
  if (
    keepAliveAgents &&
    keepAliveAgentsConfig &&
    keepAliveAgentsConfig.maxSockets === config.maxSockets &&
    keepAliveAgentsConfig.maxFreeSockets === config.maxFreeSockets
  ) {
    return keepAliveAgents;
  }

  keepAliveAgents = createKeepAliveAgents(config);
  keepAliveAgentsConfig = { ...config };
  return keepAliveAgents;
}

export class LLMManager {
  private httpClient: AxiosInstance;
  private reasoningUnsupportedByProviderModel = new Set<string>();

  constructor(private registry: any) {
    const defaults = getDefaults();
    const keepAliveEnabled = normalizeFlag(
      process.env.LLM_ADAPTER_OUTBOUND_HTTP_KEEPALIVE_ENABLED,
      defaults.outboundHttp.keepAliveEnabled
    );

    const axiosConfig: Record<string, any> = {
      timeout: defaults.timeouts.llmHttp,
      validateStatus: () => true // Handle all status codes
    };

    if (keepAliveEnabled) {
      const { httpAgent, httpsAgent } = getOrCreateKeepAliveAgents({
        maxSockets: defaults.outboundHttp.maxSockets,
        maxFreeSockets: defaults.outboundHttp.maxFreeSockets
      });
      axiosConfig.httpAgent = httpAgent;
      axiosConfig.httpsAgent = httpsAgent;
    }

    this.httpClient = axios.create(axiosConfig);
  }

  async callProvider(
    provider: ProviderManifest,
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    providerExtras: Record<string, any> = {},
    logger?: AdapterLogger,
    context: RunContext = {}
  ): Promise<LLMResponse> {
    return callProvider({
      httpClient: this.httpClient,
      reasoningUnsupportedByProviderModel: this.reasoningUnsupportedByProviderModel,
      registry: this.registry,
      provider,
      model,
      settings,
      messages,
      tools,
      toolChoice,
      providerExtras,
      logger,
      context
    });
  }

  async *streamProvider(
    provider: ProviderManifest,
    model: string,
    settings: LLMCallSettings,
    messages: Message[],
    tools: UnifiedTool[],
    toolChoice?: ToolChoice,
    providerExtras: Record<string, any> = {},
    logger?: AdapterLogger,
    context: any = {}
  ): AsyncGenerator<any> {
    yield* streamProvider({
      httpClient: this.httpClient,
      registry: this.registry,
      provider,
      model,
      settings,
      messages,
      tools,
      toolChoice,
      providerExtras,
      logger,
      context
    });
  }

  protected isRateLimitResponse(provider: ProviderManifest, response: any): boolean {
    return isRateLimitResponse(provider, response);
  }

  protected stripReasoning(payload: any): any {
    return stripReasoning(payload);
  }

  protected isReasoningExplicitlyDisabled(payload: any): boolean {
    return isReasoningExplicitlyDisabled(payload);
  }

  protected isUnsupportedReasoningParamError(data: any): boolean {
    return isUnsupportedReasoningParamError(data);
  }

  protected isReasoningDisabledNotAllowedError(data: any): boolean {
    return isReasoningDisabledNotAllowedError(data);
  }

  protected recordObservabilityResponse(
    context: RunContext,
    provider: string,
    model: string,
    generationId: string | undefined,
    startTimeMonoNs: bigint,
    response?: LLMResponse,
    rawResponse?: unknown,
    error?: { message: string; code?: string; retryable?: boolean },
    logger?: AdapterLogger
  ): Record<string, any> | null {
    return recordObservabilityResponse(
      context,
      provider,
      model,
      generationId,
      startTimeMonoNs,
      response,
      rawResponse,
      error,
      logger
    );
  }
}
