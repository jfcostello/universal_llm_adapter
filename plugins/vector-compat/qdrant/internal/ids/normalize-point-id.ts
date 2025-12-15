import { createHash } from 'crypto';

export const ORIGINAL_ID_KEY = '__llm_adapter_original_id';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toDeterministicUuidV4(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  const b = Buffer.from(bytes);

  // RFC 4122 variant + v4
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizePointId(id: string): { qdrantId: string | number; originalId?: string } {
  const raw = String(id);

  // Qdrant accepts UUIDs.
  if (UUID_REGEX.test(raw)) {
    return { qdrantId: raw };
  }

  // Qdrant accepts unsigned integers.
  if (/^\d+$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isSafeInteger(asNumber)) {
      return { qdrantId: asNumber };
    }
  }

  // Otherwise, derive a deterministic UUID so arbitrary string ids are supported.
  return { qdrantId: toDeterministicUuidV4(raw), originalId: raw };
}

