import { parse } from 'csv-parse/sync';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { benchmarkInputSchema } from './domain-entry.js';
import type { BenchmarkInput } from './domain-entry.js';
import type { ResolverResult } from '../resolution/resolve-with-discovery.js';

const INPUT_COLUMNS = ['brand_name', 'domain', 'target_market'];
export const RESULT_COLUMNS = [...INPUT_COLUMNS, 'overall_action', 'selected_legal_entity', 'company_number', 'role', 'source_url',
  'retrieval_channel', 'reason', 'same_document_evidence_fusion', 'error'];
export const AUDIT_COLUMNS = ['audit_outcome', 'audited_legal_entity', 'audited_company_number', 'audited_role', 'audit_notes'];
export type BenchmarkAction = 'PROPOSE' | 'REVIEW' | 'UNRESOLVED' | 'ERROR';
export interface RunMetadata {
  benchmark_input_filename: string;
  benchmark_input_sha256: string;
  git_commit_sha: string;
  git_dirty: boolean;
  timestamp: string;
  resolver_target_market: 'GB';
  resolver_version: 'V2.3' | 'V2.4' | 'V2.4.1';
  evaluation_kind?: 'regression_comparison' | 'unclassified';
  resolver_source_sha256: Record<string, string>;
  openai_configuration: { model: string | null; identifier: string; allowed_domains: string; tool_choice: string | null; include_sources: boolean };
}
export interface BenchmarkRecord {
  input: BenchmarkInput;
  overall_action: BenchmarkAction;
  error: string | null;
  operational_errors: string[];
  resolver_result: ResolverResult | null;
}
export class BenchmarkInputError extends Error {
  constructor(message: string) { super(message); this.name = 'BenchmarkInputError'; }
}
export function parseBenchmarkCsv(csv: string): BenchmarkInput[] {
  let rows: string[][];
  try { rows = parse(csv, { bom: true, skip_empty_lines: true, trim: true }) as string[][]; }
  catch { throw new BenchmarkInputError('invalid_csv'); }
  if (!rows[0] || rows[0].length !== 3 || rows[0].some((name, i) => name !== INPUT_COLUMNS[i])) throw new BenchmarkInputError('only_brand_name_domain_target_market_columns_allowed');
  if (rows.length < 2) throw new BenchmarkInputError('empty_benchmark');
  const names = new Set<string>();
  return rows.slice(1).map((row, index) => {
    if (row.length !== 3) throw new BenchmarkInputError(`invalid_column_count_row_${index + 2}`);
    const parsed = benchmarkInputSchema.safeParse({ brand_name: row[0], domain: row[1], target_market: row[2] });
    if (!parsed.success) throw new BenchmarkInputError(`invalid_input_row_${index + 2}`);
    const key = parsed.data.brand_name.toLowerCase();
    if (names.has(key)) throw new BenchmarkInputError(`duplicate_brand_row_${index + 2}`);
    names.add(key);
    return parsed.data;
  });
}

/** Keep full resolver provenance, removing sensitive transport fields and known secret values. */
export function sanitise(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/([?&](?:api[_-]?key|key|token|access_token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => sanitise(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:headers|authorization|proxy-authorization|cookies?|set-cookie|api[_-]?key|.*_API_KEY|SUPABASE_SECRET_KEY|access_token|secret|password)$/i.test(key))
    .map(([key, item]) => [key, sanitise(item, secrets)]));
  return value;
}
function operationalErrors(result: ResolverResult): string[] {
  const errors: string[] = [];
  if (result.discovery && result.discovery.status !== 'success') errors.push(`discovery_${result.discovery.status}`);
  const registryErrors = new Set(['companies_house_network_error', 'companies_house_rate_limited', 'companies_house_unauthorized',
    'companies_house_missing_api_key', 'companies_house_invalid_response', 'companies_house_timeout', 'companies_house_http_error', 'companies_house_invalid_company_number']);
  for (const proposal of result.proposals) for (const signal of proposal.signals) if (registryErrors.has(signal.code)) errors.push(signal.code);
  return [...new Set(errors)];
}
export function summarise(records: BenchmarkRecord[], metadata: RunMetadata) {
  const counts = { PROPOSE: 0, REVIEW: 0, UNRESOLVED: 0, ERROR: 0 };
  for (const record of records) counts[record.overall_action]++;
  const total = records.length;
  return { ...metadata, total_brands: total, ...counts, automatic_resolution_rate: total ? counts.PROPOSE / total : 0,
    review_rate: total ? counts.REVIEW / total : 0, unresolved_rate: total ? counts.UNRESOLVED / total : 0,
    error_rate: total ? counts.ERROR / total : 0 };
}
const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csvRow = (values: unknown[]) => values.map(cell).join(',') + '\n';
function resultRow(record: BenchmarkRecord): unknown[] {
  const selected = record.resolver_result?.selected_candidate;
  return [record.input.brand_name, record.input.domain, record.input.target_market, record.overall_action,
    selected?.candidate_legal_entity_name, selected?.company_number, selected?.inferred_role, selected?.source_url,
    selected?.retrieval_channel, record.resolver_result?.overall.reason ?? record.error, selected?.same_document_evidence_fusion ?? false, record.error];
}

export async function runBenchmark(inputs: BenchmarkInput[], options: {
  output: string;
  metadata: RunMetadata;
  resolve: (input: BenchmarkInput) => Promise<ResolverResult>;
  secrets?: readonly string[];
}): Promise<ReturnType<typeof summarise>> {
  // Validate every row before creating outputs or invoking any resolver.
  if (!inputs.length) throw new BenchmarkInputError('empty_benchmark');
  const validated = inputs.map(input => benchmarkInputSchema.parse(input));
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output); // Refuse to overwrite or append to an existing run.
  await writeFile(join(options.output, 'results.jsonl'), '', { flag: 'wx' });
  await writeFile(join(options.output, 'results.csv'), csvRow(RESULT_COLUMNS), { flag: 'wx' });
  await writeFile(join(options.output, 'audit.csv'), csvRow([...RESULT_COLUMNS, ...AUDIT_COLUMNS]), { flag: 'wx' });
  const records: BenchmarkRecord[] = [];
  for (const input of validated) {
    let record: BenchmarkRecord;
    try {
      const result = await options.resolve({ brand_name: input.brand_name, domain: input.domain, target_market: input.target_market });
      const errors = operationalErrors(result);
      // Retain a successful independent proposal despite unrelated provider failures.
      const failed = result.overall.recommended_action !== 'PROPOSE' && errors.length > 0;
      record = { input, overall_action: failed ? 'ERROR' : result.overall.recommended_action,
        error: failed ? errors.join(';') : null, operational_errors: errors, resolver_result: result };
    } catch {
      record = { input, overall_action: 'ERROR', error: 'resolver_exception', operational_errors: ['resolver_exception'], resolver_result: null };
    }
    const safe = sanitise(record, options.secrets) as BenchmarkRecord;
    records.push(safe);
    // Flush each completed brand so an interruption does not lose prior results.
    await appendFile(join(options.output, 'results.jsonl'), JSON.stringify(safe) + '\n');
    const values = resultRow(safe);
    await appendFile(join(options.output, 'results.csv'), csvRow(values));
    await appendFile(join(options.output, 'audit.csv'), csvRow([...values, ...AUDIT_COLUMNS.map(() => '')]));
    await writeFile(join(options.output, 'summary.json'), JSON.stringify(sanitise({ ...summarise(records, options.metadata),
      planned_brands: validated.length, completed: records.length === validated.length }, options.secrets), null, 2) + '\n');
  }
  return summarise(records, options.metadata);
}
