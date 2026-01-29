import { resolveToolRoutingHints } from '@/modules/tools/index.ts';

describe('resolveToolRoutingHints', () => {
  test('returns undefined hints when no inputs provided', () => {
    expect(resolveToolRoutingHints({ toolName: 'test.echo' })).toEqual({
      toolId: undefined,
      processRouteId: undefined
    });
  });

  test('trims tool id and processRouteId from tool definition', () => {
    expect(
      resolveToolRoutingHints({
        toolName: 'test.echo',
        toolDef: { id: '  tool-123  ', processRouteId: '  route-a  ' } as any
      })
    ).toEqual({
      toolId: 'tool-123',
      processRouteId: 'route-a'
    });
  });

  test('runtime route override by name wins over id + tool definition', () => {
    expect(
      resolveToolRoutingHints({
        toolName: 'test.echo',
        toolDef: { id: 'tool-123', processRouteId: 'route-tool' } as any,
        toolRouting: {
          routesByName: { 'test.echo': ' route-runtime-name ' },
          routesById: { 'tool-123': 'route-runtime-id' }
        }
      })
    ).toEqual({
      toolId: 'tool-123',
      processRouteId: 'route-runtime-name'
    });
  });

  test('runtime route override by id wins over tool definition', () => {
    expect(
      resolveToolRoutingHints({
        toolName: 'test.echo',
        toolDef: { id: 'tool-123', processRouteId: 'route-tool' } as any,
        toolRouting: { routesById: { 'tool-123': ' route-runtime-id ' } }
      })
    ).toEqual({
      toolId: 'tool-123',
      processRouteId: 'route-runtime-id'
    });
  });

  test('treats blank routing strings as absent (trim-aware)', () => {
    expect(
      resolveToolRoutingHints({
        toolName: 'test.echo',
        toolDef: { id: '   ', processRouteId: '  ' } as any,
        toolRouting: {
          routesByName: { 'test.echo': '   ' },
          routesById: { 'tool-123': '   ' }
        }
      })
    ).toEqual({
      toolId: undefined,
      processRouteId: undefined
    });
  });

  test('treats non-string toolName as empty string', () => {
    expect(
      resolveToolRoutingHints({
        toolName: 123 as any,
        toolDef: { id: 'tool-123', processRouteId: 'route-a' } as any
      })
    ).toEqual({
      toolId: 'tool-123',
      processRouteId: 'route-a'
    });
  });
});
