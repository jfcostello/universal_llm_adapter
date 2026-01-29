import { jest } from '@jest/globals';

import type { RealtimeCompatSession, RealtimeEvent } from '@/kernel/index.ts';
import { RealtimeToolHandler } from '@/modules/realtime/internal/realtime-session/internal/tool-handler.ts';

describe('realtime tool routing', () => {
  function makeCompat(overrides: Partial<RealtimeCompatSession> = {}): RealtimeCompatSession {
    return {
      sendText: jest.fn(),
      injectContext: jest.fn(),
      sendAudio: jest.fn(),
      commit: jest.fn(),
      interrupt: jest.fn(),
      sendToolResult: jest.fn(),
      close: jest.fn(),
      events: async function* () {},
      ...overrides
    };
  }

  test('passes toolRouting overrides and tool definition routing hints to the coordinator', async () => {
    const compat = makeCompat();
    const pushEvent = jest.fn<(e: RealtimeEvent) => void>();

    const handler = new RealtimeToolHandler({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        toolRouting: {
          routesByName: { echo: 'route-runtime-name' },
          routesById: { 'tool-123': 'route-runtime-id' }
        },
        metadata: { testKey: 'testValue' }
      } as any,
      tools: [{ name: 'echo', id: 'tool-123', processRouteId: 'route-tool' }] as any,
      compatSession: compat,
      pushEvent,
      closeOnError: jest.fn()
    } as any);

    const coordinator = { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) };
    (handler as any).toolCoordinatorPromise = Promise.resolve(coordinator);

    await handler.handleToolCallEnd({
      type: 'tool_call.end',
      toolCallId: 'c1',
      name: 'echo',
      arguments: { text: 'Tokyo' }
    } as any);

    expect(coordinator.routeAndInvoke).toHaveBeenCalledWith(
      'echo',
      'c1',
      { text: 'Tokyo' },
      expect.objectContaining({
        provider: 'p',
        model: 'm',
        metadata: { testKey: 'testValue' },
        toolId: 'tool-123',
        processRouteId: 'route-runtime-name'
      })
    );
  });

  test('uses toolRouting.routesById when no routesByName mapping exists', async () => {
    const compat = makeCompat();
    const pushEvent = jest.fn<(e: RealtimeEvent) => void>();

    const handler = new RealtimeToolHandler({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        toolRouting: { routesById: { 'tool-123': 'route-runtime-id' } }
      } as any,
      tools: [{ name: 'echo', id: 'tool-123', processRouteId: 'route-tool' }] as any,
      compatSession: compat,
      pushEvent,
      closeOnError: jest.fn()
    } as any);

    const coordinator = { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) };
    (handler as any).toolCoordinatorPromise = Promise.resolve(coordinator);

    await handler.handleToolCallEnd({
      type: 'tool_call.end',
      toolCallId: 'c1',
      name: 'echo',
      arguments: { text: 'Tokyo' }
    } as any);

    expect(coordinator.routeAndInvoke).toHaveBeenCalledWith(
      'echo',
      'c1',
      { text: 'Tokyo' },
      expect.objectContaining({
        toolId: 'tool-123',
        processRouteId: 'route-runtime-id'
      })
    );
  });

  test('treats blank routing strings as absent (trim-aware)', async () => {
    const compat = makeCompat();
    const pushEvent = jest.fn<(e: RealtimeEvent) => void>();

    const handler = new RealtimeToolHandler({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        toolRouting: { routesById: { 'tool-123': '   ' } }
      } as any,
      tools: [{ name: 'echo', id: 'tool-123', processRouteId: '   ' }] as any,
      compatSession: compat,
      pushEvent,
      closeOnError: jest.fn()
    } as any);

    const coordinator = { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) };
    (handler as any).toolCoordinatorPromise = Promise.resolve(coordinator);

    await handler.handleToolCallEnd({
      type: 'tool_call.end',
      toolCallId: 'c1',
      name: 'echo',
      arguments: { text: 'Tokyo' }
    } as any);

    expect(coordinator.routeAndInvoke).toHaveBeenCalledWith(
      'echo',
      'c1',
      { text: 'Tokyo' },
      expect.objectContaining({
        toolId: 'tool-123',
        processRouteId: undefined
      })
    );
  });

  test('treats blank tool ids as absent and falls back to other routing', async () => {
    const compat = makeCompat();
    const pushEvent = jest.fn<(e: RealtimeEvent) => void>();

    const handler = new RealtimeToolHandler({
      registry: { getProcessRoutes: jest.fn().mockResolvedValue([]) },
      spec: {
        provider: 'p',
        model: 'm',
        functionToolNames: ['echo'],
        toolRouting: { routesById: { 'tool-123': 'route-runtime-id' } }
      } as any,
      tools: [{ name: 'echo', id: '   ', processRouteId: 'route-tool' }] as any,
      compatSession: compat,
      pushEvent,
      closeOnError: jest.fn()
    } as any);

    const coordinator = { routeAndInvoke: jest.fn().mockResolvedValue({ result: { ok: true } }) };
    (handler as any).toolCoordinatorPromise = Promise.resolve(coordinator);

    await handler.handleToolCallEnd({
      type: 'tool_call.end',
      toolCallId: 'c1',
      name: 'echo',
      arguments: { text: 'Tokyo' }
    } as any);

    expect(coordinator.routeAndInvoke).toHaveBeenCalledWith(
      'echo',
      'c1',
      { text: 'Tokyo' },
      expect.objectContaining({
        toolId: undefined,
        processRouteId: 'route-tool'
      })
    );
  });
});
