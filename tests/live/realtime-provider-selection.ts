import { realtimeTestRuns } from './config.ts';

export function getRealtimeProviderSelectionErrorMessage(): string {
  const providers = realtimeTestRuns.map(r => String(r.name)).filter(Boolean).join('|');
  return (
    'No realtime live test runs are selected. ' +
    `Set LLM_TEST_PROVIDERS=${providers} (or unset it to run all realtime providers).`
  );
}

