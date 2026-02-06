import type { ObservabilityContext } from '../../../kernel/index.js';
import { normalizeFlag } from './normalize-flag.js';

export type ResolvedObservabilityCaptureSettings = {
  captureMessages: 'none' | 'text' | 'full';
  captureToolArgs: boolean;
  captureRequestPayload: boolean;
  captureRawResponse: boolean;
};

const OBSERVABILITY_CAPTURE_DEFAULTS: ResolvedObservabilityCaptureSettings = {
  captureMessages: 'none',
  captureToolArgs: false,
  captureRequestPayload: false,
  captureRawResponse: false
};

function normalizeCaptureMessages(value: unknown): 'none' | 'text' | 'full' {
  if (typeof value !== 'string') return OBSERVABILITY_CAPTURE_DEFAULTS.captureMessages;
  const mode = value.trim().toLowerCase();
  if (mode === 'none' || mode === 'text' || mode === 'full') return mode;
  return OBSERVABILITY_CAPTURE_DEFAULTS.captureMessages;
}

export function resolveObservabilityCaptureSettings(
  observability: Partial<ObservabilityContext> | undefined
): ResolvedObservabilityCaptureSettings {
  return {
    captureMessages: normalizeCaptureMessages(observability?.captureMessages),
    captureToolArgs: normalizeFlag(observability?.captureToolArgs, OBSERVABILITY_CAPTURE_DEFAULTS.captureToolArgs),
    captureRequestPayload: normalizeFlag(observability?.captureRequestPayload, OBSERVABILITY_CAPTURE_DEFAULTS.captureRequestPayload),
    captureRawResponse: normalizeFlag(observability?.captureRawResponse, OBSERVABILITY_CAPTURE_DEFAULTS.captureRawResponse)
  };
}
