import { parseArgs } from 'node:util';
import { createReadDatabase } from '../db/database.js';
import type { ReadDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { evaluateBrandDecision } from '../decision/evaluate-brand-decision.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[], dependencies: {
  read?: () => Promise<ReadDatabase>;
  now?: () => Date;
  log?: (text: string) => void;
} = {}) {
  const { values } = parseArgs({ args, strict: true, options: { brand: { type: 'string' }, policy: { type: 'string' } } });
  if (!values.brand?.trim() || !values.policy?.trim()) throw new DataError('Usage: npm run decision:brand -- --brand "<brand>" --policy "<name-or-id>"');
  const db = await (dependencies.read ?? (async () => createReadDatabase(await configuredClient())))();
  const result = await evaluateBrandDecision({ brand: values.brand, policy: values.policy },
    { db, asOf: (dependencies.now ?? (() => new Date()))().toISOString().slice(0, 10) });
  (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
