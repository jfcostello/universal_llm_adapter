import { base64ToBytes, bytesToBase64 } from '../../../modules/audio/index.js';

describe('audio/base64', () => {
  test('bytes → base64 → bytes roundtrip', () => {
    const input = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(input);
    const out = base64ToBytes(b64);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  test('base64ToBytes tolerates empty input', () => {
    expect(base64ToBytes('').length).toBe(0);
  });
});

