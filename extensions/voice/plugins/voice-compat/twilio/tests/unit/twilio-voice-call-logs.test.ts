import fs from 'fs';
import path from 'path';
import { jest } from '@jest/globals';
import { withTempCwd } from '@tests/helpers/temp-files.ts';

describe('plugins/voice-compat/twilio: call log capture', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('fetchPaginatedJson returns empty pages when initialUrl is blank', async () => {
    const mod = await import('../../index.js');
    const TwilioVoiceCompat = (mod as any).default;
    const compat = new TwilioVoiceCompat();

    const fetchSpy = jest.spyOn(compat as any, 'fetchJsonWithRetry');

    await expect((compat as any).fetchPaginatedJson({
      initialUrl: '',
      headers: {},
      apiBaseUrl: 'https://api.twilio.com',
      maxPages: 1,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 }
    })).resolves.toMatchObject({ pages: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('fetchPaginatedJson follows absolute next_page_uri urls', async () => {
    const mod = await import('../../index.js');
    const TwilioVoiceCompat = (mod as any).default;
    const compat = new TwilioVoiceCompat();

    const fetchSpy = jest.spyOn(compat as any, 'fetchJsonWithRetry');
    fetchSpy
      .mockResolvedValueOnce({ events: [{ sid: 'EV1' }], next_page_uri: 'https://api.twilio.com/next' })
      .mockResolvedValueOnce({ events: [{ sid: 'EV2' }], next_page_uri: null });

    const result = await (compat as any).fetchPaginatedJson({
      initialUrl: 'https://api.twilio.com/start',
      headers: { Authorization: 'Basic test' },
      apiBaseUrl: 'https://api.twilio.com',
      maxPages: 10,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 }
    });

    expect(result.pages).toHaveLength(2);
    expect(fetchSpy.mock.calls[0]?.[0]?.url).toBe('https://api.twilio.com/start');
    expect(fetchSpy.mock.calls[1]?.[0]?.url).toBe('https://api.twilio.com/next');
  });

  test('fetchPaginatedJson prefixes non-slash relative next_page_uri urls with "/"', async () => {
    const mod = await import('../../index.js');
    const TwilioVoiceCompat = (mod as any).default;
    const compat = new TwilioVoiceCompat();

    const fetchSpy = jest.spyOn(compat as any, 'fetchJsonWithRetry');
    fetchSpy
      .mockResolvedValueOnce({ events: [{ sid: 'EV1' }], next_page_uri: 'next' })
      .mockResolvedValueOnce({ events: [{ sid: 'EV2' }], next_page_uri: null });

    const result = await (compat as any).fetchPaginatedJson({
      initialUrl: 'https://api.twilio.com/start',
      headers: { Authorization: 'Basic test' },
      apiBaseUrl: 'https://api.twilio.com',
      maxPages: 10,
      retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 }
    });

    expect(result.pages).toHaveLength(2);
    expect(fetchSpy.mock.calls[1]?.[0]?.url).toBe('https://api.twilio.com/next');
  });

  test('fetchJsonWithRetry retries on 429 and 5xx responses', async () => {
    const fetchSpy = jest
      .spyOn(globalThis as any, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }) as any)
      .mockResolvedValueOnce(new Response('server error', { status: 500 }) as any)
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any);

    try {
      const mod = await import('../../index.js');
      const TwilioVoiceCompat = (mod as any).default;
      const compat = new TwilioVoiceCompat();

      await expect((compat as any).fetchJsonWithRetry({
        url: 'https://api.example.test/test.json',
        headers: {},
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0
      })).resolves.toEqual({});

      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('fetchJsonWithRetry tolerates failures reading error bodies', async () => {
    const fetchSpy = jest
      .spyOn(globalThis as any, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => { throw new Error('boom'); } } as any)
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any);

    try {
      const mod = await import('../../index.js');
      const TwilioVoiceCompat = (mod as any).default;
      const compat = new TwilioVoiceCompat();

      await expect((compat as any).fetchJsonWithRetry({
        url: 'https://api.example.test/test.json',
        headers: {},
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0
      })).resolves.toEqual({});

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('persistCallLogs is a no-op when providerCallId is undefined', async () => {
    await withTempCwd('twilio-call-logs-no-callid', async (cwd) => {
      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        throw new Error('fetch should not be called');
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({ callConfigId: 'cfg_1', providerCallId: undefined })).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, 'logs', 'voice', 'twilio'))).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs is a no-op when credentials are missing', async () => {
    await withTempCwd('twilio-call-logs-no-creds', async (cwd) => {
      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        throw new Error('fetch should not be called');
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId: 'CA123',
          providerDefaults: { accountSid: 'AC123' }
        })).resolves.toBeUndefined();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, 'logs', 'voice', 'twilio'))).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs treats non-object providerDefaults as empty', async () => {
    await withTempCwd('twilio-call-logs-non-object-defaults', async (cwd) => {
      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        throw new Error('fetch should not be called');
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId: 'CA123',
          providerDefaults: [] as any
        })).resolves.toBeUndefined();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, 'logs', 'voice', 'twilio'))).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs logs invalid JSON responses as failures', async () => {
    await withTempCwd('twilio-call-logs-invalid-json', async () => {
      const fetchSpy = jest
        .spyOn(globalThis as any, 'fetch')
        .mockResolvedValueOnce(new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any)
        .mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any);

      const logger: any = { warning: jest.fn() };

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId: 'CA123',
          providerDefaults: { accountSid: 'AC123', authToken: 'token', apiBaseUrl: 'https://api.example.test' },
          logger
        })).resolves.toBeUndefined();

        const warning = logger.warning.mock.calls.find(([msg]) => msg === 'voice.twilio.call_logs.call_failed');
        expect(warning?.[1]).toMatchObject({ message: 'Malformed response: invalid JSON' });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs falls back to default apiBaseUrl when apiBaseUrl is blank', async () => {
    await withTempCwd('twilio-call-logs-default-api-base', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === callUrl) return { ok: true, status: 200, json: async () => ({ sid: providerCallId }) } as any;
        if (u === eventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        if (u === recordingsUrl) return { ok: true, status: 200, json: async () => ({ recordings: [], next_page_uri: null }) } as any;
        if (u === debuggerEventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl: '   ' }
        })).resolves.toBeUndefined();

        expect(fetchSpy.mock.calls.some(([u]) => String(u).startsWith('https://api.twilio.com/'))).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs uses default apiBaseUrl when apiBaseUrl is undefined', async () => {
    await withTempCwd('twilio-call-logs-default-api-base-undefined', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === callUrl) return { ok: true, status: 200, json: async () => ({ sid: providerCallId }) } as any;
        if (u === eventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        if (u === recordingsUrl) return { ok: true, status: 200, json: async () => ({ recordings: [], next_page_uri: null }) } as any;
        if (u === debuggerEventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token' }
        })).resolves.toBeUndefined();

        expect(fetchSpy.mock.calls.some(([u]) => String(u).startsWith('https://api.twilio.com/'))).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persistCallLogs captures failures even when error has no status/body', async () => {
    await withTempCwd('twilio-call-logs-no-status', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      const logger: any = { warning: jest.fn() };

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);
        if (u === callUrl) throw 'network down';
        if (u === eventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        if (u === recordingsUrl) return { ok: true, status: 200, json: async () => ({ recordings: [], next_page_uri: null }) } as any;
        if (u === debuggerEventsUrl) return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: undefined,
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl },
          logger
        })).resolves.toBeUndefined();

        const baseDir = path.join(cwd, 'logs', 'voice', 'twilio');
        const callDirs = fs.readdirSync(baseDir).filter(d => d.startsWith(`call-${providerCallId}-`));
        expect(callDirs.length).toBe(1);

        const dir = path.join(baseDir, callDirs[0] as string);
        const call = JSON.parse(fs.readFileSync(path.join(dir, 'call.json'), 'utf-8'));
        expect(call).toMatchObject({ error: { message: 'network down' } });
        expect(call.error?.status).toBeUndefined();
        expect(call.error?.body).toBeUndefined();

        const warn = logger.warning.mock.calls.find(([msg]) => msg === 'voice.twilio.call_logs.call_failed');
        expect(warn?.[1]).toMatchObject({ callConfigId: '', providerCallId, message: 'network down' });
        expect((warn?.[1] as any)?.status).toBeUndefined();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('persists call resource + events + recordings under logs/voice/twilio and is best-effort on failures', async () => {
    await withTempCwd('twilio-call-logs', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);

        if (u === `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ sid: providerCallId, status: 'completed' })
          } as any;
        }

        if (u === `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ events: [{ sid: 'EV1', type: 'test' }], next_page_uri: null })
          } as any;
        }

        if (u === `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ recordings: [{ sid: 'RE1', duration: '1' }], next_page_uri: null })
          } as any;
        }

        // Debugger events are optional; simulate a permission failure.
        if (u === `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`) {
          return {
            ok: false,
            status: 403,
            text: async () => 'forbidden'
          } as any;
        }

        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl }
        })).resolves.toBeUndefined();

        const baseDir = path.join(cwd, 'logs', 'voice', 'twilio');
        expect(fs.existsSync(baseDir)).toBe(true);

        const callDirs = fs.readdirSync(baseDir).filter(d => d.startsWith(`call-${providerCallId}-`));
        expect(callDirs.length).toBe(1);

        const dir = path.join(baseDir, callDirs[0] as string);
        expect(fs.existsSync(path.join(dir, 'call.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'events.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'recordings.json'))).toBe(true);

        const call = JSON.parse(fs.readFileSync(path.join(dir, 'call.json'), 'utf-8'));
        expect(call.sid).toBe(providerCallId);

        const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf-8'));
        expect(Array.isArray(events.pages)).toBe(true);
        expect(events.pages[0].events[0].sid).toBe('EV1');

        const recordings = JSON.parse(fs.readFileSync(path.join(dir, 'recordings.json'), 'utf-8'));
        expect(recordings.pages[0].recordings[0].sid).toBe('RE1');

        // Ensure we attempted debugger events even if it failed.
        expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/Debugger/Events.json'))).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('caps pagination for events/recordings/debugger-events to avoid unbounded work', async () => {
    await withTempCwd('twilio-call-logs-pagination-cap', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_PAGES = '1';

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const eventsNextUrl = `${apiBaseUrl}/next`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);

        if (u === callUrl) {
          return { ok: true, status: 200, json: async () => ({ sid: providerCallId }) } as any;
        }

        if (u === eventsUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ events: [{ sid: 'EV1' }], next_page_uri: '/next' })
          } as any;
        }

        if (u === eventsNextUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ events: [{ sid: 'EV2' }], next_page_uri: null })
          } as any;
        }

        if (u === recordingsUrl) {
          return { ok: true, status: 200, json: async () => ({ recordings: [{ sid: 'RE1' }], next_page_uri: null }) } as any;
        }

        if (u === debuggerEventsUrl) {
          return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        }

        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl }
        })).resolves.toBeUndefined();

        const baseDir = path.join(cwd, 'logs', 'voice', 'twilio');
        const callDirs = fs.readdirSync(baseDir).filter(d => d.startsWith(`call-${providerCallId}-`));
        expect(callDirs.length).toBe(1);

        const dir = path.join(baseDir, callDirs[0] as string);
        const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf-8'));
        expect(events.pages.length).toBe(1);
        expect(events.pages[0].events[0].sid).toBe('EV1');

        expect(fetchSpy.mock.calls.some(([u]) => String(u) === eventsNextUrl)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('stops pagination when next_page_uri repeats a previously seen url', async () => {
    await withTempCwd('twilio-call-logs-pagination-repeat', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);

        if (u === callUrl) {
          return { ok: true, status: 200, json: async () => ({ sid: providerCallId }) } as any;
        }

        if (u === eventsUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              events: [{ sid: 'EV1' }],
              next_page_uri: `/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`
            })
          } as any;
        }

        if (u === recordingsUrl) {
          return { ok: true, status: 200, json: async () => ({ recordings: [], next_page_uri: null }) } as any;
        }

        if (u === debuggerEventsUrl) {
          return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        }

        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl }
        })).resolves.toBeUndefined();

        const baseDir = path.join(cwd, 'logs', 'voice', 'twilio');
        const callDirs = fs.readdirSync(baseDir).filter(d => d.startsWith(`call-${providerCallId}-`));
        expect(callDirs.length).toBe(1);

        const dir = path.join(baseDir, callDirs[0] as string);
        const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf-8'));
        expect(events.pages.length).toBe(1);
        expect(events.pages[0].events[0].sid).toBe('EV1');

        expect(fetchSpy.mock.calls.filter(([u]) => String(u) === eventsUrl)).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  test('retries rate-limited/5xx call log requests with a small bounded backoff', async () => {
    await withTempCwd('twilio-call-logs-retry', async (cwd) => {
      jest.useFakeTimers().setSystemTime(new Date('2025-10-18T10:00:00.000Z'));

      process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_MAX_RETRIES = '1';
      process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_BASE_DELAY_MS = '0';
      process.env.LLM_ADAPTER_TWILIO_CALL_LOGS_RETRY_MAX_DELAY_MS = '0';

      const providerCallId = 'CA123';
      const accountSid = 'AC123';
      const apiBaseUrl = 'https://api.twilio.com';

      const callUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}.json`;
      const eventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Events.json`;
      const recordingsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Recordings.json`;
      const debuggerEventsUrl = `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Calls/${providerCallId}/Debugger/Events.json`;

      let callAttempts = 0;
      const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);

        if (u === callUrl) {
          callAttempts += 1;
          if (callAttempts === 1) {
            return { ok: false, status: 429, text: async () => 'rate limited' } as any;
          }
          return { ok: true, status: 200, json: async () => ({ sid: providerCallId, status: 'completed' }) } as any;
        }

        if (u === eventsUrl) {
          return { ok: true, status: 200, json: async () => ({ events: [], next_page_uri: null }) } as any;
        }

        if (u === recordingsUrl) {
          return { ok: true, status: 200, json: async () => ({ recordings: [], next_page_uri: null }) } as any;
        }

        if (u === debuggerEventsUrl) {
          return { ok: false, status: 403, text: async () => 'forbidden' } as any;
        }

        return { ok: false, status: 404, text: async () => 'not found' } as any;
      });

      try {
        const mod = await import('../../index.js');
        const TwilioVoiceCompat = (mod as any).default;
        const compat = new TwilioVoiceCompat();

        await expect((compat as any).persistCallLogs({
          callConfigId: 'cfg_1',
          providerCallId,
          providerDefaults: { accountSid, authToken: 'token', apiBaseUrl }
        })).resolves.toBeUndefined();

        expect(callAttempts).toBe(2);

        const baseDir = path.join(cwd, 'logs', 'voice', 'twilio');
        const callDirs = fs.readdirSync(baseDir).filter(d => d.startsWith(`call-${providerCallId}-`));
        expect(callDirs.length).toBe(1);

        const dir = path.join(baseDir, callDirs[0] as string);
        const call = JSON.parse(fs.readFileSync(path.join(dir, 'call.json'), 'utf-8'));
        expect(call.sid).toBe(providerCallId);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
