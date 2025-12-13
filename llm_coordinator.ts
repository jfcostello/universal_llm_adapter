#!/usr/bin/env node

import * as path from 'path';
import { pathToFileURL } from 'url';
import { runLlmCoordinatorCli } from './modules/cli/index.js';

// Legacy shim: keep old exports stable while migrating to `modules/cli`.
export type { LlmCliDependencies as CliDependencies } from './modules/cli/index.js';
export {
  createLlmCoordinatorProgram as createProgram,
  runLlmCoordinatorCli as runCli
} from './modules/cli/index.js';

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runLlmCoordinatorCli(process.argv);
}
