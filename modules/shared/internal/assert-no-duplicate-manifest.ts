/**
 * Asserts that a manifest ID is not already present in a collection.
 * Throws an error if a duplicate is found.
 *
 * This is the single source of truth for duplicate manifest detection,
 * used by both core registry and extensions to ensure consistent behavior.
 *
 * @param hasId - Function or object with .has() method to check for existing ID
 * @param id - The manifest ID to check
 * @param sourcePath - Path to the manifest file (for error message)
 * @param label - Optional label for the manifest type (e.g., 'provider', 'voice provider')
 * @throws Error when duplicate ID is found
 */
export function assertNoDuplicateManifest(
  hasId: { has: (id: string) => boolean } | ((id: string) => boolean),
  id: string,
  sourcePath: string,
  label?: string
): void {
  const exists = typeof hasId === 'function' ? hasId(id) : hasId.has(id);
  if (exists) {
    const manifestLabel = label ? `${label} ` : '';
    throw new Error(`Duplicate ${manifestLabel}id '${id}' in '${sourcePath}'`);
  }
}
