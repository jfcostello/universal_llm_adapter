import fs from 'fs';
import path from 'path';

import { ToolExecutionError, type ProcessRouteManifest } from '../../../../../kernel/index.js';

function looksLikeFilePath(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('file:');
}

function warnInvokeModuleCwdFallback(
  warnedInvokeModuleCwdFallback: Set<string>,
  route: ProcessRouteManifest,
  moduleSpecifier: string,
  resolvedPath: string,
  source: any
): void {
  if (warnedInvokeModuleCwdFallback.has(route.id)) return;
  warnedInvokeModuleCwdFallback.add(route.id);

  try {
    console.warn('process_route.invoke_module.cwd_fallback', {
      routeId: route.id,
      module: moduleSpecifier,
      resolvedPath,
      source: {
        kind: typeof source?.kind === 'string' ? source.kind : undefined,
        root: typeof source?.root === 'string' ? source.root : undefined,
        filePath: typeof source?.filePath === 'string' ? source.filePath : undefined,
        precedence: typeof source?.precedence === 'number' ? source.precedence : undefined
      }
    });
  } catch {}
}

export function resolveInvokeModulePath(options: {
  registry?: any;
  route: ProcessRouteManifest;
  moduleSpecifier: string;
  warnedInvokeModuleCwdFallback: Set<string>;
}): string {
  const raw = String(options.moduleSpecifier);

  if (raw.startsWith('file:') || raw.startsWith('node:') || path.isAbsolute(raw)) {
    return raw;
  }

  const source = options.registry?.getManifestSource?.('processes', options.route.id);
  if (source) {
    const manifestFilePath = typeof (source as any).filePath === 'string' ? String((source as any).filePath) : '';
    const packRoot = typeof (source as any).root === 'string' ? String((source as any).root) : '';

    const candidates: Array<{ kind: 'manifestDir' | 'packRoot' | 'cwd'; value: string }> = [];
    if (manifestFilePath) {
      candidates.push({ kind: 'manifestDir', value: path.resolve(path.dirname(manifestFilePath), raw) });
    }
    if (packRoot) {
      candidates.push({ kind: 'packRoot', value: path.resolve(packRoot, raw) });
    }
    candidates.push({ kind: 'cwd', value: path.resolve(process.cwd(), raw) });

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.value)) continue;
      if (candidate.kind === 'cwd') {
        warnInvokeModuleCwdFallback(
          options.warnedInvokeModuleCwdFallback,
          options.route,
          raw,
          candidate.value,
          source
        );
      }
      return candidate.value;
    }

    if (!looksLikeFilePath(raw)) {
      return raw;
    }

    throw new ToolExecutionError(
      `Module route '${options.route.id}' could not resolve module '${raw}'. Tried: ${candidates.map(c => c.value).join(', ')}`
    );
  }

  if (raw.startsWith('.')) {
    return path.resolve(process.cwd(), raw);
  }
  return raw;
}
