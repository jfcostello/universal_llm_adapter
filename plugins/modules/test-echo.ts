/**
 * Test echo tool handler for live integration tests.
 * Returns the message reversed with a length prefix to ensure
 * LLMs must read actual tool results rather than guessing output.
 */

interface EchoContext {
  args: {
    message?: string;
  };
}

export function handle(ctx: EchoContext): { result: string } {
  const message = ctx.args.message;

  if (!message || typeof message !== 'string') {
    throw new Error('test.echo requires message argument of type string');
  }

  // Return format: [R:length]reversed_message
  // This makes it impossible for LLMs to fake tool results without reading them
  const reversed = message.split('').reverse().join('');
  return { result: `[R:${message.length}]${reversed}` };
}
