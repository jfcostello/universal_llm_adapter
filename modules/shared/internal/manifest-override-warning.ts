/**
 * Emit a manifest override warning.
 *
 * This is the single source of truth for manifest override warnings,
 * used by both core registry and extensions for consistent behavior.
 *
 * @param warn - Function to emit warning (e.g., console.warn or logger.warning)
 * @param area - The manifest area (e.g., 'providers', 'voice.providers')
 * @param id - The manifest ID being overridden
 * @param previousSource - Path/info for the previous manifest
 * @param nextSource - Path/info for the new manifest
 */
export function emitManifestOverrideWarning(
  warn: (message: string, data: Record<string, unknown>) => void,
  area: string,
  id: string,
  previousSource: string,
  nextSource: string
): void {
  try {
    warn(`${area}.override`, {
      id,
      previous: previousSource,
      next: nextSource
    });
  } catch {}
}
