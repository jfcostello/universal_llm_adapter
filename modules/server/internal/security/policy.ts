import path from 'path';
import type { LLMCallSpec } from '../../../../kernel/index.js';

export interface ServerPolicyConfig {
  documents?: {
    filepath?: {
      enabled?: boolean;
      allowedRoots?: string[];
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
}

export function normalizeServerPolicy(config: ServerPolicyConfig | undefined): NormalizedServerPolicy {
  const enabled = Boolean(config?.documents?.filepath?.enabled);
  const rootsRaw = config?.documents?.filepath?.allowedRoots;
  const allowedRoots = Array.isArray(rootsRaw)
    ? rootsRaw.map(r => String(r).trim()).filter(Boolean)
    : [];

  return {
    documents: {
      filepath: { enabled, allowedRoots }
    }
  };
}

function makePolicyError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
  (error as any).code = 'policy_violation';
  return error;
}

function isWithinAllowedRoots(options: { filePath: string; allowedRoots: string[]; cwd: string }): boolean {
  if (options.allowedRoots.length === 0) return true;
  const absoluteFilePath = path.resolve(options.cwd, options.filePath);

  for (const rootRaw of options.allowedRoots) {
    const absoluteRoot = path.resolve(options.cwd, rootRaw);
    const rel = path.relative(absoluteRoot, absoluteFilePath);
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
          cwd
        })
      ) {
        throw makePolicyError('Filepath document source is outside of allowedRoots');
      }
    }
  }
}

