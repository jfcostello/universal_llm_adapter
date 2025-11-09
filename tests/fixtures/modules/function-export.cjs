function handler(ctx) {
  return { result: { via: 'module-fallback', tool: ctx.toolName } };
}

handler.default = undefined;
module.exports = handler;
