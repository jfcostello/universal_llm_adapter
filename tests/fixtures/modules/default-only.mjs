export default async function defaultOnly(ctx) {
  return { result: { via: 'default', callId: ctx.callId } };
}
