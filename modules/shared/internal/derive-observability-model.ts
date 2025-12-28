import { readTrimmedStringProperty } from './read-trimmed-string-property.js';

export function deriveObservabilityModel(options: {
  provider: string;
  model: string;
  providerHint?: unknown;
}): string {
  const provider = typeof options.provider === 'string' ? options.provider : String(options.provider ?? '');
  const model = typeof options.model === 'string' ? options.model : String(options.model ?? '');

  const upstreamProvider = (() => {
    if (typeof options.providerHint === 'string') {
      const trimmed = options.providerHint.trim();
      return trimmed ? trimmed : undefined;
    }
    return readTrimmedStringProperty(options.providerHint, 'provider');
  })();

  if (!upstreamProvider) return model;
  if (upstreamProvider === provider) return model;
  if (model.startsWith(`${upstreamProvider}/`)) return model;

  return `${upstreamProvider}/${model}`;
}
