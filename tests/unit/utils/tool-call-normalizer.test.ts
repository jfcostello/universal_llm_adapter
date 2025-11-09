import { normalizeToolCalls } from '@/utils/tools/tool-call-normalizer.ts';
import { ToolCall } from '@/core/types.ts';

describe('utils/tools/tool-call-normalizer', () => {
  test('mirrors arguments onto args alias when missing', () => {
    const calls: ToolCall[] = [
      {
        id: 'call-1',
        name: 'test.echo',
        arguments: { message: 'hello' }
      }
    ];

    const normalized = normalizeToolCalls(calls);

    expect(normalized).toBeDefined();
    expect(normalized?.[0].arguments).toEqual({ message: 'hello' });
    expect(normalized?.[0].args).toEqual({ message: 'hello' });
  });

  test('preserves existing args reference to avoid duplication', () => {
    const argsRef = { message: 'world' };
    const call: ToolCall = {
      id: 'call-2',
      name: 'test.echo',
      arguments: argsRef,
      args: argsRef
    };

    const normalized = normalizeToolCalls([call]);
    expect(normalized?.[0]).toBe(call);
    expect(normalized?.[0].arguments).toBe(argsRef);
    expect(normalized?.[0].args).toBe(argsRef);
  });

  test('adds arguments when only args alias provided', () => {
    const argsRef = { payload: 'value' };
    const calls = [
      {
        id: 'call-3',
        name: 'test.echo',
        // Intentionally omit arguments to simulate legacy shape
        args: argsRef
      } as unknown as ToolCall
    ];

    const normalized = normalizeToolCalls(calls);
    expect(normalized?.[0].args).toBe(argsRef);
    expect(normalized?.[0].arguments).toBe(argsRef);
  });

  test('returns original value when no tool calls provided', () => {
    expect(normalizeToolCalls(undefined)).toBeUndefined();
    expect(normalizeToolCalls([])).toEqual([]);
  });

  test('defaults missing arguments to empty object', () => {
    const calls = [
      {
        id: 'call-4',
        name: 'test.echo'
        // both arguments and args intentionally omitted
      } as unknown as ToolCall
    ];

    const normalized = normalizeToolCalls(calls);
    expect(normalized?.[0].arguments).toEqual({});
    expect(normalized?.[0].args).toEqual({});
  });
});
