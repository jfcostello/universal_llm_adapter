export async function handle(ctx) {
  return {
    result: {
      echoed: ctx.args?.text ?? '',
      provider: ctx.provider,
      model: ctx.model,
      metadata: ctx.metadata || null
    }
  };
}

export default handle;
