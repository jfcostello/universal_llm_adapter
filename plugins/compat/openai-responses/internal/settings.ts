import type { LLMCallSettings } from '../../../../kernel/index.js';

export function serializeSettings(settings: LLMCallSettings): any {
  const result: any = {};

  if (settings.maxTokens !== undefined) {
    result.max_output_tokens = settings.maxTokens;
  }

  if (settings.temperature !== undefined) {
    result.temperature = settings.temperature;
  }

  if (settings.topP !== undefined) {
    result.top_p = settings.topP;
  }

  if (settings.reasoning) {
    const { enabled, effort } = settings.reasoning;

    // Respect explicit disable regardless of effort/budget.
    if (enabled === false) {
      return result;
    }

    const validEfforts = ['high', 'medium', 'low', 'minimal', 'none', 'xhigh'];
    if (effort && validEfforts.includes(effort)) {
      result.reasoning = { effort };
    } else {
      const budget = settings.reasoning.budget ?? settings.reasoningBudget;
      const shouldDerive = enabled === true || budget !== undefined;

      if (shouldDerive) {
        let derived: 'high' | 'medium' | 'low' | 'minimal' = 'medium';

        if (typeof budget === 'number' && Number.isFinite(budget)) {
          if (budget <= 0) {
            derived = 'minimal';
          } else if (budget <= 1024) {
            derived = 'low';
          } else if (budget <= 4096) {
            derived = 'medium';
          } else {
            derived = 'high';
          }
        }

        result.reasoning = { effort: derived };
      }
    }
  }

  return result;
}

