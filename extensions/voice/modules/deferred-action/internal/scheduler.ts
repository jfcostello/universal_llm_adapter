import { setUnrefTimeout } from '../../../../../modules/shared/index.js';

/**
 * Event subscription returned by the events hub.
 */
export type DeferredActionEventSubscription = {
  accepted: boolean;
  unsubscribe: () => void;
};

/**
 * Events hub interface for subscribing to events.
 */
export type DeferredActionEventsHub = {
  subscribe: (
    callConfigId: string,
    options: { includeDeltas: boolean; eventTypes: string[] },
    callback: (evt: { event?: { type?: string } }) => void
  ) => DeferredActionEventSubscription;
};

/**
 * Options for scheduling a deferred action.
 */
export type ScheduleDeferredActionOptions = {
  /** Unique identifier for the call/request */
  callConfigId: string;
  /** Provider-specific call identifier */
  providerCallId: string;
  /** Voice provider name */
  voiceProvider: string;
  /** Event types to subscribe to */
  eventTypes: string[];
  /** Maximum time to wait for events before executing */
  maxWaitMs: number;
  /** Whether to cancel when user speech is detected */
  cancelOnUserSpeech: boolean;
  /** Event types that trigger execution */
  triggerEvents: string[];
  /** Map to track pending requests (prevents duplicates) */
  pendingRequests: Map<string, { cancel: () => void }>;
  /** The action to execute */
  execute: () => Promise<void>;
  /** Called when action is scheduled (waiting for events) */
  onScheduled: () => void;
  /** Called when action is executed */
  onExecuted: (reason: string) => void;
  /** Called when action is canceled */
  onCanceled: (reason: string) => void;
  /** Called when action fails */
  onFailed: (err: any, reason: string) => void;
  /** Events hub for subscribing to events */
  eventsHub: DeferredActionEventsHub;
};

/**
 * Schedules a deferred action to execute after specific events are received.
 * Used for graceful mode handling in voice endpoints (end/transfer).
 *
 * @returns 'scheduled' if waiting for events, 'noop' if already pending,
 *          'executed' if subscription failed and executed immediately (awaits completion)
 * @throws Re-throws execute() errors when subscription fails and execution fails
 */
export async function scheduleDeferredAction(
  options: ScheduleDeferredActionOptions
): Promise<'scheduled' | 'noop' | 'executed'> {
  const {
    callConfigId,
    eventTypes,
    maxWaitMs,
    cancelOnUserSpeech,
    triggerEvents,
    pendingRequests,
    execute,
    onScheduled,
    onExecuted,
    onCanceled,
    onFailed,
    eventsHub
  } = options;

  if (pendingRequests.has(callConfigId)) {
    return 'noop';
  }

  let active = true;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let sub: DeferredActionEventSubscription | undefined;

  const cancel = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = undefined;
    try {
      sub?.unsubscribe();
    } catch {}
    sub = undefined;
    pendingRequests.delete(callConfigId);
    active = false;
  };

  const requestExecute = (reason: string) => {
    if (!active) return;
    active = false; // Set immediately before async work to prevent race condition
    void (async () => {
      cancel();
      try {
        await execute();
        onExecuted(reason);
      } catch (err: any) {
        onFailed(err, reason);
      }
    })();
  };

  const requestCancel = (reason: string) => {
    if (!active) return;
    active = false; // Set immediately before cancel to prevent race condition
    cancel();
    onCanceled(reason);
  };

  sub = eventsHub.subscribe(
    callConfigId,
    { includeDeltas: false, eventTypes },
    (evt) => {
      const type = evt?.event?.type;
      if (!type) return;

      if (cancelOnUserSpeech && type === 'user_speech.started') {
        requestCancel('user_speech');
        return;
      }

      if (triggerEvents.includes(type)) {
        requestExecute('client_request');
        return;
      }
    }
  );

  if (!sub.accepted) {
    // Subscription rejected (e.g., hub saturated) - execute synchronously
    // and return only after completion to avoid misleading success responses
    try {
      await execute();
      onExecuted('client_request');
      return 'executed';
    } catch (err: any) {
      onFailed(err, 'client_request');
      throw err; // Re-throw so handler can return appropriate error response
    }
  }

  pendingRequests.set(callConfigId, { cancel });

  timeoutId = setUnrefTimeout(() => requestExecute('max_wait'), Math.max(0, Math.floor(maxWaitMs)));

  onScheduled();
  return 'scheduled';
}
