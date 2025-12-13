#!/usr/bin/env node

import * as path from 'path';
import { pathToFileURL } from 'url';
import { runVectorStoreCoordinatorCli } from '../../modules/cli/index.js';

export type { VectorCliDependencies as CliDependencies } from '../../modules/cli/index.js';
export {
  createVectorStoreCoordinatorProgram as createProgram,
  runVectorStoreCoordinatorCli as runCli
} from '../../modules/cli/index.js';

const isEntryPoint = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);

export const __isEntryPoint = isEntryPoint;

if (isEntryPoint) {
  void runVectorStoreCoordinatorCli(process.argv);
}

