import { jest } from '@jest/globals';
import { createAudioRateLimiter } from '@/modules/server/internal/transport/audio-rate-limiter.ts';

describe('utils/server createAudioRateLimiter', () => {
  test('charges tokens and refills over time', () => {
    let now = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    const limiter = createAudioRateLimiter(10);

    limiter.charge(5);
    expect(() => limiter.charge(6)).toThrow('Audio rate limit exceeded');

    try {
      limiter.charge(6);
    } catch (err: any) {
      expect(err.code).toBe('audio_rate_limited');
    }

    now += 1000;
    expect(() => limiter.charge(6)).not.toThrow();

    nowSpy.mockRestore();
  });

  test('reset restores the full bucket', () => {
    let now = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    const limiter = createAudioRateLimiter(10);
    limiter.charge(10);
    expect(() => limiter.charge(1)).toThrow('Audio rate limit exceeded');

    limiter.reset();
    expect(() => limiter.charge(1)).not.toThrow();

    nowSpy.mockRestore();
  });
});

