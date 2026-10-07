import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResolutionReviewStore } from '../src/review/resolution-review.js';
import { createBenchmarkImportStore, importBenchmark, planBenchmarkImport } from '../src/review/import-benchmark.js';
import type { BenchmarkImportStore } from '../src/review/import-benchmark.js';
import { main } from '../src/scripts/import-resolution-results.js';

const metadata = { resolver_version: 'V2.3', git_commit_sha: 'a'.repeat(40), timestamp: '2026-01-01T00:00:00Z',
  benchmark_input_sha256: 'b'.repeat(64), resolver_target_market: 'GB', resolver_source_sha256: { 'old-resolver.ts': 'old-hash' },
  benchmark_input_filename: '/original/beauty.csv', openai_configuration: { model: 'historical-model' } };
function row(action: 'PROPOSE' | 'REVIEW' | 'UNRESOLVED' | 'ERROR' = 'PROPOSE', brand = 'Example') {
  const proposal = { candidate_legal_entity_name: 'ALPHA LIMITED', company_number: '00123456', inferred_role: 'seller',
    source_url: 'https://example.com/terms', retrieval_channel: 'openai_web_search', recommended_action: action,
    reason: 'historical_reason', verification: { registry_verified: true, legacy_field: false },
    evidence_groups: [{ occurrences: [{ raw_identifier: '123456', canonical_identifier: '00123456', source_snippet: 'Original historical snippet', extraction_channel: 'discovery_text' }] }],
    companies_house_match: { company_number: '00123456', company_name: 'ALPHA LIMITED', company_status: 'active' },
    conflicting_evidence: [{ historical_conflict: true }], same_document_evidence_fusion: true,
    confidence: { score: 0.97, calibrated: false }, unrecognised_historical_field: { retain: 'exactly' } };
  return { input: { brand_name: brand, domain: 'example.com', target_market: 'GB' }, overall_action: action,
    error: action === 'ERROR' ? 'discovery_invalid_response' : null, operational_errors: action === 'ERROR' ? ['discovery_invalid_response'] : [],
    resolver_result: action === 'ERROR' ? null : { overall: { recommended_action: action, reason: 'historical_overall', company_number: action === 'UNRESOLVED' ? null : '00123456' },
      proposals: action === 'UNRESOLVED' ? [] : [proposal], selected_candidate: proposal, secondary_candidates: [{ old_secondary: true }],
      discovery: { status: 'success', sources: [{ url: 'https://example.com/terms', type: 'url' }] } } };
}
const jsonl = (rows: unknown[]) => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const fake = (): BenchmarkImportStore => ({ ingest: vi.fn(), findRun: vi.fn(), pendingCount: vi.fn() });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  for (const file of ['0001_initial_schema.sql', '0002_evidence_source_identity.sql', '0003_resolution_review.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('TRUNCATE resolution_candidates, resolution_runs, brand_entity_relationships, brands, legal_entities CASCADE'); });
// Actual review service, with its Supabase RPC transport routed to in-memory PostgreSQL.
function localStore(): BenchmarkImportStore {
  const client = createClient('https://example.test', 'test-only', { global: { fetch: async (url, init) => {
    expect(String(url)).toContain('/rpc/ingest_resolution_run'); expect(init?.method).toBe('POST');
    const { p_key, p_payload } = JSON.parse(String(init?.body));
    try {
      const result = await db.query<{ id: string }>('SELECT ingest_resolution_run($1,$2::jsonb) id', [p_key, JSON.stringify(p_payload)]);
      return new Response(JSON.stringify(result.rows[0]!.id), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  } } });
  return { ingest: createResolutionReviewStore(client).ingest,
    async findRun(key) { return (await db.query<{ id: string }>('SELECT id FROM resolution_runs WHERE ingestion_key=$1', [key])).rows[0] ?? null; },
    async pendingCount(id) { return (await db.query<{ n: number }>("SELECT count(*)::int n FROM resolution_candidates WHERE resolution_run_id=$1 AND review_status='pending'", [id])).rows[0]!.n; } };
}

describe('historical benchmark import', () => {
  it('dry-run makes zero store calls, reports plans and action counts', async () => {
    const store = fake(); const plan = planBenchmarkImport(jsonl([row(), row('REVIEW', 'Two'), row('UNRESOLVED', 'Three'), row('ERROR', 'Four')]), metadata);
    expect(await importBenchmark(plan, { dryRun: true, label: 'Saved baseline', store })).toMatchObject({ runs_imported: 0, candidates_imported: 0,
      runs_planned: 4, candidates_planned: 2, expected_pending_if_new: 2, pending_review_count: null, database_calls: 0,
      action_counts: { PROPOSE: 1, REVIEW: 1, UNRESOLVED: 1, ERROR: 1 }, label: 'Saved baseline' });
    expect(store.ingest).not.toHaveBeenCalled(); expect(store.findRun).not.toHaveBeenCalled(); expect(store.pendingCount).not.toHaveBeenCalled();
  });
  it('persists each row, preserves historical provenance, leaves proposals pending and never writes the graph', async () => {
    const records = [row(), row('REVIEW', 'Two'), row('UNRESOLVED', 'Three'), row('ERROR', 'Four')];
    const summary = await importBenchmark(planBenchmarkImport(jsonl(records), metadata), { dryRun: false, store: localStore() });
    expect(summary).toMatchObject({ runs_imported: 4, candidates_imported: 2, skipped_existing_runs: 0, pending_review_count: 2 });
    const runs = (await db.query<{ brand_name: string; raw_result: { benchmark_record: unknown; benchmark_summary: unknown }; resolver_version: string; git_commit_sha: string; overall_action: string }>('SELECT * FROM resolution_runs')).rows;
    expect(runs).toHaveLength(4);
    for (const record of records) {
      const saved = runs.find(run => run.brand_name === record.input.brand_name)!;
      expect(saved).toMatchObject({ resolver_version: 'V2.3', git_commit_sha: metadata.git_commit_sha, overall_action: record.overall_action });
      expect(saved.raw_result.benchmark_record).toEqual(record); expect(saved.raw_result.benchmark_summary).toEqual(metadata);
    }
    const candidates = (await db.query('SELECT review_status,provenance,verification,relationship_type FROM resolution_candidates')).rows;
    expect(candidates).toHaveLength(2);
    for (const [i, candidate] of candidates.entries()) expect(candidate).toMatchObject({ review_status: 'pending', relationship_type: 'seller',
      provenance: records[i]!.resolver_result!.proposals[0], verification: records[i]!.resolver_result!.proposals[0]!.verification });
    expect((await db.query('SELECT id FROM brand_entity_relationships')).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM brands')).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM legal_entities')).rows).toHaveLength(0);
  });
  it('repeated imports are idempotent, report skipped runs, and preserve human rejection state', async () => {
    const plan = planBenchmarkImport(jsonl([row(), row('REVIEW', 'Two')]), metadata); const store = localStore();
    await importBenchmark(plan, { dryRun: false, store });
    await db.exec("SELECT reject_resolution_candidate((SELECT id FROM resolution_candidates LIMIT 1),'Previously reviewed');");
    expect(await importBenchmark(plan, { dryRun: false, label: 'Different display label', store })).toMatchObject({ runs_imported: 0,
      candidates_imported: 0, skipped_existing_runs: 2, pending_review_count: 1 });
    expect((await db.query('SELECT id FROM resolution_runs')).rows).toHaveLength(2);
    expect((await db.query('SELECT id FROM resolution_candidates')).rows).toHaveLength(2);
  });
  it('changed content under the same run provenance cannot silently replace history or create duplicate runs', async () => {
    const store = localStore();
    await importBenchmark(planBenchmarkImport(jsonl([row()]), metadata), { dryRun: false, store });
    await expect(importBenchmark(planBenchmarkImport(jsonl([row('REVIEW')]), metadata), { dryRun: false, store })).rejects.toThrow('different input');
    expect((await db.query('SELECT overall_action FROM resolution_runs')).rows).toEqual([{ overall_action: 'PROPOSE' }]);
  });
  it.each(['V2.3', 'V2.4', 'V2.4.1'])('preserves %s without running modern resolution rules', version => {
    const plan = planBenchmarkImport(jsonl([row()]), { ...metadata, resolver_version: version });
    expect(plan.runs[0]!.payload.resolver_version).toBe(version);
    expect(plan.runs[0]!.payload.raw_result.benchmark_record).toEqual(row());
  });
  it('preserves ERROR even when its nested resolver output was REVIEW and still has candidates', () => {
    const record = { ...row('REVIEW'), overall_action: 'ERROR', error: 'companies_house_timeout', operational_errors: ['companies_house_timeout'] };
    const payload = planBenchmarkImport(jsonl([record]), metadata).runs[0]!.payload;
    expect(payload.overall_action).toBe('ERROR'); expect(payload.reason).toBe('companies_house_timeout'); expect(payload.candidates).toHaveLength(1);
    expect(payload.raw_result.benchmark_record).toEqual(record);
  });
  it('allows explicit row metadata without a summary and preserves unavailable Git SHA as null', () => {
    const record = { ...row(), metadata: { resolver_version: 'V2.4' } };
    expect(planBenchmarkImport(jsonl([record])).runs[0]!.payload).toMatchObject({ resolver_version: 'V2.4', git_commit_sha: null });
    expect(() => planBenchmarkImport(jsonl([row()]))).toThrow('Missing historical resolver metadata');
  });
  it('identity ignores JSON formatting and labels, uses run provenance, and falls back to content when provenance is absent', () => {
    const record = row();
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    const key = planBenchmarkImport(jsonl([record]), metadata).runs[0]!.key;
    expect(planBenchmarkImport(' \n' + JSON.stringify(reordered) + '\n\n', metadata).runs[0]!.key).toBe(key);
    expect(planBenchmarkImport(jsonl([record]), { ...metadata, timestamp: 'another-run' }).runs[0]!.key).not.toBe(key);
    expect(planBenchmarkImport(jsonl([row('REVIEW')]), metadata).runs[0]!.key).toBe(key);
    expect(planBenchmarkImport(jsonl([row()]), { resolver_version: 'V2.3' }).runs[0]!.key).not.toBe(planBenchmarkImport(jsonl([row('REVIEW')]), { resolver_version: 'V2.3' }).runs[0]!.key);
  });
  it.each(['', '{broken', '{}', jsonl([row()]) + '{broken', jsonl([row(), row()]), jsonl([{ ...row(), input: { ...row().input, target_market: 'US' } }])])
    ('rejects malformed/unsupported input before any import', contents => expect(() => planBenchmarkImport(contents, metadata)).toThrow());
  it('rejects bad candidate data and conflicting version metadata rather than repairing it', () => {
    const record = row(); record.resolver_result!.proposals[0]!.company_number = '123456';
    expect(() => planBenchmarkImport(jsonl([record]), metadata)).toThrow('Unsupported candidate');
    expect(() => planBenchmarkImport(jsonl([{ ...row(), metadata: { resolver_version: 'V2.4.1' } }]), metadata)).toThrow('Conflicting benchmark metadata');
  });
});

describe('import CLI and Supabase reads, fully mocked', () => {
  it('loads neighbouring summary, validates all rows before constructing a client, and dry-run never constructs one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'import-cli-'));
    try {
      const file = join(directory, 'results.jsonl'); await writeFile(file, jsonl([row()])); await writeFile(join(directory, 'summary.json'), JSON.stringify(metadata));
      const store = vi.fn(async () => fake()); const log = vi.fn();
      await main(['--file', file, '--dry-run', '--label', 'Local fixture'], { store, log });
      expect(store).not.toHaveBeenCalled(); expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ dry_run: true, runs_planned: 1, database_calls: 0 });
      await writeFile(file, jsonl([row()]) + '{malformed');
      await expect(main(['--file', file], { store, log })).rejects.toThrow('row 2'); expect(store).not.toHaveBeenCalled();
      await writeFile(file, jsonl([row()])); await writeFile(join(directory, 'summary.json'), '{invalid');
      await expect(main(['--file', file], { store, log })).rejects.toThrow('summary.json'); expect(store).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reads identity and exact pending count without fetching unrelated rows', async () => {
    const id = '12345678-1234-4234-8234-123456789abc'; const urls: URL[] = [];
    const client = createClient('https://example.test', 'test-only', { global: { fetch: async (value, init) => {
      const url = new URL(String(value)); urls.push(url);
      if (url.pathname.endsWith('resolution_runs')) return new Response(JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } });
      expect(init?.method).toBe('HEAD');
      return new Response(null, { headers: { 'Content-Range': '0-1/2' } });
    } } });
    const store = createBenchmarkImportStore(client);
    expect(await store.findRun('saved-key')).toEqual({ id }); expect(await store.pendingCount(id)).toBe(2);
    expect(urls[0]?.searchParams.get('ingestion_key')).toBe('eq.saved-key');
    expect(urls[1]?.searchParams.get('resolution_run_id')).toBe('eq.' + id);
    expect(urls[1]?.searchParams.get('review_status')).toBe('eq.pending');
  });
});
