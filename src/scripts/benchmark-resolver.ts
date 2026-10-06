import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { CompaniesHouseClient } from '../resolution/companies-house.js';
import { resolveDomain } from '../benchmark/domain-entry.js';
import { BenchmarkInputError, parseBenchmarkCsv, runBenchmark } from '../benchmark/run-benchmark.js';
import type { RunMetadata } from '../benchmark/run-benchmark.js';

const exec = promisify(execFile);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function benchmarkMetadata(inputFile: string, contents: string): Promise<RunMetadata> {
  const sourceDir = resolve('src/resolution');
  const files = (await readdir(sourceDir)).filter(name => name.endsWith('.ts')).sort();
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[`src/resolution/${file}`] = sha256(await readFile(join(sourceDir, file)));
  const discovery = await readFile(join(sourceDir, 'discover-first-party-evidence.ts'), 'utf8');
  const commit = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await exec('git', ['status', '--porcelain'])).stdout.trim().length > 0;
  return { benchmark_input_filename: inputFile, benchmark_input_sha256: sha256(contents), git_commit_sha: commit, git_dirty: dirty,
    timestamp: new Date().toISOString(), resolver_target_market: 'GB', resolver_version: 'V2.4.1', evaluation_kind: sha256(contents) === 'd1eec88d92302263ef05ba5e2b425ae4df105aafa491c044357a954db1ed38d2' ? 'regression_comparison' : 'unclassified', resolver_source_sha256: hashes,
    openai_configuration: { model: discovery.match(/model:\s*'([^']+)'/)?.[1] ?? null,
      identifier: `sha256:${sha256(discovery)}`, allowed_domains: '[normalised input domain]',
      tool_choice: discovery.match(/tool_choice:\s*'([^']+)'/)?.[1] ?? null,
      include_sources: discovery.includes("include: ['web_search_call.action.sources']") } };
}

export async function main(args = process.argv.slice(2), dependencies: {
  resolve?: Parameters<typeof runBenchmark>[1]['resolve'];
  log?: (message: string) => void;
} = {}) {
  const { values } = parseArgs({ args, options: { input: { type: 'string', default: 'benchmarks/beauty-uk-v1.csv' },
    output: { type: 'string' }, limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } }, strict: true });
  if (values.limit !== undefined && (!/^[1-9]\d*$/.test(values.limit) || !Number.isSafeInteger(Number(values.limit)))) throw new BenchmarkInputError('limit_must_be_positive_integer');
  const inputFile = resolve(values.input!);
  const contents = await readFile(inputFile, 'utf8');
  const all = parseBenchmarkCsv(contents);
  const selected = values.limit ? all.slice(0, Number(values.limit)) : all;
  const log = dependencies.log ?? console.log;
  if (values['dry-run']) {
    log(JSON.stringify({ dry_run: true, benchmark: basename(inputFile), validated_brands: all.length, selected_brands: selected.length,
      target_market: 'GB', input_sha256: sha256(contents), network_calls: 0, output_files_written: 0 }));
    return;
  }
  const metadata = await benchmarkMetadata(inputFile, contents);
  // Dry-run exits before environment loading, client construction or resolver invocation.
  const { config } = await import('dotenv');
  config({ quiet: true });
  const companiesHouse = new CompaniesHouseClient();
  const resolver = dependencies.resolve ?? (input => resolveDomain(input, { companiesHouse }));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const output = resolve(values.output ?? join('benchmarks/runs', runId));
  const secrets = [process.env.OPENAI_API_KEY, process.env.COMPANIES_HOUSE_API_KEY, process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY].filter((value): value is string => !!value);
  const summary = await runBenchmark(selected, { output, metadata, resolve: resolver, secrets });
  log(JSON.stringify({ run_directory: output, total_brands: summary.total_brands, PROPOSE: summary.PROPOSE,
    REVIEW: summary.REVIEW, UNRESOLVED: summary.UNRESOLVED, ERROR: summary.ERROR }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Benchmark failed: check input arguments and output permissions. Raw errors are not logged.'); process.exitCode = 1; });
}
