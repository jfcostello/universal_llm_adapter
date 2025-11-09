import { handle } from '@/plugins/modules/test-echo.ts';

describe('plugins/modules/test-echo', () => {
  test('echoes back the provided message', () => {
    const result = handle({ args: { message: 'Hello World' } });
    expect(result.result).toBe('[R:11]dlroW olleH');
  });

  test('echoes back string with spaces', () => {
    const result = handle({ args: { message: ' ' } });
    expect(result.result).toBe('[R:1] ');
  });

  test('throws when message is missing', () => {
    expect(() => handle({ args: {} })).toThrow('test.echo requires message argument of type string');
  });

  test('throws when message is not a string', () => {
    expect(() => handle({ args: { message: 123 as any } })).toThrow('test.echo requires message argument of type string');
  });
});
