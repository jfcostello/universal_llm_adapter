import {
  ICompatModule,
  LLMCallSettings,
  Message,
  ProviderManifest,
  ToolChoice,
  UnifiedTool
} from '../../core/types.js';
import { applyProviderPayloadExtensions } from '../provider-payload-utils.js';
import { aggregateSystemMessages } from '../messages/message-utils.js';

export interface BuildPayloadOptions {
  provider: ProviderManifest;
  compat: ICompatModule;
  model: string;
  settings: LLMCallSettings;
  messages: Message[];
  tools: UnifiedTool[];
  toolChoice?: ToolChoice;
  providerExtras?: Record<string, any>;
  streaming?: boolean;
}

export interface BuildPayloadResult {
  payload: any;
  unconsumedExtras: Record<string, any>;
}

export function buildFinalPayload({
  provider,
  compat,
  model,
  settings,
  messages,
  tools,
  toolChoice,
  providerExtras = {},
  streaming = false
}: BuildPayloadOptions): BuildPayloadResult {
  const normalizedMessages = aggregateSystemMessages(messages);

  let payload = compat.buildPayload(model, settings, normalizedMessages, tools, toolChoice);

  if (streaming) {
    payload = {
      ...payload,
      ...compat.getStreamingFlags()
    };
  }

  const extensionKeys = new Set(
    (provider.payloadExtensions ?? []).map(extension => extension.settingsKey)
  );

  const manifestExtras: Record<string, any> = {};
  const compatExtras: Record<string, any> = {};

  for (const [key, value] of Object.entries(providerExtras)) {
    if (extensionKeys.has(key)) {
      manifestExtras[key] = value;
    } else {
      compatExtras[key] = value;
    }
  }

  const [payloadWithExtensions, leftoverFromManifest] = applyProviderPayloadExtensions(
    provider,
    payload,
    manifestExtras
  );

  const compatExtrasForUse = { ...compatExtras };

  let finalPayload = payloadWithExtensions;
  if (compat.applyProviderExtensions) {
    finalPayload = compat.applyProviderExtensions(finalPayload, compatExtrasForUse);
  }

  const unconsumedExtras: Record<string, any> = { ...leftoverFromManifest };

  for (const [key, value] of Object.entries(compatExtrasForUse)) {
    if (value !== undefined) {
      unconsumedExtras[key] = value;
    }
  }

  return {
    payload: finalPayload,
    unconsumedExtras
  };
}
