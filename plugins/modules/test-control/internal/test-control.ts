function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, Math.floor(ms));
  if (!delayMs) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

type ToolControlArgs = {
  override?: boolean | string | null;
  sleepMs?: number;
};

interface ToolControlContext {
  toolName: string;
  args: ToolControlArgs;
  abortSignal?: AbortSignal;
}

export async function handle(ctx: ToolControlContext): Promise<any> {
  const sleepMsRaw = ctx.args?.sleepMs;
  const sleepMs = typeof sleepMsRaw === 'number' && Number.isFinite(sleepMsRaw) ? sleepMsRaw : 0;
  if (sleepMs > 0) {
    await sleep(sleepMs, ctx.abortSignal);
  }

  const override = ctx.args?.override;

  return {
    result: {
      tool: ctx.toolName,
      tool_type_response_override_terminal: override,
      sleptMs: sleepMs
    }
  };
}

