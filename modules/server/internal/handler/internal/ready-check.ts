import fs from 'fs';
import path from 'path';

export function createReadyChecker(pluginsPath: string): { checkReady: () => Promise<boolean> } {
  const resolvedPluginsPath = path.isAbsolute(pluginsPath)
    ? pluginsPath
    : path.resolve(process.cwd(), pluginsPath);
  const READY_CACHE_TTL_MS = 1000;
  let readyCache: { ok: boolean; checkedAtMs: number } | undefined;

  async function checkReady(): Promise<boolean> {
    const now = Date.now();
    if (readyCache && now - readyCache.checkedAtMs < READY_CACHE_TTL_MS) {
      return readyCache.ok;
    }

    let ok = false;
    try {
      await fs.promises.access(resolvedPluginsPath);
      ok = true;
    } catch {
      ok = false;
    }

    readyCache = { ok, checkedAtMs: now };
    return ok;
  }

  return { checkReady };
}
