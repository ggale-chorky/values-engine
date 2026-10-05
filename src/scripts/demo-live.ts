import { createReadDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { evaluateDemoFromDb } from '../demo/live.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[]) {
  if (args.length) throw new DataError('Usage: npm run demo:live');
  const db = createReadDatabase(await configuredClient());
  const results = await evaluateDemoFromDb(db, new Date().toISOString().slice(0, 10));
  console.log(JSON.stringify(results, null, 2));
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
