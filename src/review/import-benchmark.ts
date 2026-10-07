import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DataError } from '../db/rows.js';
import { createResolutionReviewStore, validateResolutionPayload } from './resolution-review.js';
import type { ResolutionPayload, ResolutionReviewStore } from './resolution-review.js';

const object = z.record(z.string(), z.unknown());
const action = z.enum(['PROPOSE', 'REVIEW', 'UNRESOLVED', 'ERROR']);
const version = z.enum(['V2.3', 'V2.4', 'V2.4.1']);
const metadataSchema = z.object({ resolver_version: version, git_commit_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
  resolver_target_market: z.literal('GB').optional() }).passthrough();
const proposalSchema = z.object({ candidate_legal_entity_name: z.string().nullable(), company_number: z.string().nullable(),
  inferred_role: z.string(), source_url: z.string(), retrieval_channel: z.string(), recommended_action: action,
  reason: z.string(), verification: object }).passthrough();
const resultSchema = z.object({ overall: z.object({ recommended_action: action, reason: z.string().min(1) }).passthrough(),
  proposals: z.array(proposalSchema) }).passthrough();
const rowSchema = z.object({ input: z.object({ brand_name: z.string().min(1), domain: z.string().min(1), target_market: z.literal('GB') }).strict(),
  overall_action: action, error: z.string().nullable(), operational_errors: z.array(z.string()), resolver_result: resultSchema.nullable(),
  metadata: metadataSchema.optional() }).passthrough();

/** Canonical JSON for import identity, not a reinterpretation of resolver decisions. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface PlannedRun { key: string; payload: ResolutionPayload }
export interface BenchmarkImportPlan { runs: PlannedRun[]; file_snapshot_sha256: string }

/** Validate the entire input before any client is created or database method called. */
export function planBenchmarkImport(contents: string, summary?: unknown): BenchmarkImportPlan {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows: z.infer<typeof rowSchema>[] = [];
  let metadata: z.infer<typeof metadataSchema> | undefined;
  if (summary !== undefined) {
    const parsed = metadataSchema.safeParse(summary);
    if (!parsed.success) throw new DataError('Invalid benchmark summary metadata.');
    metadata = parsed.data;
  }
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const row = rowSchema.parse(JSON.parse(line));
      if (row.resolver_result === null && row.overall_action !== 'ERROR') throw new Error();
      if (row.overall_action === 'ERROR' && !row.error?.trim()) throw new Error();
      if (row.overall_action !== 'ERROR' && row.resolver_result?.overall.recommended_action !== row.overall_action) throw new Error();
      const identity = canonical(row.input);
      if (seen.has(identity)) throw new Error();
      seen.add(identity); rows.push(row);
    } catch { throw new DataError(`Invalid benchmark JSONL row ${index + 1}. No rows were imported.`); }
  }
  if (!rows.length) throw new DataError('Benchmark JSONL contains no rows.');
  const snapshot = hash(rows);
  const runs = rows.map((row, index): PlannedRun => {
    const meta = row.metadata && metadata ? { ...metadata, ...row.metadata, git_commit_sha: row.metadata.git_commit_sha ?? metadata.git_commit_sha } : row.metadata ?? metadata;
    if (!meta) throw new DataError(`Missing historical resolver metadata for row ${index + 1}; provide the original neighbouring summary.json.`);
    if (row.metadata && metadata && (row.metadata.resolver_version !== metadata.resolver_version
      || (row.metadata.git_commit_sha && metadata.git_commit_sha && row.metadata.git_commit_sha !== metadata.git_commit_sha))) {
      throw new DataError(`Conflicting benchmark metadata for row ${index + 1}.`);
    }
    // Paths, optional display labels, and mutable summary counts do not identify a run.
    const provenanceIdentity = { resolver_version: meta.resolver_version, git_commit_sha: meta.git_commit_sha ?? null,
      timestamp: meta.timestamp ?? null, benchmark_input_sha256: meta.benchmark_input_sha256 ?? null,
      resolver_source_sha256: meta.resolver_source_sha256 ?? null, openai_configuration: meta.openai_configuration ?? null };
    const hasRunProvenance = typeof meta.timestamp === 'string' && !!(meta.git_commit_sha || meta.benchmark_input_sha256 || meta.resolver_source_sha256);
    const key = 'benchmark-import:v1:' + hash({ provenance: provenanceIdentity, input: row.input,
      ...(hasRunProvenance ? {} : { snapshot }) });
    const candidates = (row.resolver_result?.proposals ?? []).filter(p => p.company_number !== null || p.candidate_legal_entity_name !== null)
      .map(p => ({ candidate_legal_name: p.candidate_legal_entity_name, jurisdiction: 'GB', company_number: p.company_number,
        relationship_type: p.inferred_role, source_url: p.source_url, retrieval_channel: p.retrieval_channel,
        recommended_action: p.recommended_action, reason: p.reason, verification: p.verification, provenance: p }));
    try {
      return { key, payload: validateResolutionPayload({ brand_id: null, brand_name: row.input.brand_name,
        brand_domain: row.input.domain, target_market: row.input.target_market, resolver_version: meta.resolver_version,
        git_commit_sha: meta.git_commit_sha ?? null, overall_action: row.overall_action,
        reason: row.overall_action === 'ERROR' ? row.error : row.resolver_result!.overall.reason,
        // Preserve the full historical record and metadata, including null/error results.
        raw_result: { benchmark_record: row, benchmark_summary: summary ?? null, benchmark_metadata: meta, file_snapshot_sha256: snapshot }, candidates }) };
    } catch { throw new DataError(`Unsupported candidate/input data in benchmark row ${index + 1}. No rows were imported.`); }
  });
  return { runs, file_snapshot_sha256: snapshot };
}

export async function loadBenchmarkImport(file: string): Promise<BenchmarkImportPlan> {
  let contents: string;
  try { contents = await readFile(file, 'utf8'); }
  catch { throw new DataError('Cannot read benchmark JSONL file.'); }
  let metadata: unknown;
  try { metadata = JSON.parse(await readFile(join(dirname(file), 'summary.json'), 'utf8')); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new DataError('Cannot read or parse benchmark summary.json.');
  }
  return planBenchmarkImport(contents, metadata);
}

export interface BenchmarkImportStore extends Pick<ResolutionReviewStore, 'ingest'> {
  findRun(key: string): Promise<{ id: string } | null>;
  pendingCount(runId: string): Promise<number>;
}
export function createBenchmarkImportStore(client: SupabaseClient): BenchmarkImportStore {
  return {
    ingest: createResolutionReviewStore(client).ingest,
    async findRun(key) {
      const { data, error } = await client.from('resolution_runs').select('id').eq('ingestion_key', key).maybeSingle();
      if (error) throw new DataError('Benchmark import lookup failed.');
      return data === null ? null : z.object({ id: z.uuid() }).parse(data);
    },
    async pendingCount(runId) {
      const { count, error } = await client.from('resolution_candidates').select('id', { count: 'exact', head: true })
        .eq('resolution_run_id', runId).eq('review_status', 'pending');
      if (error || count === null) throw new DataError('Benchmark import pending-count read failed.');
      return count;
    },
  };
}
export async function importBenchmark(plan: BenchmarkImportPlan, options: { dryRun: boolean; label?: string; store?: BenchmarkImportStore }) {
  const summary = { dry_run: options.dryRun, label: options.label ?? null, file_snapshot_sha256: plan.file_snapshot_sha256,
    runs_imported: 0, candidates_imported: 0, skipped_existing_runs: 0, pending_review_count: 0,
    runs_planned: plan.runs.length, candidates_planned: plan.runs.reduce((n, run) => n + run.payload.candidates.length, 0),
    action_counts: { PROPOSE: 0, REVIEW: 0, UNRESOLVED: 0, ERROR: 0 } };
  for (const run of plan.runs) summary.action_counts[run.payload.overall_action]++;
  if (options.dryRun) return { ...summary, pending_review_count: null, expected_pending_if_new: summary.candidates_planned, database_calls: 0 };
  if (!options.store) throw new DataError('Benchmark import requires a server review store.');
  for (const run of plan.runs) {
    const existing = await options.store.findRun(run.key);
    // Reuse the transactional review RPC even on replay so its fingerprint check
    // rejects a reused identity with different payload instead of silently skipping it.
    const id = await options.store.ingest(run.key, run.payload);
    if (existing) summary.skipped_existing_runs++;
    else { summary.runs_imported++; summary.candidates_imported += run.payload.candidates.length; }
    summary.pending_review_count += await options.store.pendingCount(id);
  }
  return summary;
}
