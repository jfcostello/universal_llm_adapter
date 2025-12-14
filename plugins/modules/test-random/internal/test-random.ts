/**
 * Test Random Number Generator
 *
 * Generates a random number within a specified range for testing tool call chaining.
 * Returns unpredictable values that the LLM cannot anticipate, ensuring it must
 * use the actual tool response in subsequent tool calls.
 */

export function handle(ctx: { args: { min?: number; max?: number } }) {
  const min = ctx.args.min ?? 0;
  const max = ctx.args.max ?? 1000000;
  const randomValue = Math.floor(Math.random() * (max - min + 1)) + min;

  return {
    randomValue,
    timestamp: Date.now()
  };
}
