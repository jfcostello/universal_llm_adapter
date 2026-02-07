import type { LLMCallSettings, UsageStats } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

import { normalizeFlag } from '../../../../shared/index.js';

export async function attachUsageCostForResponseIfNeeded(options: {
  usage: UsageStats | undefined;
  settings: LLMCallSettings;
  provider: string;
  model: string;
}): Promise<void> {
  const usage = options.usage;
  if (!usage) return;
  if (typeof usage.cost === 'number') return;

  const defaults = getDefaults();
  const shouldCalculateUsageCost = normalizeFlag(options.settings.usageCost, defaults.usageCost);
  if (!shouldCalculateUsageCost) return;

  const { attachUsageCostIfMissing } = await import('../../../../usage-cost/index.js');
  attachUsageCostIfMissing({
    usage,
    provider: options.provider,
    model: options.model
  });
}

