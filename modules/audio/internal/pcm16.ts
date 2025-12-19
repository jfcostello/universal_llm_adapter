export function pcm16leBytesToSamples(bytes: Uint8Array): Int16Array {
  if (bytes.length % 2 !== 0) {
    throw new Error('pcm16 bytes length must be even');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

export function pcm16leSamplesToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return out;
}
