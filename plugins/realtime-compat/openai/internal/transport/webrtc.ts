import { AsyncQueue } from '../../../../../modules/kernel/index.js';

import type { IRealtimeTransport, RealtimeTransportEvent } from './types.js';

type PeerConnectionLike = {
  createDataChannel: (label: string) => DataChannelLike;
  createOffer: () => Promise<{ sdp?: string }>;
  setLocalDescription: (desc: any) => Promise<void>;
  setRemoteDescription: (desc: any) => Promise<void>;
  addTrack?: (track: any, stream?: any) => void;
  localDescription?: { sdp?: string } | null;
  iceGatheringState?: string;
  addEventListener?: (type: string, listener: (...args: any[]) => void) => void;
  removeEventListener?: (type: string, listener: (...args: any[]) => void) => void;
  close: () => void;
  ontrack?: ((event: any) => void) | null;
  onicegatheringstatechange?: ((event: any) => void) | null;
  onconnectionstatechange?: ((event: any) => void) | null;
  connectionState?: string;
};

type DataChannelLike = {
  readyState?: string;
  send: (data: string) => void;
  close: () => void;
  onopen?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
};

function ensurePeerConnectionCtor(): any {
  const ctor = (globalThis as any).RTCPeerConnection;
  if (!ctor) {
    throw new Error('WebRTC transport requires RTCPeerConnection (not available in this runtime)');
  }
  return ctor;
}

async function waitForIceGatheringComplete(pc: PeerConnectionLike, timeoutMs: number): Promise<void> {
  const state = pc.iceGatheringState;
  if (state === 'complete') return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const timeoutId = setTimeout(() => finish(), timeoutMs);

    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeoutId);
        finish();
      }
    };

    if (typeof pc.addEventListener === 'function') {
      pc.addEventListener('icegatheringstatechange', onChange);
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener?.('icegatheringstatechange', onChange);
        clearTimeout(timeoutId);
        finish();
      }
      return;
    }

    // Fallback to legacy handler property
    const prev = pc.onicegatheringstatechange;
    pc.onicegatheringstatechange = (...args: any[]) => {
      try { prev?.(args[0]); } catch {}
      onChange();
    };
  });
}

export function createWebrtcTransport(options: {
  url: string;
  clientSecret: string;
  dataChannelLabel: string;
  headers?: Record<string, string>;
  inputStream?: unknown;
  onRemoteStream?: (stream: unknown) => void;
}): { transport: IRealtimeTransport; peerConnection: unknown; dataChannel: unknown } {
  const RTCPeerConnectionCtor = ensurePeerConnectionCtor();

  const pc: PeerConnectionLike = new RTCPeerConnectionCtor();
  const dc: DataChannelLike = pc.createDataChannel(options.dataChannelLabel);

  const queue = new AsyncQueue<RealtimeTransportEvent>();
  let closed = false;

  const pushOnce = (evt: RealtimeTransportEvent) => {
    if (closed) return;
    queue.push(evt);
  };

  const closeOnce = () => {
    if (closed) return;
    closed = true;
    queue.push({ type: 'close' });
    queue.close();
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
  };

  const attachInputStream = () => {
    const stream: any = options.inputStream as any;
    if (!stream) return;
    const getTracks = stream.getTracks;
    if (typeof getTracks !== 'function') return;
    if (typeof pc.addTrack !== 'function') return;
    for (const track of getTracks.call(stream)) {
      try { pc.addTrack(track, stream); } catch {}
    }
  };

  attachInputStream();

  pc.ontrack = (event: any) => {
    const stream = event?.streams?.[0];
    if (stream) {
      try { options.onRemoteStream?.(stream); } catch {}
    }
  };

  pc.onconnectionstatechange = () => {
    const state = String(pc.connectionState ?? '');
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      pushOnce({ type: 'close' });
    }
  };

  dc.onopen = () => {
    pushOnce({ type: 'open' });
  };

  dc.onmessage = (event: any) => {
    const data = event?.data;
    if (typeof data === 'string') {
      pushOnce({ type: 'message', data });
    } else if (data instanceof ArrayBuffer) {
      const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;
      const text = decoder ? decoder.decode(new Uint8Array(data)) : String(data);
      pushOnce({ type: 'message', data: text });
    } else {
      pushOnce({ type: 'message', data: String(data ?? '') });
    }
  };

  dc.onclose = () => {
    closeOnce();
  };

  dc.onerror = (event: any) => {
    pushOnce({ type: 'error', error: event, code: 'webrtc_error' });
  };

  void (async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer as any);
      await waitForIceGatheringComplete(pc, 1000);

      const offerSdp = String(pc.localDescription?.sdp ?? '');
      if (!offerSdp) {
        throw new Error('Missing local SDP offer');
      }

      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      headers.Authorization = `Bearer ${options.clientSecret}`;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/sdp';
      }

      const res = await fetch(options.url, {
        method: 'POST',
        body: offerSdp,
        headers
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`WebRTC SDP exchange failed (${res.status}): ${body || res.statusText}`);
      }

      const answerSdp = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp } as any);
    } catch (err: any) {
      pushOnce({ type: 'error', error: err, code: 'webrtc_error' });
      closeOnce();
    }
  })();

  return {
    peerConnection: pc as unknown,
    dataChannel: dc as unknown,
    transport: {
      send(data: string) {
        const state = String(dc.readyState ?? '');
        if (closed) throw new Error('Transport is closed');
        if (state && state !== 'open') throw new Error('Realtime data channel not open');
        dc.send(data);
      },
      events() {
        return queue.iterate();
      },
      close() {
        closeOnce();
      }
    }
  };
}
