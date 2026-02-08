import { readTrimmedStringProperty } from './read-trimmed-string-property.js';

export function readRequestedParentGenerationId(
  observability: unknown,
  metadata: unknown
): string | undefined {
  return (
    readTrimmedStringProperty(observability, 'parentGenerationId') ??
    readTrimmedStringProperty(metadata, 'parentGenerationId') ??
    readTrimmedStringProperty(metadata, 'parent_generation_id')
  );
}
