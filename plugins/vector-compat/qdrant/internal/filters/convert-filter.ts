import type { JsonObject } from '../../../../../kernel/index.js';

/**
 * Convert generic JsonObject filter to Qdrant filter format
 *
 * Qdrant filter format:
 * {
 *   must: [{ key: "field", match: { value: "value" } }],
 *   should: [...],
 *   must_not: [...]
 * }
 */
export function convertFilter(filter: JsonObject): any {
  // If filter already has Qdrant structure, use as-is
  if ((filter as any).must || (filter as any).should || (filter as any).must_not) {
    return filter;
  }

  // Convert simple key-value pairs to Qdrant "must" conditions
  const must: any[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value !== null && value !== undefined) {
      // If key targets nested object (dot-notation), wrap in nested filter for better compatibility
      if (key.includes('.')) {
        const [path] = key.split('.');
        must.push({
          nested: {
            path,
            filter: {
              must: [{
                key,
                match: { value }
              }]
            }
          }
        });
      } else {
        must.push({
          key,
          match: { value }
        });
      }
    }
  }

  return must.length > 0 ? { must } : undefined;
}

