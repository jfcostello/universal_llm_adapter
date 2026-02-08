function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeParentGenerationId(
  parentGenerationId: unknown,
  generationId: unknown
): string | undefined {
  const parent = readTrimmedString(parentGenerationId);
  if (!parent) {
    return undefined;
  }

  const generation = readTrimmedString(generationId);
  if (generation && parent === generation) {
    return undefined;
  }

  return parent;
}
