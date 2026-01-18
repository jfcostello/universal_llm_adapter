import type { LLMResponse, ProviderManifest } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

import { ToolCallBudget } from '../../tool-budget.js';
import { formatCountdown } from '../../tool-message.js';
import { normalizeFlag, parseNonNegativeInt } from '../../../../shared/index.js';

export async function maybeAttachUsageCost(
  response: LLMResponse,
  providerManifest: ProviderManifest,
  model: string,
  providerSettings: Record<string, any>
): Promise<void> {
  if (!response?.usage) return;
  if (typeof response.usage.cost === 'number') return;

  const defaults = getDefaults();
  const enabled = normalizeFlag((providerSettings as any).usageCost, defaults.usageCost);
  if (!enabled) return;

  const { attachUsageCostIfMissing } = await import('../../../../usage-cost/index.js');
  attachUsageCostIfMissing({ usage: response.usage, provider: providerManifest.id, model });
}

export function parseMaxToolIterations(value: unknown, defaultValue: number = 10): number {
  return parseNonNegativeInt(value, defaultValue);
}

export function createProgressFields(budget: ToolCallBudget): Record<string, any> | undefined {
  if (budget.maxCalls === null) {
    return undefined;
  }

  const callNumber = budget.usedCalls;
  const totalCalls = budget.maxCalls;
  const remaining = budget.remaining;

  let progressLabel = `Tool call ${callNumber} of ${totalCalls}`;
  if (remaining !== null) {
    progressLabel += remaining === 0
      ? ' - No tool calls remaining'
      : ` - ${remaining} remaining`;
  }

  return {
    toolCallProgress: progressLabel,
    toolCallNumber: callNumber,
    toolCallTotal: totalCalls,
    toolCallsRemaining: remaining,
    finalToolCall: remaining === 0
  };
}

export function resolveCountdownText(enabled: boolean, budget: ToolCallBudget): string | undefined {
  if (!enabled) {
    return undefined;
  }
  const countdown = formatCountdown(budget);
  return countdown ?? undefined;
}

export const __toolLoopTestUtils__ = {
  normalizeFlag,
  parseMaxToolIterations,
  createProgressFields,
  resolveCountdownText,
  maybeAttachUsageCost
};
