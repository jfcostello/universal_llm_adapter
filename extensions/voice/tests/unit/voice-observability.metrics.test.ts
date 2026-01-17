import { jest } from '@jest/globals';

import { createVoiceServerRegistration } from '../../modules/server/index.js';
import { createInMemoryVoiceCallConfigStore } from '../../modules/call-config-store/index.js';
import { createVoiceMetrics } from '../../modules/observability/index.js';

function createMockRes() {
  return { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() } as any;
}

describe('extensions/voice: observability metrics', () => {
  const apiKeyAuth = { mode: 'apiKey', keys: [{ id: 'k1', token: 'k1' }] };
  const prevMetricsEnabled = process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;

  afterEach(() => {
    if (prevMetricsEnabled === undefined) delete process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;
    else process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = prevMetricsEnabled;
  });

  test('/voice/metrics returns 404 when metrics are disabled', async () => {
    delete process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED;

    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'GET', headers: {}, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('404');
  });

  test('/voice/metrics returns a snapshot when metrics are enabled', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

    const store = createInMemoryVoiceCallConfigStore();
	    const reg = await createVoiceServerRegistration({
	      server: {} as any,
	      registry: {},
	      pluginsPath: './plugins',
	      upgradeRouter: {} as any,
	      store,
	      providerPlugins: { getCompat: jest.fn() } as any,
	      httpConfig: { auth: apiKeyAuth }
	    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'GET', headers: { authorization: 'Bearer k1' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');

    const body = JSON.parse(String(res.end.mock.calls[0][0]));
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.metrics)).toBe(true);
  });

  test('/voice/metrics returns 501 when metrics are enabled but server auth is disabled', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

    const store = createInMemoryVoiceCallConfigStore();
	    const reg = await createVoiceServerRegistration({
	      server: {} as any,
	      registry: {},
	      pluginsPath: './plugins',
	      upgradeRouter: {} as any,
	      store,
	      providerPlugins: { getCompat: jest.fn() } as any,
	      httpConfig: { auth: { mode: 'none' } }
	    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'GET', headers: {}, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('501');
  });

  test('/voice/metrics returns 405 for non-GET methods', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

    const store = createInMemoryVoiceCallConfigStore();
    const reg = await createVoiceServerRegistration({
      server: {} as any,
      registry: {},
      pluginsPath: './plugins',
      upgradeRouter: {} as any,
      store,
      providerPlugins: { getCompat: jest.fn() } as any
    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', method: 'POST', headers: {}, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('405');
  });

  test('/voice/metrics treats missing req.method as GET', async () => {
    process.env.LLM_ADAPTER_VOICE_METRICS_ENABLED = '1';

    const store = createInMemoryVoiceCallConfigStore();
	    const reg = await createVoiceServerRegistration({
	      server: {} as any,
	      registry: {},
	      pluginsPath: './plugins',
	      upgradeRouter: {} as any,
	      store,
	      providerPlugins: { getCompat: jest.fn() } as any,
	      httpConfig: { auth: apiKeyAuth }
	    });

    const res = createMockRes();
    await expect(reg.handleHttp({ url: '/voice/metrics', headers: { authorization: 'Bearer k1' }, socket: {} } as any, res)).resolves.toBe(true);
    expect(String(res.writeHead.mock.calls[0][0])).toBe('200');
  });

  test('createVoiceMetrics: disabled is a stable no-op', () => {
    const metrics = createVoiceMetrics({ enabled: false });
    expect(metrics.enabled).toBe(false);
    expect(metrics.snapshot()).toEqual({ enabled: false, metrics: [] });
    expect(() => metrics.outboundCallAttempt('p1')).not.toThrow();
    expect(() => metrics.compatError('outbound_call', 'p1')).not.toThrow();
    expect(() => metrics.mediaWsConnected('p1')).not.toThrow();
    expect(() => metrics.mediaWsClosed('p1')).not.toThrow();
    expect(() => metrics.mediaWsError('p1')).not.toThrow();
  });

  test('createVoiceMetrics: enabled records samples and clamps gauges at 0', () => {
    const metrics = createVoiceMetrics({ enabled: true });

    // exercise empty/invalid inputs (no-op branches)
    metrics.outboundCallAttempt('');
    metrics.outboundCallAttempt('   ');
    metrics.outboundCallAttempt(undefined as any);
    metrics.compatError('outbound_call', '');
    metrics.compatError('outbound_call', '   ');
    metrics.compatError('' as any, 'p1');
    metrics.compatError(undefined as any, 'p1');
    metrics.compatError('outbound_call', undefined as any);
    metrics.mediaWsConnected(undefined as any);
    metrics.mediaWsClosed(undefined as any);
    metrics.mediaWsError(undefined as any);

    // clamp: close before connect should not go negative
    metrics.mediaWsClosed('p1');

    // record counters + gauges for a real provider id
    metrics.outboundCallAttempt('p1');
    metrics.mediaWsConnected('p1');
    metrics.mediaWsError('p1');
    metrics.mediaWsClosed('p1');
    metrics.compatError('outbound_call', 'p1');
    metrics.compatError('outbound_call', 'p1');

    // inject a compat error key that fails snapshot split validation
    metrics.compatError('bad|' as any, 'p2');

    const snap = metrics.snapshot();
    expect(snap.enabled).toBe(true);

    const samples: any[] = snap.metrics;
    const attempt = samples.find((m) => m?.name === 'voice.calls.outbound_attempt_total' && m?.labels?.voiceProvider === 'p1');
    expect(attempt?.value).toBe(1);

    const compatErr = samples.find(
      (m) =>
        m?.name === 'voice.compat.error_total' &&
        m?.labels?.voiceProvider === 'p1' &&
        m?.labels?.stage === 'outbound_call'
    );
    expect(compatErr?.value).toBe(2);

    const wsActive = samples.find((m) => m?.name === 'voice.media.ws_active' && m?.labels?.voiceProvider === 'p1');
    const wsOpened = samples.find((m) => m?.name === 'voice.media.ws_open_total' && m?.labels?.voiceProvider === 'p1');
    const wsClosed = samples.find((m) => m?.name === 'voice.media.ws_close_total' && m?.labels?.voiceProvider === 'p1');
    const wsErrored = samples.find((m) => m?.name === 'voice.media.ws_error_total' && m?.labels?.voiceProvider === 'p1');
    expect(wsActive?.value).toBe(0);
    expect(wsOpened?.value).toBe(1);
    expect(wsClosed?.value).toBe(2);
    expect(wsErrored?.value).toBe(1);
  });
});
