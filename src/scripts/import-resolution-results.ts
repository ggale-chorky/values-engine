import { parseArgs } from 'node:util';
import { DataError } from '../db/rows.js';
import { createBenchmarkImportStore, importBenchmark, loadBenchmarkImport } from '../review/import-benchmark.js';
import type { BenchmarkImportStore } from '../review/import-benchmark.js';
import { configuredClient, isMain, reportCliError } from './db-cli.js';

export async function main(args: string[], dependencies: { store?: () => Promise<BenchmarkImportStore>; log?: (text: string) => void } = {}) {
  const { values } = parseArgs({ args, strict: true, options: { file: { type: 'string' }, label: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.file?.trim()) throw new DataError('Usage: npm run resolution:import -- --file <results.jsonl> [--dry-run] [--label <label>]');
  const plan = await loadBenchmarkImport(values.file);
  const dryRun = values['dry-run'];
  // Dry run never reads environment configuration or constructs a client.
  const store = dryRun ? undefined : await (dependencies.store ?? (async () => createBenchmarkImportStore(await configuredClient())))();
  const summary = await importBenchmark(plan, { dryRun, ...(values.label === undefined ? {} : { label: values.label }), ...(store ? { store } : {}) });
  (dependencies.log ?? console.log)(JSON.stringify(summary, null, 2));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(reportCliError);
