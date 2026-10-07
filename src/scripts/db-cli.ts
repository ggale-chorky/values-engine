import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseError } from '../db/database.js';
import { DataError } from '../db/rows.js';
export { configuredClient } from '../runtime/server-config.js';

export function isMain(url: string): boolean {
  return Boolean(process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href);
}

export function reportCliError(error: unknown) {
  console.error(error instanceof DataError || error instanceof DatabaseError
    ? error.message : 'Database command failed. No request details or credentials are logged.');
  process.exitCode = 1;
}
