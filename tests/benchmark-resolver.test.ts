import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDomain } from '../src/benchmark/domain-entry.js';
import { AUDIT_COLUMNS, parseBenchmarkCsv, runBenchmark } from '../src/benchmark/run-benchmark.js';
import type { RunMetadata } from '../src/benchmark/run-benchmark.js';
import { benchmarkMetadata, main } from '../src/scripts/benchmark-resolver.js';
import { unresolved } from '../src/resolution/resolve-brand-legal-entity.js';
import type { ResolverResult } from '../src/resolution/resolve-with-discovery.js';

const header = 'brand_name,domain,target_market\n';
const input = { brand_name: 'Example', domain: 'example.com', target_market: 'GB' as const };
const metadata: RunMetadata = { benchmark_input_filename: 'test.csv', benchmark_input_sha256: 'test-hash', git_commit_sha: 'test-commit',
  git_dirty: true, timestamp: '2026-01-01T00:00:00Z', resolver_target_market: 'GB', resolver_version: 'V2.3', resolver_source_sha256: {},
  openai_configuration: { model: 'mock', identifier: 'mock-config', allowed_domains: '[normalised input domain]', tool_choice: 'required', include_sources: true } };
function result(action: 'PROPOSE' | 'REVIEW' | 'UNRESOLVED'): ResolverResult {
  const proposal = unresolved('Example', 'https://example.com/terms', 'mock');
  proposal.recommended_action = action;
  if (action !== 'UNRESOLVED') Object.assign(proposal, { candidate_legal_entity_name: 'Mock Company', company_number: '00000001', inferred_role: 'seller',
    source_snippet: 'Mock evidence for tests only.', same_document_evidence_fusion: true });
  return { overall: { recommended_action: action, reason: 'mock', company_number: proposal.company_number }, selected_candidate: action === 'UNRESOLVED' ? null : proposal,
    proposals: [proposal], direct_proposals: [proposal], discovery: null, discovery_rejections: [], named_role_evidence: [], attempts: [], supporting_candidates: [], secondary_candidates: [] };
}
const temporary: string[] = [];
async function output() { const parent = await mkdtemp(join(tmpdir(), 'resolver-benchmark-test-')); temporary.push(parent); return join(parent, 'run'); }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('blind benchmark inputs and frozen snapshot', () => {
  it('parses quoted CSV and accepts only brand/domain/GB fields', () => {
    expect(parseBenchmarkCsv(header + '"Example, Beauty",example.com,GB\n')).toEqual([{ ...input, brand_name: 'Example, Beauty' }]);
  });
  it.each(['company_number', 'legal_entity', 'source_url', 'parent_company', 'possible_role'])('rejects hidden assistance column %s', field => {
    expect(() => parseBenchmarkCsv(`brand_name,domain,target_market,${field}\nExample,example.com,GB,hidden\n`)).toThrow();
  });
  it.each(['Example,https://example.com/terms,GB', 'Example,example.com,US', 'Example,example.com/path,GB', 'Example,localhost,GB', 'Example,example.com:8080,GB'])
    ('rejects invalid benchmark row %s', row => expect(() => parseBenchmarkCsv(header + row)).toThrow());
  it('rejects empty inputs, duplicate brands and malformed rows', () => {
    for (const csv of [header, header + 'Example,example.com,GB\nExample,other.com,GB', header + 'Example,example.com,GB,hidden']) expect(() => parseBenchmarkCsv(csv)).toThrow();
  });
  it('freezes all 20 rows and the untouched V2.3 resolver sources', async () => {
    const manifest = JSON.parse(await readFile('benchmarks/resolver-v23-freeze.json', 'utf8')) as { benchmark_input_sha256: string; files: Record<string, string> };
    const csv = await readFile('benchmarks/beauty-uk-v1.csv', 'utf8');
    const rows = parseBenchmarkCsv(csv);
    expect(rows).toHaveLength(20);
    expect(rows.every(row => Object.keys(row).join(',') === 'brand_name,domain,target_market' && row.target_market === 'GB')).toBe(true);
    expect(rows[0]?.brand_name).toBe('Trinny London'); expect(rows[19]?.brand_name).toBe('ESPA');
    expect(createHash('sha256').update(csv).digest('hex')).toBe(manifest.benchmark_input_sha256);
    for (const [path, digest] of Object.entries(manifest.files)) expect(createHash('sha256').update(execFileSync('git', ['show', `043dcac7e7bc6db4db345faa98c2c76b10c02f74:${path}`])).digest('hex')).toBe(digest);
  });
  it('labels reuse of Beauty UK v1 as a V2.4.1 regression comparison', async () => {
    const file = 'benchmarks/beauty-uk-v1.csv';
    expect(await benchmarkMetadata(file, await readFile(file, 'utf8'))).toMatchObject({ resolver_version: 'V2.4.1', evaluation_kind: 'regression_comparison' });
  });
  it('domain adapter derives only the homepage and invokes frozen discovery', async () => {
    const fetchPage = vi.fn(async (url: string) => ({ ok: false as const, status: 'source_unavailable' as const, source_url: url, reason: 'blocked' as const, http_status: 403 }));
    const discover = vi.fn(async () => ({ status: 'success' as const, candidates: [], sources: [] }));
    const getCompanyProfile = vi.fn();
    const resolved = await resolveDomain(input, { fetchPage, discover, companiesHouse: { getCompanyProfile } });
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith('https://example.com/');
    expect(discover).toHaveBeenCalledExactlyOnceWith({ brand: 'Example', domain: 'example.com' });
    expect(getCompanyProfile).not.toHaveBeenCalled();
    expect(resolved.overall.recommended_action).toBe('UNRESOLVED');
    await expect(resolveDomain({ ...input, source_url: 'https://example.com/known-terms' } as typeof input, { fetchPage, discover, companiesHouse: { getCompanyProfile } })).rejects.toThrow();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it('dry-run validates all 20 rows, applies limit and performs no resolver calls or writes', async () => {
    const resolver = vi.fn(); const log = vi.fn(); const directory = await output();
    await main(['--input', 'benchmarks/beauty-uk-v1.csv', '--output', directory, '--limit', '2', '--dry-run'], { resolve: resolver, log });
    expect(resolver).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ validated_brands: 20, selected_brands: 2, network_calls: 0, output_files_written: 0 });
    await expect(readdir(directory)).rejects.toThrow();
  });
});

describe('sequential benchmark outputs', () => {
  it('isolates failures, calculates rates and leaves all audit fields empty', async () => {
    const directory = await output();
    let active = 0; let position = 0;
    const invoke = vi.fn(async (row: typeof input) => {
      expect(Object.keys(row)).toEqual(['brand_name', 'domain', 'target_market']);
      active++; expect(active).toBe(1);
      await new Promise<void>(done => setImmediate(done));
      active--; const index = position++;
      if (index === 1) throw new Error('secret authorization payload');
      return result(index === 0 ? 'PROPOSE' : index === 2 ? 'REVIEW' : 'UNRESOLVED');
    });
    const rows = Array.from({ length: 4 }, (_, i) => ({ ...input, brand_name: `Example ${i}` }));
    const summary = await runBenchmark(rows, { output: directory, metadata, resolve: invoke });
    expect(invoke.mock.calls.map(call => call[0].brand_name)).toEqual(rows.map(row => row.brand_name));
    expect(summary).toMatchObject({ total_brands: 4, PROPOSE: 1, REVIEW: 1, UNRESOLVED: 1, ERROR: 1,
      automatic_resolution_rate: 0.25, review_rate: 0.25, unresolved_rate: 0.25, error_rate: 0.25, git_commit_sha: 'test-commit' });
    expect(summary).not.toHaveProperty('precision');
    const jsonl = (await readFile(join(directory, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(jsonl.map(row => row.overall_action)).toEqual(['PROPOSE', 'ERROR', 'REVIEW', 'UNRESOLVED']);
    expect(jsonl[0].resolver_result).toEqual(result('PROPOSE'));
    const csv = parse(await readFile(join(directory, 'results.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
    expect(csv).toHaveLength(4); expect(csv[0]?.company_number).toBe('00000001');
    const audit = parse(await readFile(join(directory, 'audit.csv'), 'utf8'), { columns: true }) as Record<string, string>[];
    for (const row of audit) for (const field of AUDIT_COLUMNS) expect(row[field]).toBe('');
    expect(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))).toMatchObject({ completed: true, planned_brands: 4 });
  });
  it.each(['api_error', 'invalid_response'] as const)('reports %s as ERROR, retaining the original resolver result', async status => {
    const directory = await output(); const resolved = result('UNRESOLVED');
    resolved.discovery = { status, candidates: [], sources: [], error: { http_status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: true } };
    const summary = await runBenchmark([input], { output: directory, metadata, resolve: async () => resolved });
    expect(summary.ERROR).toBe(1); expect(summary.UNRESOLVED).toBe(0);
    const record = JSON.parse(await readFile(join(directory, 'results.jsonl'), 'utf8'));
    expect(record.resolver_result.overall.recommended_action).toBe('UNRESOLVED');
    expect(record.error).toBe(`discovery_${status}`);
  });
  it('does not erase an independent PROPOSE because secondary evidence had a provider failure', async () => {
    const resolved = result('PROPOSE'); resolved.proposals[0]!.signals.push({ code: 'companies_house_network_error', weight: 0, detail: null });
    const summary = await runBenchmark([input], { output: await output(), metadata, resolve: async () => resolved });
    expect(summary.PROPOSE).toBe(1); expect(summary.ERROR).toBe(0);
  });
  it('never writes configured secrets, API-key fields, authorization headers or raw exception text', async () => {
    const directory = await output(); const resolved = result('PROPOSE');
    Object.assign(resolved, { headers: { authorization: 'Bearer header-secret' }, OPENAI_API_KEY: 'field-secret', apiKey: 'camel-secret' });
    resolved.selected_candidate!.source_snippet = 'configured-secret sk-example-secret Bearer token-secret';
    await runBenchmark([input], { output: directory, metadata, secrets: ['configured-secret'], resolve: async () => resolved });
    for (const filename of await readdir(directory)) {
      const contents = await readFile(join(directory, filename), 'utf8');
      for (const secret of ['header-secret', 'field-secret', 'camel-secret', 'configured-secret', 'sk-example-secret', 'token-secret']) expect(contents).not.toContain(secret);
    }
  });
  it('refuses to overwrite an existing run directory', async () => {
    const directory = await output(); const invoke = vi.fn(async () => result('UNRESOLVED'));
    await runBenchmark([input], { output: directory, metadata, resolve: invoke });
    await expect(runBenchmark([input], { output: directory, metadata, resolve: invoke })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
    expect(resolve(directory)).toBe(directory);
  });
});
