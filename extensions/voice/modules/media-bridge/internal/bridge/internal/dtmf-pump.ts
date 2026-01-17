import type { RealtimeSession } from '../../../../../../../modules/realtime/index.js';

import type { ResettableQueue } from '../../resettable-queue.js';
import type { VoiceMediaWsBridgeCallbacks } from './types.js';

export function startDtmfPump<Metadata>(options: {
  session: RealtimeSession;
  call: Metadata;
  dtmfQueue: ResettableQueue<string>;
  callbacks: VoiceMediaWsBridgeCallbacks<Metadata>;
  closeAll: () => Promise<void>;
}): void {
  void (async () => {
    while (true) {
      const digit = await options.dtmfQueue.nextValue();
      if (digit === null) return;
      try {
        await options.session.sendDTMF(digit);
      } catch (err: any) {
        options.callbacks.onError?.({
          message: err?.message ?? String(err),
          code: 'session_send_dtmf_failed',
          metadata: options.call
        });
        void options.closeAll();
        return;
      }
    }
  })();
}
