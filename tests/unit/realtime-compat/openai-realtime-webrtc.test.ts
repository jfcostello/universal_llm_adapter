import { jest } from '@jest/globals';

import OpenAIRealtimeCompat from '@/plugins/realtime-compat/openai/index.ts';
import { createOpenAIRealtimeWebrtcCompatSession } from '@/plugins/realtime-compat/openai/internal/session-webrtc.ts';
import { createOpenAIRealtimeCompatSessionWithTransport, resolveOpenAIWebrtcSdpUrl } from '@/plugins/realtime-compat/openai/internal/session-core.ts';
import { createWebrtcTransport } from '@/plugins/realtime-compat/openai/internal/transport/webrtc.ts';

type FakeFetchResponse = { ok: boolean; status: number; statusText: string; text: () => Promise<string> };

function installFetch(mock: (url: string, init: any) => Promise<FakeFetchResponse>) {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = mock;
  return () => {
    (globalThis as any).fetch = original;
  };
}

function createArrayBufferFromText(text: string): ArrayBuffer {
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
  if (!encoder) return new Uint8Array([]).buffer;
  return encoder.encode(text).buffer;
}

async function collectN<T>(iter: AsyncIterator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  while (out.length < n) {
    const next = await iter.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

async function waitFor(condition: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('plugins/realtime-compat/openai — webrtc transport + session', () => {
  let restoreFetch: (() => void) | undefined;
  let originalRTCPeerConnection: any;
  let originalTextDecoder: any;

  beforeEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    originalRTCPeerConnection = (globalThis as any).RTCPeerConnection;
    originalTextDecoder = (globalThis as any).TextDecoder;
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    (globalThis as any).RTCPeerConnection = originalRTCPeerConnection;
    (globalThis as any).TextDecoder = originalTextDecoder;
    jest.restoreAllMocks();
  });

  test('createWebrtcTransport throws when RTCPeerConnection is missing', () => {
    (globalThis as any).RTCPeerConnection = undefined;
    expect(() =>
      createWebrtcTransport({
        url: 'https://x',
        clientSecret: 'secret',
        dataChannelLabel: 'dc'
      } as any)
    ).toThrow('RTCPeerConnection');
  });

  test('createWebrtcTransport negotiates SDP, decodes messages, and supports send/close', async () => {
    const sent: string[] = [];
    const addTrackCalls: any[] = [];
    const onRemoteStream = jest.fn(() => {
      throw new Error('ignore');
    });
    const onRemoteStream2 = jest.fn();

    class FakeDataChannel {
      readyState = 'connecting';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = 'closed';
        this.onclose?.({});
      }
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'complete';
      connectionState = 'connected';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      addTrack(track: any, stream: any) {
        addTrackCalls.push([track, stream]);
      }
      constructor() {
        FakePeerConnection.last = this;
      }
      createDataChannel(_label: string) {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;

    restoreFetch = installFetch(async (url, init) => {
      expect(url).toBe('https://sdp');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer secret');
      expect(init.headers['Content-Type']).toBe('application/sdp');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'ANSWER_SDP'
      };
    });

    const inputStream = { getTracks: () => [{ id: 't1' }] };
    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc',
      inputStream,
      onRemoteStream
    });

    // Flush the negotiation task so SDP exchange happens (fetch assertions run).
    await Promise.resolve();
    await Promise.resolve();

    // Send before open should throw.
    expect(() => transport.send('x')).toThrow('Realtime data channel not open');

    // Open the data channel and send.
    FakePeerConnection.last.dc.readyState = 'open';
    FakePeerConnection.last.dc.onopen?.({});
    transport.send('hello');
    expect(sent).toContain('hello');

    // Message decoding branches.
    FakePeerConnection.last.dc.onmessage?.({ data: 'str' });
    FakePeerConnection.last.dc.onmessage?.({ data: createArrayBufferFromText('buf') });
    (globalThis as any).TextDecoder = undefined;
    FakePeerConnection.last.dc.onmessage?.({ data: createArrayBufferFromText('buf2') });
    FakePeerConnection.last.dc.onmessage?.({ data: 123 });
    FakePeerConnection.last.dc.onmessage?.({});
    FakePeerConnection.last.dc.onerror?.({ message: 'boom' });

    // Remote stream callback (also cover missing stream branch).
    FakePeerConnection.last.ontrack?.({ streams: [] });
    FakePeerConnection.last.ontrack?.({ streams: ['remote-stream'] });
    expect(onRemoteStream).toHaveBeenCalledWith('remote-stream');

    // Connection state close branches.
    FakePeerConnection.last.connectionState = undefined;
    FakePeerConnection.last.onconnectionstatechange?.({});
    FakePeerConnection.last.connectionState = 'failed';
    FakePeerConnection.last.onconnectionstatechange?.({});
    FakePeerConnection.last.connectionState = 'closed';
    FakePeerConnection.last.onconnectionstatechange?.({});
    FakePeerConnection.last.connectionState = 'disconnected';
    FakePeerConnection.last.onconnectionstatechange?.({});

    // Close idempotency + send after close.
    transport.close();
    transport.close();
    expect(() => transport.send('nope')).toThrow('Transport is closed');
    FakePeerConnection.last.dc.onmessage?.({ data: 'late' });

    // Ensure inputStream tracks were attached.
    expect(addTrackCalls.length).toBe(1);

    // Drain a few events to ensure queue ran.
    const it = transport.events()[Symbol.asyncIterator]();
    const events = await collectN(it, 5);
    expect(events.some((e: any) => e.type === 'open')).toBe(true);
    expect(events.some((e: any) => e.type === 'message' && e.data === 'str')).toBe(true);

    // Cover readyState undefined branch (allows send when state is empty).
    class FakeDataChannel2 {
      readyState: any = undefined;
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(data: string) {
        sent.push(data);
      }
      close() {}
    }
    class FakePeerConnection2 {
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel2();
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }
    (globalThis as any).RTCPeerConnection = FakePeerConnection2 as any;
    restoreFetch?.();
    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ANSWER_SDP'
    }));
    const { transport: transport2 } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc',
      inputStream: {} as any,
      onRemoteStream: onRemoteStream2,
      headers: { 'Content-Type': 'custom/sdp' }
    });
    await Promise.resolve();
    await Promise.resolve();
    transport2.send('works');
    transport2.close();
  });

  test('createWebrtcTransport covers addEventListener ice-gathering path', async () => {
    const sendCalls: string[] = [];
    let addedListener: any;
    let removedListener: any;

    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(data: string) {
        sendCalls.push(data);
      }
      close() {}
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'gathering';
      localDescription: any = null;
      onicegatheringstatechange: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      constructor() {
        FakePeerConnection.last = this;
      }
      addEventListener(_type: string, listener: any) {
        addedListener = listener;
        // Flip state to complete while inside addEventListener to cover immediate branch.
        this.iceGatheringState = 'complete';
      }
      removeEventListener(_type: string, listener: any) {
        removedListener = listener;
      }
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;

    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ANSWER_SDP'
    }));

    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc'
    });

    // Flush the negotiation task to hit addEventListener/removeEventListener paths.
    await Promise.resolve();
    await Promise.resolve();

    // Force the transport open event.
    FakePeerConnection.last.dc.onopen?.({});

    // The add/remove listener hooks should have been hit.
    expect(addedListener).toBeDefined();
    expect(removedListener).toBe(addedListener);
    // Invoke the listener after completion to cover onChange + finish-idempotent branches.
    addedListener?.();

    transport.send('x');
    expect(sendCalls).toEqual(['x']);
  });

  test('createWebrtcTransport covers legacy ice-gathering handler path', async () => {
    let prevCalled = false;
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'gathering';
      localDescription: any = null;
      onicegatheringstatechange: any = () => { prevCalled = true; };
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      constructor() {
        FakePeerConnection.last = this;
      }
      // No addEventListener/removeEventListener -> legacy path
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;

    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ANSWER_SDP'
    }));

    createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc'
    });

    // Allow the negotiation task to start and install the wrapper.
    await Promise.resolve();
    await Promise.resolve();
    FakePeerConnection.last.iceGatheringState = 'complete';
    FakePeerConnection.last.onicegatheringstatechange?.({});
    expect(prevCalled).toBe(true);
  });

  test('createWebrtcTransport emits error when local SDP is missing', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      constructor() {
        FakePeerConnection.last = this;
      }
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(_desc: any) {
        this.localDescription = null;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => {
      throw new Error('fetch should not be called');
    });

    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc',
      // cover getTracks-not-a-function branch
      inputStream: { getTracks: 'nope' } as any
    });

    const it = transport.events()[Symbol.asyncIterator]();
    const events = await collectN(it, 2);
    expect(events[0]).toMatchObject({ type: 'error', code: 'webrtc_error' });
    expect(events[1]).toMatchObject({ type: 'close' });
  });

  test('createWebrtcTransport emits error when SDP exchange fails', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'nope'
    }));

    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc',
      // cover addTrack-not-a-function branch
      inputStream: { getTracks: () => [{ id: 't1' }] } as any
    });

    const it = transport.events()[Symbol.asyncIterator]();
    const events = await collectN(it, 2);
    expect(events[0]).toMatchObject({ type: 'error', code: 'webrtc_error' });
    expect(events[1]).toMatchObject({ type: 'close' });
  });

  test('createWebrtcTransport covers ICE gathering timeout path', async () => {
    jest.useFakeTimers();

    try {
      class FakeDataChannel {
        readyState = 'open';
        onopen: any = null;
        onmessage: any = null;
        onclose: any = null;
        onerror: any = null;
        send(_data: string) {}
        close() {}
      }

      class FakePeerConnection {
        iceGatheringState = 'gathering';
        localDescription: any = null;
        ontrack: any = null;
        onconnectionstatechange: any = null;
        dc = new FakeDataChannel();
        createDataChannel() {
          return this.dc as any;
        }
        addEventListener(_type: string, _listener: any) {}
        removeEventListener(_type: string, _listener: any) {}
        async createOffer() {
          return { sdp: 'OFFER_SDP' };
        }
        async setLocalDescription(desc: any) {
          this.localDescription = desc;
        }
        async setRemoteDescription(_desc: any) {}
        close() {}
      }

      (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
      let fetchCalled = false;
      restoreFetch = installFetch(async () => {
        fetchCalled = true;
        return { ok: true, status: 200, statusText: 'OK', text: async () => 'ANSWER_SDP' };
      });

      createWebrtcTransport({
        url: 'https://sdp',
        clientSecret: 'secret',
        dataChannelLabel: 'dc'
      });

      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchCalled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('createWebrtcTransport handles SDP exchange error when res.text throws', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => {
        throw new Error('read-failed');
      }
    }));

    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc'
    });

    const it = transport.events()[Symbol.asyncIterator]();
    const events = await collectN(it, 2);
    expect(events[0]).toMatchObject({ type: 'error', code: 'webrtc_error' });
    expect(events[1]).toMatchObject({ type: 'close' });
  });

  test('createWebrtcTransport error uses statusText when response body is empty', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => ''
    }));

    const { transport } = createWebrtcTransport({
      url: 'https://sdp',
      clientSecret: 'secret',
      dataChannelLabel: 'dc'
    });

    const it = transport.events()[Symbol.asyncIterator]();
    const events = await collectN(it, 2);
    expect(String((events[0] as any).error)).toContain('Forbidden');
    expect(events[1]).toMatchObject({ type: 'close' });
  });

  test('resolveOpenAIWebrtcSdpUrl rejects missing config', () => {
    expect(() =>
      resolveOpenAIWebrtcSdpUrl({
        provider: { id: 'p', compat: 'x', endpoint: { urlTemplate: 'ws://x', headers: {} } } as any,
        spec: { provider: 'p', model: 'm' } as any
      })
    ).toThrow('missing realtime webrtc endpoint');
  });

  test('resolveOpenAIWebrtcSdpUrl uses realtime defaultModel when spec.model is missing', () => {
    const url = resolveOpenAIWebrtcSdpUrl({
      provider: {
        id: 'p',
        compat: 'x',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } },
        metadata: { defaultModel: 'dm' }
      } as any,
      spec: { provider: 'p' } as any
    });
    expect(url).toBe('https://sdp/?model=dm');
  });

  test('resolveOpenAIWebrtcSdpUrl rejects when no model is available', () => {
    expect(() =>
      resolveOpenAIWebrtcSdpUrl({
        provider: {
          id: 'p',
          compat: 'x',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } }
        } as any,
        spec: { provider: 'p' } as any
      })
    ).toThrow("requires 'model'");
  });

  test('session-webrtc requires clientSecret and emits ready after session.updated', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      sent: any[] = [];
      send(data: string) {
        this.sent.push(JSON.parse(data));
      }
      close() {}
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      constructor() {
        FakePeerConnection.last = this;
      }
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ANSWER_SDP'
    }));

    expect(() =>
      createOpenAIRealtimeWebrtcCompatSession({
        provider: {
          id: 'openai',
          compat: 'openai',
          endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
          webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } }
        } as any,
        spec: { provider: 'openai', model: 'm', transport: { type: 'webrtc' } }
      } as any)
    ).toThrow('clientSecret');

    const session = createOpenAIRealtimeWebrtcCompatSession({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } }
      } as any,
      spec: { provider: 'openai', model: 'm', transport: { type: 'webrtc' }, webrtc: { clientSecret: 'secret' } }
    } as any);

    const it = session.events()[Symbol.asyncIterator]();
    FakePeerConnection.last.dc.onopen?.({});
    await waitFor(() => FakePeerConnection.last.dc.sent.some((m: any) => m.type === 'session.update'));

    FakePeerConnection.last.dc.onmessage?.({ data: JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }) });
    const first = await it.next();
    expect(first.value.type).toBe('ready');
    await session.close();
  });

  test('session-core emits transport_pump_failed when transport iterator throws', async () => {
    const transport = {
      send: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'open' } as any;
        throw new Error('boom');
      }
    };

    const session = createOpenAIRealtimeCompatSessionWithTransport({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm' }
    } as any, transport as any);

    const events = await collectN(session.events()[Symbol.asyncIterator](), 3);
    expect(events[0]).toMatchObject({ type: 'ready' });
    expect(events[1]).toMatchObject({ type: 'error', code: 'transport_pump_failed' });
    expect(events[2]).toMatchObject({ type: 'closed' });
  });

  test('session-core emits transport_error when transport error has no code', async () => {
    const transport = {
      send: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'error', error: new Error('nope') } as any;
        yield { type: 'close' } as any;
      }
    };

    const session = createOpenAIRealtimeCompatSessionWithTransport({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm' }
    } as any, transport as any);

    const events = await collectN(session.events()[Symbol.asyncIterator](), 3);
    expect(events[0]).toMatchObject({ type: 'ready' });
    expect(events[1]).toMatchObject({ type: 'error', code: 'transport_error' });
    expect(events[2]).toMatchObject({ type: 'closed' });
  });

  test('session-core emits invalid_json when message has no data', async () => {
    const transport = {
      send: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'message' } as any;
        yield { type: 'close' } as any;
      }
    };

    const session = createOpenAIRealtimeCompatSessionWithTransport({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm' }
    } as any, transport as any);

    const events = await collectN(session.events()[Symbol.asyncIterator](), 3);
    expect(events[0]).toMatchObject({ type: 'ready' });
    expect(events[1]).toMatchObject({ type: 'error', code: 'invalid_json' });
    expect(events[2]).toMatchObject({ type: 'closed' });
  });

  test('session-core emits non-fatal warnings for unsupported/invalid session settings', async () => {
    const transport = {
      send: jest.fn(),
      close: jest.fn(),
      events: async function* () {
        yield { type: 'open' } as any;
        yield { type: 'message', data: JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }) } as any;
        yield { type: 'close' } as any;
      }
    };

    const session = createOpenAIRealtimeCompatSessionWithTransport({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} }
      } as any,
      spec: { provider: 'openai', model: 'm', settings: { unknownKey: 'x', temperature: 'nope' } }
    } as any, transport as any);

    const events = await collectN(session.events()[Symbol.asyncIterator](), 4);
    expect(events[0]).toMatchObject({ type: 'ready' });
    expect(events[1]).toMatchObject({ type: 'error', code: 'unsupported_session_settings' });
    expect(events[2]).toMatchObject({ type: 'error', code: 'invalid_session_settings' });
    expect(events[3]).toMatchObject({ type: 'closed' });
  });

  test('openai compat class selects webrtc branch', async () => {
    class FakeDataChannel {
      readyState = 'open';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      send(_data: string) {}
      close() {}
    }

    class FakePeerConnection {
      static last: any;
      iceGatheringState = 'complete';
      localDescription: any = null;
      ontrack: any = null;
      onconnectionstatechange: any = null;
      dc = new FakeDataChannel();
      constructor() {
        FakePeerConnection.last = this;
      }
      createDataChannel() {
        return this.dc as any;
      }
      async createOffer() {
        return { sdp: 'OFFER_SDP' };
      }
      async setLocalDescription(desc: any) {
        this.localDescription = desc;
      }
      async setRemoteDescription(_desc: any) {}
      close() {}
    }

    (globalThis as any).RTCPeerConnection = FakePeerConnection as any;
    restoreFetch = installFetch(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ANSWER_SDP'
    }));

    const compat = new (OpenAIRealtimeCompat as any)();
    const session = await Promise.resolve(compat.createSession({
      provider: {
        id: 'openai',
        compat: 'openai',
        endpoint: { urlTemplate: 'ws://x?model={model}', headers: {} },
        webrtc: { endpoint: { urlTemplate: 'https://sdp?model={model}' } }
      } as any,
      spec: { provider: 'openai', model: 'm', transport: { type: 'webrtc' }, webrtc: { clientSecret: 'secret' } }
    }));

    const it = session.events()[Symbol.asyncIterator]();
    FakePeerConnection.last.dc.onopen?.({});
    FakePeerConnection.last.dc.onmessage?.({ data: JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }) });
    const first = await it.next();
    expect(first.value.type).toBe('ready');
    await session.close();
  });
});
