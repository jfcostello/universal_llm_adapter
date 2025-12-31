export function wrapAssistantFirstTurnEvents(options: {
  originalEvents: () => AsyncIterable<any>;
  onReady: () => void;
}): () => AsyncIterable<any> {
  return () => (async function* () {
    const iter = options.originalEvents()[Symbol.asyncIterator]();
    const first = await iter.next();
    if (first.done || first.value == null) return;

    const firstEvent = first.value;
    yield firstEvent;

    if (firstEvent?.type === 'ready') {
      try {
        options.onReady();
      } catch {}
    }

    for await (const event of { [Symbol.asyncIterator]: () => iter } as AsyncIterable<any>) {
      yield event;
    }
  })();
}

