import axios, { type AxiosInstance } from 'axios';

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

export class LLMManager {
  private httpClient: AxiosInstance;
  private reasoningUnsupportedByProviderModel = new Set<string>();

  constructor(private registry: any) {
    this.httpClient = axios.create({
      timeout: getDefaults().timeouts.llmHttp,
      validateStatus: () => true // Handle all status codes
    });
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
