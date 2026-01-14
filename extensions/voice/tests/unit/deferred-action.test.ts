import { jest } from '@jest/globals';
import {
  scheduleDeferredAction,
  type ScheduleDeferredActionOptions,
  type DeferredActionEventsHub,
  type DeferredActionEventSubscription
} from '../../modules/deferred-action/index.js';

describe('extensions/voice/modules/deferred-action', () => {
  const createMockEventsHub = (
    accepted: boolean = true
  ): {
    hub: DeferredActionEventsHub;
    triggerEvent: (type: string) => void;
    lastCallback: (() => (evt: { event?: { type?: string } }) => void) | null;
    unsubscribeCalled: boolean;
  } => {
    let callback: ((evt: { event?: { type?: string } }) => void) | null = null;
    let unsubscribeCalled = false;

    return {
      hub: {
        subscribe: (
          _callConfigId: string,
          _options: { includeDeltas: boolean; eventTypes: string[] },
          cb: (evt: { event?: { type?: string } }) => void
        ): DeferredActionEventSubscription => {
          callback = cb;
          return {
            accepted,
            unsubscribe: () => {
              unsubscribeCalled = true;
            }
          };
        }
      },
      triggerEvent: (type: string) => {
        callback?.({ event: { type } });
      },
      get lastCallback() {
        return callback ? () => callback! : null;
      },
      get unsubscribeCalled() {
        return unsubscribeCalled;
      }
    };
  };

  const createBaseOptions = (
    overrides: Partial<ScheduleDeferredActionOptions> = {}
  ): ScheduleDeferredActionOptions => {
    const mock = createMockEventsHub(overrides.eventsHub ? true : true);
    return {
      callConfigId: 'test-call-123',
      providerCallId: 'provider-123',
      voiceProvider: 'test-provider',
      eventTypes: ['voice.playback.drained', 'user_speech.started'],
      maxWaitMs: 5000,
      cancelOnUserSpeech: false,
      triggerEvents: ['voice.playback.drained'],
      pendingRequests: new Map(),
      execute: jest.fn().mockResolvedValue(undefined),
      onScheduled: jest.fn(),
      onExecuted: jest.fn(),
      onCanceled: jest.fn(),
      onFailed: jest.fn(),
      eventsHub: mock.hub,
      ...overrides
    };
  };

  describe('scheduleDeferredAction', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('returns noop if already pending for callConfigId', async () => {
      const pendingRequests = new Map<string, { cancel: () => void }>();
      pendingRequests.set('test-call-123', { cancel: jest.fn() });

      const options = createBaseOptions({ pendingRequests });
      const result = await scheduleDeferredAction(options);

      expect(result).toBe('noop');
      expect(options.onScheduled).not.toHaveBeenCalled();
    });

    test('returns scheduled and calls onScheduled when subscription accepted', async () => {
      const options = createBaseOptions();
      const result = await scheduleDeferredAction(options);

      expect(result).toBe('scheduled');
      expect(options.onScheduled).toHaveBeenCalled();
      expect(options.pendingRequests.has('test-call-123')).toBe(true);
    });

    test('executes on trigger event', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({ eventsHub: mock.hub });

      await scheduleDeferredAction(options);
      expect(options.execute).not.toHaveBeenCalled();

      mock.triggerEvent('voice.playback.drained');

      // Allow async execution
      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).toHaveBeenCalled();
      expect(options.onExecuted).toHaveBeenCalledWith('client_request');
    });

    test('executes on timeout (maxWaitMs)', async () => {
      const options = createBaseOptions({ maxWaitMs: 5000 });
      await scheduleDeferredAction(options);

      expect(options.execute).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).toHaveBeenCalled();
      expect(options.onExecuted).toHaveBeenCalledWith('max_wait');
    });

    test('cancels on user speech when cancelOnUserSpeech is true', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({
        eventsHub: mock.hub,
        cancelOnUserSpeech: true
      });

      await scheduleDeferredAction(options);

      mock.triggerEvent('user_speech.started');

      expect(options.execute).not.toHaveBeenCalled();
      expect(options.onCanceled).toHaveBeenCalledWith('user_speech');
    });

    test('does not cancel on user speech when cancelOnUserSpeech is false', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({
        eventsHub: mock.hub,
        cancelOnUserSpeech: false
      });

      await scheduleDeferredAction(options);

      mock.triggerEvent('user_speech.started');

      expect(options.onCanceled).not.toHaveBeenCalled();
    });

    test('ignores events without type', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({ eventsHub: mock.hub });

      await scheduleDeferredAction(options);

      // Trigger event without type
      mock.hub.subscribe('test', { includeDeltas: false, eventTypes: [] }, () => {});
      mock.triggerEvent(undefined as any);

      expect(options.execute).not.toHaveBeenCalled();
      expect(options.onCanceled).not.toHaveBeenCalled();
    });

    test('ignores non-trigger events', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({ eventsHub: mock.hub });

      await scheduleDeferredAction(options);

      mock.triggerEvent('some.other.event');

      expect(options.execute).not.toHaveBeenCalled();
    });

    test('falls back to immediate execution when subscription rejected', async () => {
      const mock = createMockEventsHub(false);
      const options = createBaseOptions({ eventsHub: mock.hub });

      const result = await scheduleDeferredAction(options);

      expect(result).toBe('executed');
      expect(options.execute).toHaveBeenCalled();
      expect(options.onExecuted).toHaveBeenCalledWith('client_request');
      expect(options.onScheduled).not.toHaveBeenCalled();
    });

    test('throws when subscription rejected and execute throws', async () => {
      const mock = createMockEventsHub(false);
      const error = new Error('Execute failed');
      const options = createBaseOptions({
        eventsHub: mock.hub,
        execute: jest.fn().mockRejectedValue(error)
      });

      await expect(scheduleDeferredAction(options)).rejects.toThrow('Execute failed');
      expect(options.onFailed).toHaveBeenCalledWith(error, 'client_request');
    });

    test('calls onFailed when execute throws during event-triggered execution', async () => {
      const mock = createMockEventsHub(true);
      const error = new Error('Execute failed');
      const options = createBaseOptions({
        eventsHub: mock.hub,
        execute: jest.fn().mockRejectedValue(error)
      });

      await scheduleDeferredAction(options);

      mock.triggerEvent('voice.playback.drained');
      await Promise.resolve();
      await Promise.resolve();

      expect(options.onFailed).toHaveBeenCalledWith(error, 'client_request');
    });

    test('removes from pendingRequests after execution', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({ eventsHub: mock.hub });

      await scheduleDeferredAction(options);
      expect(options.pendingRequests.has('test-call-123')).toBe(true);

      mock.triggerEvent('voice.playback.drained');
      await Promise.resolve();
      await Promise.resolve();

      expect(options.pendingRequests.has('test-call-123')).toBe(false);
    });

    test('removes from pendingRequests after cancellation', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({
        eventsHub: mock.hub,
        cancelOnUserSpeech: true
      });

      await scheduleDeferredAction(options);
      expect(options.pendingRequests.has('test-call-123')).toBe(true);

      mock.triggerEvent('user_speech.started');

      expect(options.pendingRequests.has('test-call-123')).toBe(false);
    });

    test('prevents duplicate execution from concurrent events', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({ eventsHub: mock.hub });

      await scheduleDeferredAction(options);

      // Trigger multiple events rapidly
      mock.triggerEvent('voice.playback.drained');
      mock.triggerEvent('voice.playback.drained');
      mock.triggerEvent('voice.playback.drained');

      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).toHaveBeenCalledTimes(1);
    });

    test('prevents execution after cancellation', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({
        eventsHub: mock.hub,
        cancelOnUserSpeech: true
      });

      await scheduleDeferredAction(options);

      mock.triggerEvent('user_speech.started');
      mock.triggerEvent('voice.playback.drained');

      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).not.toHaveBeenCalled();
      expect(options.onCanceled).toHaveBeenCalledTimes(1);
    });

    test('ignores duplicate cancellation (requestCancel when already inactive)', async () => {
      const mock = createMockEventsHub(true);
      const options = createBaseOptions({
        eventsHub: mock.hub,
        cancelOnUserSpeech: true
      });

      await scheduleDeferredAction(options);

      // First cancellation via user speech
      mock.triggerEvent('user_speech.started');
      // Try to cancel again via another user speech event
      mock.triggerEvent('user_speech.started');

      expect(options.onCanceled).toHaveBeenCalledTimes(1);
    });

    test('ignores events with empty event object', async () => {
      let capturedCallback: ((evt: any) => void) | null = null;
      const mockHub: DeferredActionEventsHub = {
        subscribe: (_callConfigId, _options, cb) => {
          capturedCallback = cb;
          return { accepted: true, unsubscribe: () => {} };
        }
      };
      const options = createBaseOptions({ eventsHub: mockHub });

      await scheduleDeferredAction(options);

      // Trigger with empty event
      capturedCallback?.({});
      capturedCallback?.({ event: {} });
      capturedCallback?.({ event: { type: undefined } });
      capturedCallback?.({ event: { type: '' } });

      expect(options.execute).not.toHaveBeenCalled();
      expect(options.onCanceled).not.toHaveBeenCalled();
    });

    test('cancel function clears timeout', async () => {
      const options = createBaseOptions({ maxWaitMs: 5000 });

      await scheduleDeferredAction(options);

      // Get the cancel function from pendingRequests
      const pending = options.pendingRequests.get('test-call-123');
      expect(pending).toBeDefined();

      pending!.cancel();

      // Advance time past the timeout
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).not.toHaveBeenCalled();
    });

    test('handles negative maxWaitMs by using 0', async () => {
      const options = createBaseOptions({ maxWaitMs: -100 });

      await scheduleDeferredAction(options);

      // Should execute immediately (timeout of 0)
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).toHaveBeenCalled();
    });

    test('floors non-integer maxWaitMs', async () => {
      const options = createBaseOptions({ maxWaitMs: 1000.9 });

      await scheduleDeferredAction(options);

      jest.advanceTimersByTime(999);
      await Promise.resolve();
      expect(options.execute).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(options.execute).toHaveBeenCalled();
    });
  });
});
