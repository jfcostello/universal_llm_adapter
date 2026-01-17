import type { UnifiedCliDependencies } from './deps.js';

export type WriteStructuredError = (error: any) => Promise<void>;

export interface UnifiedCliContext {
  deps: UnifiedCliDependencies;
  writeStructuredError: WriteStructuredError;
}

