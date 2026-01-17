import { Role } from '@/kernel/index.ts';

import { isToolBudgetFinalPromptMessage } from '@/plugins/compat/openai-assistants/internal/messages.ts';
import { validateRequiredActionMetadata } from '@/plugins/compat/openai-assistants/internal/response.ts';
import { buildToolsAndChoice } from '@/plugins/compat/openai-assistants/internal/tools.ts';

describe('compat/openai-assistants', () => {
  describe('isToolBudgetFinalPromptMessage', () => {
    test('returns false for non-user messages', () => {
      expect(
        isToolBudgetFinalPromptMessage({
          role: Role.ASSISTANT,
          content: [{ type: 'text', text: 'hi' }]
        } as any)
      ).toBe(false);
    });
  });

  describe('validateRequiredActionMetadata', () => {
    test('returns false when metadata is missing', () => {
      expect(validateRequiredActionMetadata(undefined)).toBe(false);
    });

    test('returns false when threadId is missing', () => {
      expect(validateRequiredActionMetadata({ runId: 'run_1' })).toBe(false);
    });

    test('returns false when runId is missing', () => {
      expect(validateRequiredActionMetadata({ threadId: 'thread_1' })).toBe(false);
    });

    test('returns true when threadId and runId are provided', () => {
      expect(validateRequiredActionMetadata({ threadId: 'thread_1', runId: 'run_1' })).toBe(true);
    });
  });

  describe('buildToolsAndChoice', () => {
    test('defaults options when omitted', () => {
      const result = buildToolsAndChoice(
        [
          {
            name: 'echo.text',
            description: 'Echo text back',
            parametersJsonSchema: { type: 'object', properties: {} }
          }
        ] as any,
        undefined
      );

      expect(result.sdkToolChoice).toBeUndefined();
      expect(result.sdkTools).toHaveLength(1);
      expect(result.sdkTools[0]).toMatchObject({
        type: 'function',
        function: { name: 'echo.text' }
      });
    });
  });
});

