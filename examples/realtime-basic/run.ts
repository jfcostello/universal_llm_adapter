import fs from 'fs';
import path from 'path';

import { bytesToBase64 } from '@/modules/audio/index.js';
import { PluginRegistry } from '@/modules/kernel/index.js';
import { createRealtimeSession, type RealtimeAudioFrame, type RealtimeEvent } from '@/modules/realtime/index.js';

type RealtimeAudioFormat = RealtimeAudioFrame['format'];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v : undefined;
}

function redactRealtimeEventForLog(event: RealtimeEvent): any {
  if (event.type === 'assistant_audio.chunk') {
    const byteLength = Math.floor((event.frame.dataBase64.length * 3) / 4);
    return {
      type: event.type,
      frame: {
        format: event.frame.format,
        sampleRateHz: event.frame.sampleRateHz,
        channels: event.frame.channels,
        byteLength
      }
    };
  }
  return event;
}

function bytesPerSample(format: RealtimeAudioFormat): number {
  return format === 'pcm16' ? 2 : 1;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const provider = envString('REALTIME_PROVIDER_ID');
  if (!provider) {
    throw new Error('Missing REALTIME_PROVIDER_ID');
  }

  const pluginsPath = envString('PLUGINS_PATH') ?? './plugins';
  const registry = new PluginRegistry(path.resolve(process.cwd(), pluginsPath));

  const audioPath = envString('REALTIME_AUDIO_PATH');
  const audioFormat = (envString('REALTIME_AUDIO_FORMAT') ?? 'pcm16') as RealtimeAudioFormat;
  const sampleRateHz = envInt('REALTIME_AUDIO_SAMPLE_RATE_HZ', 24000);
  const channels = envInt('REALTIME_AUDIO_CHANNELS', 1) === 2 ? 2 : 1;
  const frameMs = Math.max(1, envInt('REALTIME_AUDIO_FRAME_MS', 20));
  const paceAudio = envString('REALTIME_AUDIO_PACE') !== '0';

  const session = await createRealtimeSession(registry, {
    provider,
    model: envString('REALTIME_MODEL'),
    systemPrompt: envString('REALTIME_SYSTEM_PROMPT'),
    functionToolNames: ['test.echo'],
    toolChoice: 'auto',
    transcription: { enabled: envString('REALTIME_TRANSCRIPTION') === '1' },
    bargeIn: { enabled: true, triggers: ['user_speech.started'] },
    turnDetection: { mode: 'manual_commit' },
    audio: {
      input: { format: audioFormat, sampleRateHz, channels },
      output: { format: audioFormat, sampleRateHz, channels }
    }
  });

  const eventsTask = (async () => {
    for await (const event of session.events()) {
      // Avoid printing raw audio payloads.
      console.log(JSON.stringify(redactRealtimeEventForLog(event)));
    }
  })();

  const text = envString('REALTIME_TEXT') ?? 'ECHO:Hello (call the echo tool and speak only the tool result)';
  await session.sendText({ role: 'user', text });

  if (audioPath) {
    const raw = fs.readFileSync(audioPath);
    const bps = bytesPerSample(audioFormat);
    const frameBytes = Math.max(1, Math.floor((sampleRateHz * channels * bps * frameMs) / 1000));

    for (let offset = 0; offset < raw.length; offset += frameBytes) {
      const slice = raw.subarray(offset, Math.min(raw.length, offset + frameBytes));
      await session.sendAudio({
        format: audioFormat,
        sampleRateHz,
        channels,
        dataBase64: bytesToBase64(slice)
      });

      if (paceAudio) {
        await sleep(frameMs);
      }
    }
  }

  await session.commit();

  // Allow some time for events to arrive before closing.
  await sleep(2000);
  await session.close();
  await eventsTask;
}

main().catch(err => {
  console.error(err?.message ?? String(err));
  process.exitCode = 1;
});
