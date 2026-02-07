interface NoopTerminalContext {
  toolName?: string;
  args?: unknown;
}

export async function handle(_ctx: NoopTerminalContext): Promise<{ result: { ok: true } }> {
  return { result: { ok: true } };
}
