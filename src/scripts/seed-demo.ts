import { createReadDatabase, createWriteDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { planDemoSeed, seedDemo } from '../demo/seed.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[]) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dry-run')) throw new DataError('Usage: npm run demo:seed -- [--dry-run]');
  const dryRun = args[0] === '--dry-run';
  const client = await configuredClient();
  const now = new Date().toISOString();
  const plan = dryRun ? await planDemoSeed(createReadDatabase(client), now) : await seedDemo(createWriteDatabase(client), now);
  const { operations: _operations, ...report } = plan;
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'seed', ...report }, null, 2));
  if (!plan.ready) process.exitCode = 1;
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
