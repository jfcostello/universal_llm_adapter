export async function handle(ctx) {
  if (!ctx.args || typeof ctx.args.value !== 'number') {
    throw new Error('value parameter must be a number');
  }
  return { result: { doubled: ctx.args.value * 2 } };
}

export default handle;
