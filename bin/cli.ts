#!/usr/bin/env node
/**
 * Unified CLI entry point for LLM Adapter.
 *
 * This is a thin shell that only imports commander when the unified CLI
 * is invoked. All other imports happen dynamically inside action handlers
 * to ensure strict lazy loading.
 */

import * as path from 'path';
import { pathToFileURL } from 'url';
import { runUnifiedCli } from '../index.js';

export { runUnifiedCli } from '../index.js';
export type { UnifiedCliDependencies } from '../index.js';

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runUnifiedCli(process.argv);
}
