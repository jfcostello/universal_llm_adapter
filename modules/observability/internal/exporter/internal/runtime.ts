import { createHash } from 'crypto';

import type { PluginRegistry } from '../../../../../kernel/index.js';
import { getDefaults } from '../../../../../kernel/index.js';

import type { ObservabilityExporterConfig } from './config.js';
import { ObservabilityExporter } from './exporter.js';
import { clampInt } from '../../../../shared/index.js';

const OBSERVABILITY_RUNTIME_SYMBOL = Symbol.for('llm_adapter_observability_runtime');
const DEFAULT_MAX_EXPORTERS_PER_REGISTRY = 10;

type RegistryRuntime = {
  exportersByKey: Map<string, ObservabilityExporter>;
  inflightByKey: Map<string, Promise<ObservabilityExporter>>;
  maxExporters: number;
};

const runtimeByRegistry = new WeakMap<object, RegistryRuntime>();
const registryRefByRegistry = new WeakMap<object, WeakRef<object>>();
const runtimeRegistryRefs = new Set<WeakRef<object>>();
const providerConfigHashCache = new WeakMap<object, string>();

let shutdownAllPromise: Promise<void> | null = null;

export function ensureRuntimeHookInstalled(): void {
  const globalAny = globalThis as any;
  if (globalAny[OBSERVABILITY_RUNTIME_SYMBOL]) return;
  globalAny[OBSERVABILITY_RUNTIME_SYMBOL] = { shutdownAll: shutdownAllExporters };
}

function getOrCreateRegistryRuntime(registry: object): RegistryRuntime {
  const existing = runtimeByRegistry.get(registry);
  if (existing) {
    trackRegistry(registry);
    return existing;
  }

  const created: RegistryRuntime = {
    exportersByKey: new Map(),
    inflightByKey: new Map(),
    maxExporters: DEFAULT_MAX_EXPORTERS_PER_REGISTRY
  };

  runtimeByRegistry.set(registry, created);
  trackRegistry(registry);
  return created;
}

function trackRegistry(registry: object): void {
  const existing = registryRefByRegistry.get(registry);
  if (existing) {
    // shutdownAllExporters() clears the ref set but keeps weak-map entries;
    // re-add tracked refs so subsequent shutdown calls still see this registry.
    runtimeRegistryRefs.add(existing);
    return;
  }

  if (runtimeRegistryRefs.size > 1000) {
    for (const ref of runtimeRegistryRefs) {
      if (!ref.deref()) runtimeRegistryRefs.delete(ref);
    }
  }

  const ref = new WeakRef(registry);
  registryRefByRegistry.set(registry, ref);
  runtimeRegistryRefs.add(ref);
}

function stableSortForKey(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[function]';

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map(entry => stableSortForKey(entry, seen));
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = stableSortForKey(record[key], seen);
  }
  return out;
}

function stableStringifyForKey(value: unknown): string {
  try {
    return JSON.stringify(stableSortForKey(value, new WeakSet()));
  } catch {
    return JSON.stringify(String(value));
  }
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getProviderConfigHash(providerConfig: unknown): string {
  if (providerConfig === null || providerConfig === undefined) return 'no_provider_config';

  if (typeof providerConfig !== 'object') {
    return hashKey(stableStringifyForKey(providerConfig));
  }

  const cached = providerConfigHashCache.get(providerConfig);
  if (cached) return cached;

  const hash = hashKey(stableStringifyForKey(providerConfig));
  providerConfigHashCache.set(providerConfig, hash);
  return hash;
}

function buildExporterCacheKey(config: ObservabilityExporterConfig): string {
  const providerConfigHash = getProviderConfigHash(config.providerConfig);
  return [
    String(config.provider),
    String(config.flushAt),
    String(config.flushIntervalMs),
    String(config.maxQueueSize),
    String(config.maxAttempts),
    String(config.baseDelayMs),
    String(config.maxDelayMs),
    String(config.timeoutMs),
    String(config.maxAttributeValueBytes),
    providerConfigHash
  ].join('|');
}

function enforceExporterCacheBound(runtime: RegistryRuntime): void {
  while (runtime.exportersByKey.size > runtime.maxExporters) {
    const oldestKey = runtime.exportersByKey.keys().next().value as string;

    const exporter = runtime.exportersByKey.get(oldestKey);
    runtime.exportersByKey.delete(oldestKey);

    void exporter?.shutdown().catch(() => {});
  }
}

export async function getOrCreateSharedExporter(
  registry: PluginRegistry,
  config: ObservabilityExporterConfig
): Promise<ObservabilityExporter> {
  const runtime = getOrCreateRegistryRuntime(registry as unknown as object);
  const key = buildExporterCacheKey(config);

  const cached = runtime.exportersByKey.get(key);
  if (cached) {
    runtime.exportersByKey.delete(key);
    runtime.exportersByKey.set(key, cached);
    return cached;
  }

  const inflight = runtime.inflightByKey.get(key);
  if (inflight) return inflight;

  const createPromise = (async () => {
    const manifest = await registry.getObservabilityProvider(config.provider);
    const compat = typeof (registry as any).getObservabilityCompatForProvider === 'function'
      ? await (registry as any).getObservabilityCompatForProvider(manifest.id)
      : await registry.getObservabilityCompat(manifest.compat);

    const exporter = new ObservabilityExporter(config, compat, manifest);
    runtime.exportersByKey.set(key, exporter);
    runtime.inflightByKey.delete(key);
    enforceExporterCacheBound(runtime);
    return exporter;
  })();

  runtime.inflightByKey.set(key, createPromise);

  try {
    return await createPromise;
  } finally {
    runtime.inflightByKey.delete(key);
  }
}

export async function shutdownAllExporters(): Promise<void> {
  if (shutdownAllPromise) return shutdownAllPromise;

  shutdownAllPromise = (async () => {
    const shutdownTimeoutMs = clampInt(getDefaults().observability.shutdownTimeoutMs, 5000, 0, 300_000);

    const registries: object[] = [];
    for (const ref of runtimeRegistryRefs) {
      const registry = ref.deref();
      if (!registry) continue;
      registries.push(registry);
    }

    const exporters: ObservabilityExporter[] = [];
    for (const registry of registries) {
      const runtime = runtimeByRegistry.get(registry);
      if (!runtime) continue;
      for (const exporter of runtime.exportersByKey.values()) {
        exporters.push(exporter);
      }
      runtime.exportersByKey.clear();
      runtime.inflightByKey.clear();
    }

    if (shutdownTimeoutMs <= 0) {
      for (const exporter of exporters) {
        exporter.setShutdownSignal(undefined);
      }
      await Promise.all(exporters.map(exp => Promise.resolve().then(() => exp.shutdown()).catch(() => {})));
      runtimeRegistryRefs.clear();
      return;
    }

    const abortController = new AbortController();
    for (const exporter of exporters) {
      exporter.setShutdownSignal(abortController.signal);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>(resolve => {
      timeoutId = setTimeout(() => {
        for (const exporter of exporters) {
          exporter.logShutdownSummary({ timedOut: true, shutdownTimeoutMs });
        }
        try {
          abortController.abort();
        } catch {
          // ignore
        }
        resolve('timeout');
      }, shutdownTimeoutMs);
      (timeoutId as any)?.unref?.();
    });

    const shutdownPromise = Promise.all(
      exporters.map(exp => Promise.resolve().then(() => exp.shutdown()).catch(() => {}))
    ).then(() => 'ok' as const);

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    runtimeRegistryRefs.clear();
  })().finally(() => {
    shutdownAllPromise = null;
  });

  return shutdownAllPromise;
}
