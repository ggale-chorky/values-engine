import { parseArgs } from 'node:util';
import { createReadDatabase } from '../db/database.js';
import type { ReadDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { evaluateBrandFromDb } from '../evaluation/evaluate-brand-from-db.js';
import { selectPolicy } from '../policies/service.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[], dependencies: {
  read?: () => Promise<ReadDatabase>;
  now?: () => Date;
  log?: (text: string) => void;
} = {}) {
  const { values } = parseArgs({ args, strict: true, options: { brand: { type: 'string' }, policy: { type: 'string' } } });
  if (!values.brand?.trim()) throw new DataError('Usage: npm run policy:evaluate-brand -- --brand "<brand name>"');
  if (values.policy !== undefined && !values.policy.trim()) throw new DataError('Policy name or UUID is required.');
  const db = await (dependencies.read ?? (async () => createReadDatabase(await configuredClient())))();
  const policy = values.policy === undefined ? undefined : await selectPolicy(db, values.policy);
  const result = await evaluateBrandFromDb(db, values.brand, (dependencies.now ?? (() => new Date()))().toISOString().slice(0, 10), policy);
  (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
