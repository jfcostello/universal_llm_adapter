import fs from 'fs';
import path from 'path';
import type { LLMCallSpec } from '../../../../kernel/index.js';

export interface ServerPolicyConfig {
  documents?: {
    filepath?: {
      enabled?: boolean;
      allowedRoots?: string[];
    };
  };
  telemetry?: {
    observabilityOverride?: {
      enabled?: boolean;
      allowlist?: string[];
    };
  };
}

export interface NormalizedServerPolicy {
  documents: {
    filepath: {
      enabled: boolean;
      allowedRoots: string[];
    };
  };
  telemetry: {
    observabilityOverride: {
      enabled: boolean;
      allowlist: string[];
    };
  };
}

export function normalizeServerPolicy(config: ServerPolicyConfig | undefined): NormalizedServerPolicy {
  const enabled = Boolean(config?.documents?.filepath?.enabled);
  const rootsRaw = config?.documents?.filepath?.allowedRoots;
  const allowedRoots = Array.isArray(rootsRaw)
    ? rootsRaw.map(r => String(r).trim()).filter(Boolean)
    : [];
  const observabilityOverrideEnabled = Boolean(config?.telemetry?.observabilityOverride?.enabled);
  const telemetryAllowlistRaw = config?.telemetry?.observabilityOverride?.allowlist;
  const observabilityOverrideAllowlist = Array.isArray(telemetryAllowlistRaw)
    ? Array.from(new Set(telemetryAllowlistRaw.map(k => String(k).trim()).filter(Boolean)))
    : [];

  return {
    documents: {
      filepath: { enabled, allowedRoots }
    },
    telemetry: {
      observabilityOverride: {
        enabled: observabilityOverrideEnabled,
        allowlist: observabilityOverrideAllowlist
      }
    }
  };
}

function makePolicyError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'policy_violation';
  return error;
}

function realpathSyncSafe(value: string): string {
  return fs.realpathSync(value);
}

function isWithinAllowedRoots(options: {
  filePath: string;
  allowedRoots: string[];
  cwd: string;
  rootRealpathCache: Map<string, string>;
}): boolean {
  const roots = options.allowedRoots.length > 0 ? options.allowedRoots : [options.cwd];
  const absoluteFilePath = path.resolve(options.cwd, options.filePath);
  let realFilePath: string;
  try {
    realFilePath = realpathSyncSafe(absoluteFilePath);
  } catch {
    throw makePolicyError('Invalid filepath document source: path does not exist');
  }

  for (const rootRaw of roots) {
    const absoluteRoot = path.resolve(options.cwd, rootRaw);
    let realRoot = options.rootRealpathCache.get(absoluteRoot);
    if (!realRoot) {
      try {
        realRoot = realpathSyncSafe(absoluteRoot);
      } catch {
        throw makePolicyError('Invalid filepath policy allowedRoots entry');
      }
      options.rootRealpathCache.set(absoluteRoot, realRoot);
    }

    const rel = path.relative(realRoot, realFilePath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return true;
    }
  }

  return false;
}

export function assertLlmSpecAllowedByPolicy(
  spec: LLMCallSpec,
  policy: NormalizedServerPolicy,
  options: { cwd?: string } = {}
): void {
  const cwd = options.cwd ?? process.cwd();
  const filepathPolicy = policy.documents.filepath;
  const rootRealpathCache = new Map<string, string>();

  for (const msg of spec.messages ?? []) {
    const parts = Array.isArray((msg as any)?.content) ? (msg as any).content : [];
    for (const part of parts) {
      if (part?.type !== 'document') continue;
      if (part?.source?.type !== 'filepath') continue;

      if (!filepathPolicy.enabled) {
        throw makePolicyError(
          'Filepath document sources are disabled by server policy. Use base64 documents or enable server.policy.documents.filepath.enabled.'
        );
      }

      const filePath = String(part?.source?.path ?? '');
      if (!filePath) {
        throw makePolicyError('Invalid filepath document source: missing path');
      }

      if (
        !isWithinAllowedRoots({
          filePath,
          allowedRoots: filepathPolicy.allowedRoots,
          cwd,
          rootRealpathCache
        })
      ) {
        throw makePolicyError('Filepath document source is outside of allowedRoots');
      }
    }
  }
}
