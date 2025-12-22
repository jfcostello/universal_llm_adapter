import { createRequire } from 'module';
import { decodeWsMessage, decodeWsMessageAsync, createWsTransport } from '@/modules/realtime/internal/transport/ws.ts';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

/**
 * Unit tests for the WS transport module.
 *
 * Note: The createWsTransport function is tested via live tests (test:live:realtime)
 * since it requires a real WebSocket connection. The decodeWsMessage function is
 * tested here as it's a pure function.
 */
describe('modules/realtime/internal/transport/ws', () => {
  describe('decodeWsMessage (sync)', () => {
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

  describe('decodeWsMessageAsync', () => {
    test('returns string input as-is', async () => {
      expect(await decodeWsMessageAsync('hello world')).toBe('hello world');
    });

    test('converts Buffer to utf8 string', async () => {
      const buffer = Buffer.from('hello buffer', 'utf8');
      expect(await decodeWsMessageAsync(buffer)).toBe('hello buffer');
    });

    test('converts ArrayBuffer to utf8 string', async () => {
      const text = 'hello arraybuffer';
      const encoder = new TextEncoder();
      const arrayBuffer = encoder.encode(text).buffer;
      expect(await decodeWsMessageAsync(arrayBuffer)).toBe(text);
    });

    test('converts Buffer[] to concatenated utf8 string', async () => {
      const buffers = [
        Buffer.from('hello ', 'utf8'),
        Buffer.from('world', 'utf8'),
      ];
      expect(await decodeWsMessageAsync(buffers)).toBe('hello world');
    });

    test('converts Blob to utf8 string', async () => {
      const blob = new Blob(['hello blob'], { type: 'text/plain' });
      expect(await decodeWsMessageAsync(blob)).toBe('hello blob');
    });

    test('converts empty Blob to empty string', async () => {
      const blob = new Blob([], { type: 'text/plain' });
      expect(await decodeWsMessageAsync(blob)).toBe('');
    });

    test('falls back to String() for unknown types', async () => {
      expect(await decodeWsMessageAsync(42)).toBe('42');
      expect(await decodeWsMessageAsync(null)).toBe('null');
    });
  });

  describe('createWsTransport close() behavior', () => {
    let server: WebSocketServer;
    let port: number;

    beforeAll(async () => {
      server = new WebSocketServer({ port: 0 });
      port = (server.address() as any).port;
    });

    afterAll(async () => {
      server.close();
    });

    test('close() terminates events() iterator and emits exactly one close event', async () => {
      const transport = createWsTransport({ url: `ws://127.0.0.1:${port}` });
      const events: any[] = [];

      // Collect events in background
      const collectPromise = (async () => {
        for await (const event of transport.events()) {
          events.push(event);
          if (event.type === 'open') {
            // Close transport after receiving open
            transport.close();
          }
        }
      })();

      // Wait for iterator to complete
      await collectPromise;

      // Verify exactly one close event
      const closeEvents = events.filter(e => e.type === 'close');
      expect(closeEvents.length).toBe(1);

      // Verify iterator terminated (we reached this point)
      expect(events.some(e => e.type === 'open')).toBe(true);
    });

    test('close() is idempotent - multiple calls do not emit extra close events', async () => {
      const transport = createWsTransport({ url: `ws://127.0.0.1:${port}` });
      const events: any[] = [];

      const collectPromise = (async () => {
        for await (const event of transport.events()) {
          events.push(event);
          if (event.type === 'open') {
            // Call close multiple times
            transport.close();
            transport.close();
            transport.close();
          }
        }
      })();

      await collectPromise;

      // Should still only have one close event
      const closeEvents = events.filter(e => e.type === 'close');
      expect(closeEvents.length).toBe(1);
    });

    test('send() after close() throws error', async () => {
      const transport = createWsTransport({ url: `ws://127.0.0.1:${port}` });

      // Wait for open
      for await (const event of transport.events()) {
        if (event.type === 'open') {
          transport.close();
          break;
        }
      }

      // Now send should throw
      expect(() => transport.send('test')).toThrow('Transport is closed');
    });
  });
});
