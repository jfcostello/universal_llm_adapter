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
