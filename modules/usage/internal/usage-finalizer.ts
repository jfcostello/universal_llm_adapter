import type { LLMCallSettings, UsageStats } from '../../kernel/index.js';
import { getDefaults } from '../../kernel/index.js';

function shouldEstimateCost(settings: LLMCallSettings | undefined): boolean {
  const defaults = getDefaults().usageCost;
  const override = settings?.usageCost?.enabled;
  if (override !== undefined) {
    return override;
  }
  return defaults?.enabled ?? false;
}

export async function finalizeUsageStats(options: {
  usage?: UsageStats;
  provider: string;
  model: string;
  settings?: LLMCallSettings;
}): Promise<UsageStats | undefined> {
  if (!options.usage) return undefined;
  if (options.usage.cost !== undefined) {
    return options.usage;
  }

  if (!shouldEstimateCost(options.settings)) {
    return options.usage;
  }

  const defaults = getDefaults().usageCost;
  if (!defaults?.costsPath) {
    return options.usage;
  }

  const { estimateUsageCost } = await import('./usage-cost.js');
  const estimated = await estimateUsageCost({
    provider: options.provider,
    model: options.model,
    usage: options.usage,
    costsPath: defaults.costsPath
  });

  if (estimated === undefined) {
    return options.usage;
  }

  return {
    ...options.usage,
    cost: estimated
  };
}
