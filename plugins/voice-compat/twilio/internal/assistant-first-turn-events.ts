export function wrapAssistantFirstTurnEvents(options: {
  originalEvents: () => AsyncIterable<any>;
  onReady: () => void;
}): () => AsyncIterable<any> {
  return () => (async function* () {
    let didTriggerReady = false;
    for await (const event of options.originalEvents()) {
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
