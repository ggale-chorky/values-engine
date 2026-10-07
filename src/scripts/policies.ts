import { createPolicyCreator } from '../policies/creation.js';
import type { PolicyCreator } from '../policies/creation.js';
import { parseArgs } from 'node:util';
import { createReadDatabase } from '../db/database.js';
import type { ReadDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { createPolicy, listPolicies, validatePolicyInput } from '../policies/service.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[], dependencies: {
  read?: () => Promise<ReadDatabase>;
  write?: () => Promise<PolicyCreator>;
  log?: (text: string) => void;
} = {}) {
  const [command, ...rest] = args;
  let result;
  if (command === 'create') {
    const { values } = parseArgs({ args: rest, strict: true, options: { name: { type: 'string' }, 'max-gender-pay-gap': { type: 'string' } } });
    validatePolicyInput(values.name ?? '', values['max-gender-pay-gap'] ?? '');
    const db = await (dependencies.write ?? (async () => createPolicyCreator(await configuredClient())))();
    result = await createPolicy(db, values.name!, values['max-gender-pay-gap']!);
  } else if (command === 'list') {
    parseArgs({ args: rest, strict: true, options: {} });
    const db = await (dependencies.read ?? (async () => createReadDatabase(await configuredClient())))();
    result = await listPolicies(db);
  } else throw new DataError('Expected policy:create or policy:list.');
  (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
