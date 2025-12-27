import fs from 'fs';
import os from 'os';
import path from 'path';

function hasSurrogateBoundaryBug(value: string): boolean {
  if (!value) return false;
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  const startsWithLow = first >= 0xdc00 && first <= 0xdfff;
  const endsWithHigh = last >= 0xd800 && last <= 0xdbff;
  return startsWithLow || endsWithHigh;
}

describe('package subpath exports (dist)', () => {
  let chunkText: typeof import('llm-adapter/vector').chunkText;
  let chunkFile: typeof import('llm-adapter/vector').chunkFile;
  let bytesToBase64: typeof import('llm-adapter/audio').bytesToBase64;
  let base64ToBytes: typeof import('llm-adapter/audio').base64ToBytes;
  let pcm16leSamplesToBytes: typeof import('llm-adapter/audio').pcm16leSamplesToBytes;
  let pcm16leBytesToSamples: typeof import('llm-adapter/audio').pcm16leBytesToSamples;
  let bytesForDurationMs: typeof import('llm-adapter/audio').bytesForDurationMs;
  let splitBytesIntoFrames: typeof import('llm-adapter/audio').splitBytesIntoFrames;
  let resamplePcm16Samples: typeof import('llm-adapter/audio').resamplePcm16Samples;

  beforeAll(async () => {
    ({ chunkText, chunkFile } = await import('llm-adapter/vector'));
    ({
      bytesToBase64,
      base64ToBytes,
      pcm16leSamplesToBytes,
      pcm16leBytesToSamples,
      bytesForDurationMs,
      splitBytesIntoFrames,
      resamplePcm16Samples
    } = await import('llm-adapter/audio'));
  });

  test('vector: chunkText produces deterministic chunks (boundaries, overlap, ids)', () => {
    const chunks = chunkText('abcdefghijklmnopqrstuvwxyz', { chunkSize: 10, chunkOverlap: 2 });
    expect(chunks.length).toBe(4);
    expect(chunks.map(c => c.text)).toEqual(['abcdefghij', 'ijklmnopqr', 'qrstuvwxyz', 'yz']);

    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(String(id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }

    expect(chunks.map(c => c.metadata?.chunkIndex)).toEqual([0, 1, 2, 3]);
  });

  test('vector: chunkText handles empty/whitespace, overlap clamping, separators, sentences, and unicode safely', () => {
    expect(chunkText('   \n\t  ', { chunkSize: 10, chunkOverlap: 2 })).toEqual([]);

    const clamped = chunkText('abcdef', { chunkSize: 5, chunkOverlap: 999 });
    expect(clamped.map(c => c.text)).toEqual(['abcde', 'bcdef', 'cdef', 'def', 'ef', 'f']);

    const bySep = chunkText('para1\n\npara2\n\npara3', { separator: '\n\n', chunkSize: 12 });
    expect(bySep.map(c => c.text)).toEqual(['para1\n\npara2', 'para3']);

    const bySentences = chunkText('One. Two. Three.', { preserveSentences: true, chunkSize: 10 });
    expect(bySentences.map(c => c.text)).toEqual(['One. Two.', 'Three.']);

    const unicodeChunks = chunkText('a😀b', { chunkSize: 2, chunkOverlap: 0 });
    for (const chunk of unicodeChunks) {
      expect(hasSurrogateBoundaryBug(chunk.text)).toBe(false);
    }
  });

  test('vector: chunkFile includes file metadata and preserves deterministic chunk boundaries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-adapter-exports-'));
    const filePath = path.join(dir, 'sample.txt');
    fs.writeFileSync(filePath, 'abcdefghijklmnopqrstuvwxyz', 'utf-8');

    const chunks = await chunkFile(filePath, { chunkSize: 10, chunkOverlap: 2, metadata: { tag: 'x' } });
    expect(chunks.map(c => c.text)).toEqual(['abcdefghij', 'ijklmnopqr', 'qrstuvwxyz', 'yz']);

    for (const chunk of chunks) {
      expect(chunk.metadata?.filename).toBe('sample.txt');
      expect(chunk.metadata?.filepath).toBe(filePath);
      expect(chunk.metadata?.tag).toBe('x');
      expect(typeof chunk.metadata?.chunkIndex).toBe('number');
    }
  });

  test('audio utilities are deterministic and round-trip safely', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(bytes);
    const roundTrip = base64ToBytes(b64);
    expect(Array.from(roundTrip)).toEqual(Array.from(bytes));

    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    const sampleBytes = pcm16leSamplesToBytes(samples);
    const decoded = pcm16leBytesToSamples(sampleBytes);
    expect(Array.from(decoded)).toEqual(Array.from(samples));

    const frameBytes = bytesForDurationMs({ format: 'pcm16', sampleRateHz: 8000, channels: 1, durationMs: 20 });
    expect(frameBytes).toBe(320);
    const frames = splitBytesIntoFrames({
      bytes: sampleBytes,
      format: 'pcm16',
      sampleRateHz: 8000,
      channels: 1,
      frameMs: 20
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(Array.from(frames.flatMap(f => Array.from(f)))).toEqual(Array.from(sampleBytes));

    const resampledA = resamplePcm16Samples({ samples, fromSampleRateHz: 8000, toSampleRateHz: 16000, channels: 1 });
    const resampledB = resamplePcm16Samples({ samples, fromSampleRateHz: 8000, toSampleRateHz: 16000, channels: 1 });
    expect(Array.from(resampledA)).toEqual(Array.from(resampledB));
  });
});

