import { jest } from '@jest/globals';
import { Role } from '@/kernel/index.ts';

describe('LLMCoordinator.handleTools — tool call name robustness', () => {
  test('tolerates tool call objects without a string name', async () => {
    jest.resetModules();

    await jest.isolateModulesAsync(async () => {
      const routeAndInvoke = jest.fn(async () => ({ result: { ok: true } }));

      jest.unstable_mockModule('../../../modules/tools/index.js', () => ({
        runToolLoop: async (options: any) => {
          await options.invokeTool(
            'echo',
            { id: 'c1', arguments: { text: 'Tokyo' } } as any,
            { provider: 'p', model: 'm', metadata: {}, logger: undefined, callProgress: undefined }
          );
          return options.initialResponse;
        },
        resolveToolRoutingHints: () => ({ toolId: undefined, processRouteId: undefined })
      }));

      const { LLMCoordinator } = await import('@/modules/llm/index.ts');

      const coordinator = new (LLMCoordinator as any)({} as any);
      (coordinator as any).toolCoordinator = { routeAndInvoke };

      const response = {
        provider: 'p',
        model: 'm',
        role: Role.ASSISTANT,
        content: [{ type: 'text', text: 'tool time' }],
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'Tokyo' } }]
      } as any;

      await (coordinator as any).handleTools(
        { settings: {}, metadata: {} } as any,
        {},
        {},
        { id: 'p' } as any,
        'm',
        [],
        [{ name: 'echo', description: 'Echo', parametersJsonSchema: { type: 'object' } }] as any,
        response,
        { info: jest.fn() } as any,
        {},
        {}
      );

      expect(routeAndInvoke).toHaveBeenCalledWith(
        'echo',
        'c1',
        { text: 'Tokyo' },
        expect.objectContaining({ provider: 'p', model: 'm' })
      );
    });
  });
});

