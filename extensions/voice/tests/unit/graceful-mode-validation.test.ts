import {
  validateEndMode,
  validateTransferMode,
  validateMaxWaitMs,
  validateCancelOnUserSpeechCli,
  validateCancelOnUserSpeechServer
} from '../../modules/graceful-mode-validation/index.js';

describe('extensions/voice/modules/graceful-mode-validation', () => {
  describe('validateEndMode', () => {
    test('returns valid mode when provided', () => {
      expect(validateEndMode('immediate', 'after_playback')).toBe('immediate');
      expect(validateEndMode('after_assistant_audio', 'immediate')).toBe('after_assistant_audio');
      expect(validateEndMode('after_playback', 'immediate')).toBe('after_playback');
    });

    test('returns default when input is empty/undefined/null', () => {
      expect(validateEndMode(undefined, 'after_playback')).toBe('after_playback');
      expect(validateEndMode(null, 'after_assistant_audio')).toBe('after_assistant_audio');
      expect(validateEndMode('', 'immediate')).toBe('immediate');
      expect(validateEndMode('  ', 'after_playback')).toBe('after_playback');
    });

    test('throws on invalid mode', () => {
      expect(() => validateEndMode('invalid', 'immediate')).toThrow();
      expect(() => validateEndMode('IMMEDIATE', 'immediate')).toThrow(); // case-sensitive
      expect(() => validateEndMode('after_transfer', 'immediate')).toThrow();
    });

    test('error has correct structure', () => {
      try {
        validateEndMode('bad_mode', 'immediate');
        fail('should throw');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('validation_error');
        expect(err.message).toBe('Invalid mode');
      }
    });
  });

  describe('validateTransferMode', () => {
    test('returns valid mode when provided', () => {
      expect(validateTransferMode('immediate', 'after_playback')).toBe('immediate');
      expect(validateTransferMode('after_playback', 'immediate')).toBe('after_playback');
    });

    test('returns default when input is empty/undefined/null', () => {
      expect(validateTransferMode(undefined, 'after_playback')).toBe('after_playback');
      expect(validateTransferMode(null, 'immediate')).toBe('immediate');
      expect(validateTransferMode('', 'after_playback')).toBe('after_playback');
      expect(validateTransferMode('  ', 'immediate')).toBe('immediate');
    });

    test('throws on invalid mode', () => {
      expect(() => validateTransferMode('invalid', 'immediate')).toThrow();
      expect(() => validateTransferMode('after_assistant_audio', 'immediate')).toThrow(); // not valid for transfer
      expect(() => validateTransferMode('AFTER_PLAYBACK', 'immediate')).toThrow(); // case-sensitive
    });

    test('error has correct structure', () => {
      try {
        validateTransferMode('bad_mode', 'immediate');
        fail('should throw');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('validation_error');
        expect(err.message).toBe('Invalid mode');
      }
    });
  });

  describe('validateMaxWaitMs', () => {
    test('returns value when valid', () => {
      expect(validateMaxWaitMs(5000, 1000)).toBe(5000);
      expect(validateMaxWaitMs('3000', 1000)).toBe(3000);
      expect(validateMaxWaitMs(0, 1000)).toBe(0);
    });

    test('floors floating point values', () => {
      expect(validateMaxWaitMs(5000.9, 1000)).toBe(5000);
      expect(validateMaxWaitMs(1234.567, 1000)).toBe(1234);
    });

    test('returns default when input is empty/undefined/null', () => {
      expect(validateMaxWaitMs(undefined, 5000)).toBe(5000);
      expect(validateMaxWaitMs(null, 3000)).toBe(3000);
      expect(validateMaxWaitMs('', 2000)).toBe(2000);
    });

    test('throws on negative values', () => {
      expect(() => validateMaxWaitMs(-1, 1000)).toThrow();
      expect(() => validateMaxWaitMs(-100, 1000)).toThrow();
    });

    test('throws on non-finite values', () => {
      expect(() => validateMaxWaitMs(NaN, 1000)).toThrow();
      expect(() => validateMaxWaitMs(Infinity, 1000)).toThrow();
      expect(() => validateMaxWaitMs('not-a-number', 1000)).toThrow();
    });

    test('respects limit when provided', () => {
      expect(validateMaxWaitMs(5000, 1000, 10000)).toBe(5000);
      expect(validateMaxWaitMs(10000, 1000, 10000)).toBe(10000);
      expect(() => validateMaxWaitMs(10001, 1000, 10000)).toThrow();
    });

    test('error message includes limit when provided', () => {
      try {
        validateMaxWaitMs(70000, 5000, 60000);
        fail('should throw');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('validation_error');
        expect(err.message).toBe('Invalid maxWaitMs (must be 0-60000)');
      }
    });

    test('error message without limit for negative values', () => {
      try {
        validateMaxWaitMs(-5, 1000);
        fail('should throw');
      } catch (err: any) {
        expect(err.message).toBe('Invalid maxWaitMs');
      }
    });

    test('error message with limit for negative values when limit provided', () => {
      try {
        validateMaxWaitMs(-5, 1000, 10000);
        fail('should throw');
      } catch (err: any) {
        expect(err.message).toBe('Invalid maxWaitMs (must be 0-10000)');
      }
    });
  });

	  describe('validateCancelOnUserSpeechCli', () => {
	    test('returns undefined for undefined/null/empty input', () => {
	      expect(validateCancelOnUserSpeechCli(undefined)).toBeUndefined();
	      expect(validateCancelOnUserSpeechCli(null)).toBeUndefined();
	      expect(validateCancelOnUserSpeechCli('')).toBeUndefined();
	      expect(validateCancelOnUserSpeechCli('  ')).toBeUndefined();
	    });

	    test('returns true for truthy strings', () => {
	      expect(validateCancelOnUserSpeechCli('true')).toBe(true);
	      expect(validateCancelOnUserSpeechCli('1')).toBe(true);
	      expect(validateCancelOnUserSpeechCli('yes')).toBe(true);
	      expect(validateCancelOnUserSpeechCli('y')).toBe(true);
	      expect(validateCancelOnUserSpeechCli('on')).toBe(true);
	      expect(validateCancelOnUserSpeechCli('TRUE')).toBe(true); // case-insensitive
	      expect(validateCancelOnUserSpeechCli('Yes')).toBe(true);
	    });

	    test('returns false for falsy strings', () => {
	      expect(validateCancelOnUserSpeechCli('false')).toBe(false);
	      expect(validateCancelOnUserSpeechCli('0')).toBe(false);
	      expect(validateCancelOnUserSpeechCli('no')).toBe(false);
	      expect(validateCancelOnUserSpeechCli('n')).toBe(false);
	      expect(validateCancelOnUserSpeechCli('off')).toBe(false);
	      expect(validateCancelOnUserSpeechCli('FALSE')).toBe(false); // case-insensitive
	      expect(validateCancelOnUserSpeechCli('No')).toBe(false);
	    });

	    test('throws on invalid strings', () => {
	      expect(() => validateCancelOnUserSpeechCli('maybe')).toThrow();
	      expect(() => validateCancelOnUserSpeechCli('2')).toThrow();
	      expect(() => validateCancelOnUserSpeechCli('yep')).toThrow();
	    });

	    test('error has correct structure', () => {
	      try {
	        validateCancelOnUserSpeechCli('invalid');
	        fail('should throw');
	      } catch (err: any) {
	        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('validation_error');
        expect(err.message).toBe('Invalid cancelOnUserSpeech');
      }
    });
  });

  describe('validateCancelOnUserSpeechServer', () => {
    test('returns boolean for various inputs (delegates to normalizeFlag)', () => {
      expect(validateCancelOnUserSpeechServer(true, false)).toBe(true);
      expect(validateCancelOnUserSpeechServer(false, true)).toBe(false);
      expect(validateCancelOnUserSpeechServer(1, false)).toBe(true);
      expect(validateCancelOnUserSpeechServer(0, true)).toBe(false);
      expect(validateCancelOnUserSpeechServer('true', false)).toBe(true);
      expect(validateCancelOnUserSpeechServer('false', true)).toBe(false);
    });

    test('returns default when input is undefined', () => {
      expect(validateCancelOnUserSpeechServer(undefined, true)).toBe(true);
      expect(validateCancelOnUserSpeechServer(undefined, false)).toBe(false);
    });
  });
});
