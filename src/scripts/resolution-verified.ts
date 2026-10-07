import { DataError } from '../db/rows.js';
import { listVerifiedRelationships } from '../review/verified-relationships.js';
import type { VerifiedRelationship } from '../review/verified-relationships.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

/** Import is inert; configuration and read-only queries run only on invocation. */
export async function main(args: string[], dependencies: {
  read?: () => Promise<VerifiedRelationship[]>;
  log?: (text: string) => void;
} = {}) {
  if (args.length) throw new DataError('Usage: npm run resolution:verified (no arguments).');
  const rows = await (dependencies.read ?? (async () => listVerifiedRelationships(await configuredClient())))();
  for (const row of rows) (dependencies.log ?? console.log)(JSON.stringify(row));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
