import { readTrimmedStringProperty } from './read-trimmed-string-property.js';

export function readRequestedGenerationId(metadata: unknown): string | undefined {
  return (
    readTrimmedStringProperty(metadata, 'generationId') ??
    readTrimmedStringProperty(metadata, 'generation_id') ??
    readTrimmedStringProperty(metadata, 'requestId') ??
    readTrimmedStringProperty(metadata, 'request_id')
  );
}
