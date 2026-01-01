export function wrapAssistantFirstTurnEvents(options: {
  originalEvents: () => AsyncIterable<any>;
  onReady: () => void;
}): () => AsyncIterable<any> {
  return () => (async function* () {
    let didTriggerReady = false;
    for await (const event of options.originalEvents()) {
      // Defensive guard: if the upstream iterator yields a nullish value (or terminates early),
      // stop immediately so we never yield an `undefined` event to consumers.
      if (event == null) return;
      yield event;
      if (!didTriggerReady && event?.type === 'ready') {
        didTriggerReady = true;
        try {
          options.onReady();
        } catch {}
      }
    }
  })();
}
