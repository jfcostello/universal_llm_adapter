import { decodeWsMessage } from '@/modules/realtime/internal/transport/ws.ts';

/**
 * Unit tests for the WS transport module.
 *
 * Note: The createWsTransport function is tested via live tests (test:live:realtime)
 * since it requires a real WebSocket connection. The decodeWsMessage function is
 * tested here as it's a pure function.
 */
describe('modules/realtime/internal/transport/ws', () => {
  describe('decodeWsMessage', () => {
    test('returns string input as-is', () => {
      expect(decodeWsMessage('hello world')).toBe('hello world');
      expect(decodeWsMessage('')).toBe('');
      expect(decodeWsMessage('{"type":"message"}')).toBe('{"type":"message"}');
    });

    test('converts Buffer to utf8 string', () => {
      const buffer = Buffer.from('hello buffer', 'utf8');
      expect(decodeWsMessage(buffer)).toBe('hello buffer');
    });

    test('converts empty Buffer to empty string', () => {
      const buffer = Buffer.from('', 'utf8');
      expect(decodeWsMessage(buffer)).toBe('');
    });

    test('converts Buffer with unicode to utf8 string', () => {
      const buffer = Buffer.from('hello \u{1F600} world', 'utf8');
      expect(decodeWsMessage(buffer)).toBe('hello \u{1F600} world');
    });

    test('converts ArrayBuffer to utf8 string', () => {
      const text = 'hello arraybuffer';
      const encoder = new TextEncoder();
      const arrayBuffer = encoder.encode(text).buffer;
      expect(decodeWsMessage(arrayBuffer)).toBe(text);
    });

    test('converts empty ArrayBuffer to empty string', () => {
      const arrayBuffer = new ArrayBuffer(0);
      expect(decodeWsMessage(arrayBuffer)).toBe('');
    });

    test('converts Buffer[] to concatenated utf8 string', () => {
      const buffers = [
        Buffer.from('hello ', 'utf8'),
        Buffer.from('world', 'utf8'),
      ];
      expect(decodeWsMessage(buffers)).toBe('hello world');
    });

    test('converts single-element Buffer[] to utf8 string', () => {
      const buffers = [Buffer.from('single', 'utf8')];
      expect(decodeWsMessage(buffers)).toBe('single');
    });

    test('falls back to empty array returning default String()', () => {
      // Empty arrays don't pass the Buffer[] check, so fall through to String()
      expect(decodeWsMessage([])).toBe('');
    });

    test('falls back to String() for numbers', () => {
      expect(decodeWsMessage(42)).toBe('42');
      expect(decodeWsMessage(0)).toBe('0');
      expect(decodeWsMessage(-1)).toBe('-1');
    });

    test('falls back to String() for objects', () => {
      expect(decodeWsMessage({})).toBe('[object Object]');
      expect(decodeWsMessage({ type: 'test' })).toBe('[object Object]');
    });

    test('falls back to String() for null and undefined', () => {
      expect(decodeWsMessage(null)).toBe('null');
      expect(decodeWsMessage(undefined)).toBe('undefined');
    });

    test('falls back to String() for boolean', () => {
      expect(decodeWsMessage(true)).toBe('true');
      expect(decodeWsMessage(false)).toBe('false');
    });

    test('throws when toString() fails on unknown type', () => {
      const throwOnString = {
        toString() { throw new Error('cannot stringify'); }
      };
      expect(() => decodeWsMessage(throwOnString)).toThrow('cannot stringify');
    });

    test('falls back to String() for mixed arrays (not all Buffers)', () => {
      const mixed = [Buffer.from('hello', 'utf8'), 'not a buffer'];
      // Mixed array doesn't pass the every(Buffer.isBuffer) check
      expect(decodeWsMessage(mixed)).toContain(',');
    });
  });
});
