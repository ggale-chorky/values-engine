import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import { extractCompanyCandidates, extractNamedEvidence } from '../src/resolution/extract-company-candidates.js';
import { occurrenceMarketMismatch } from '../src/resolution/evidence-market.js';
import { discoverFirstPartyEvidence } from '../src/resolution/discover-first-party-evidence.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import type { PageResult } from '../src/resolution/fetch-first-party-page.js';
import { runBenchmark } from '../src/benchmark/run-benchmark.js';

const root = 'https://example.com/';
const terms = root + 'terms';
const input = { brand_name: 'Example', domain: 'example.com', source_url: root, target_market: 'GB' as const };
const seller = 'Goods supplied from the Website are supplied by Alpha Limited, registered in England and Wales, company number 00123456.';
const blocked = async (url: string): Promise<PageResult> => ({ ok: false, status: 'source_unavailable', reason: 'blocked', source_url: url, http_status: 403 });
const page = (text: string, url = terms): PageResult => ({ ok: true, source_url: url, final_url: url, content_type: 'text/html', content: text });
const registry = (names: Record<string, string> = {}) => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number,
  company_name: names[company_number] ?? 'ALPHA LIMITED', company_status: 'active' })) });
const claim = (evidence_text = seller, source_url = terms): DiscoveryCandidate => ({ evidence_text, source_url, source_domain: 'example.com',
  possible_legal_name: null, possible_company_number: null, possible_role: 'site_operator' });
const discovery = (candidates = [claim()]): DiscoveryResult => ({ status: 'success', candidates, sources: candidates.map(c => ({ type: 'url', url: c.source_url! })) });
const run = (html: string, candidates = [claim()], companiesHouse = registry()) => resolveWithDiscovery(input, {
  fetchPage: blocked, fetchDiscoveredPage: async () => page(html), companiesHouse, discover: async () => discovery(candidates),
});

describe('same-canonical-URL evidence fallback', () => {
  it('successful fetch without extracted identifiers keeps attributable seller evidence eligible', async () => {
    const result = await run('<p>Welcome to our website. Read the terms below.</p>');
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.evidence_groups.flatMap(g => g.occurrences)).toContainEqual(expect.objectContaining({
      evidence_origin: 'search_evidence_fallback_after_direct_no_usable_evidence', canonical_identifier: '00123456', role: 'seller',
    }));
  });
  it('fills a missing role while retaining direct identity evidence', async () => {
    const result = await run('<p>Alpha Limited, company number 00123456.</p>');
    expect(result.overall.recommended_action).toBe('PROPOSE');
    const origins = result.selected_candidate?.evidence_groups.flatMap(g => g.occurrences.map(o => o.evidence_origin));
    expect(origins).toContain('discovered_url_direct');
    expect(origins).toContain('search_evidence_fallback_after_direct_no_usable_evidence');
  });
  it('complete direct facts take precedence over conflicting snippets', async () => {
    const result = await run(`<p>${seller}</p>`, [claim(seller.replace('Alpha', 'Other'))]);
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.retrieval_channel).toBe('direct_http');
  });
  it.each([
    '<p>Other Limited, company number 00123456.</p>',
    '<p>Alpha Limited, company number 00999999.</p>',
    '<p>The seller is Other Limited.</p>',
    '<p>Alpha Limited is not the seller. Company number 00123456.</p>',
  ])('fallback cannot override contradictory direct facts: %s', async html => {
    const result = await run(html);
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.proposals.some(p => p.signals.some(s => s.code === 'direct_evidence_conflict'))).toBe(true);
  });
  it('does not fuse a snippet with a successful redirect to a different canonical document', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page('<p>Alpha Limited</p>', root + 'privacy'),
      companiesHouse: registry(), discover: async () => discovery() });
    expect(result.overall.recommended_action).toBe('UNRESOLVED');
  });
  it('cannot use model possible_role without a deterministic role in either channel', async () => {
    const result = await run('<p>Alpha Limited, company number 00123456.</p>', [claim('Alpha Limited, company number 00123456.')]);
    expect(result.overall.recommended_action).toBe('REVIEW');
  });
});

describe('website-operation wording through discovered full-document extraction', () => {
  it.each([
    ['23.1 This website is owned and operated by Medik8 Ltd.', 'Medik8 Ltd', 'MEDIK8 LIMITED'],
    ['“This website” is owned and operated by Alpha Limited.', 'Alpha Limited', 'ALPHA LIMITED'],
    ['www.example.com is operated by Alpha Limited.', 'Alpha Limited', 'ALPHA LIMITED'],
    ['the website is operated by Alpha Limited.', 'Alpha Limited', 'ALPHA LIMITED'],
    ['These terms confirm that this website is operated by Alpha Limited.', 'Alpha Limited', 'ALPHA LIMITED'],
  ])('%s', async (wording, name, registryName) => {
    const result = await run(`<h1>Website terms</h1><p>${wording}</p><h2>Company information</h2><p>${name}, company number 00123456.</p>`, [claim('')], registry({ '00123456': registryName }));
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate).toMatchObject({ inferred_role: 'site_operator', retrieval_channel: 'direct_http', same_document_evidence_fusion: true });
  });
});

describe('entity-local market context', () => {
  const mixed = 'The seller is UK COMPANY LTD, registered in England and Wales, company number 00123456, and US COMPANY LLC, registered in Delaware, company number 00999999.';
  it('scopes each named occurrence to its own registration clause', () => {
    const named = extractNamedEvidence(`<p>${mixed}</p>`, terms);
    expect(named.map(o => [o.possible_legal_name, occurrenceMarketMismatch(o)])).toEqual([['UK COMPANY LTD', false], ['US COMPANY LLC', true]]);
    expect(extractCompanyCandidates(`<p>${mixed}</p>`, terms).map(c => [c.company_number, occurrenceMarketMismatch(c.occurrences[0]!)])).toEqual([['00123456', false], ['00999999', true]]);
  });
  it.each(['direct', 'fallback'])('foreign neighbour cannot contaminate the UK seller via %s', async channel => {
    const companiesHouse = registry({ '00123456': 'UK COMPANY LTD' });
    const result = await run(channel === 'direct' ? `<p>${mixed}</p>` : '', [claim(channel === 'fallback' ? mixed : '')], companiesHouse);
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00123456' });
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledExactlyOnceWith('00123456');
    expect(result.secondary_candidates.find(p => p.company_number === '00999999')?.verification.market_context_match).toBe(false);
  });
});

describe('GB source ranking and malformed-completion URL recovery', () => {
  it('attempts main terms before US terms and root privacy; recognises en_GB', async () => {
    const urls = ['https://us.example.com/terms', root + 'privacy', root + 'en_GB/conditions', terms];
    const fetchDiscoveredPage = vi.fn(async (url: string) => page('<p>Information</p>', url));
    await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage, companiesHouse: registry(), discover: async () => discovery(urls.map(url => claim('', url))) });
    expect(fetchDiscoveredPage.mock.calls.map(c => c[0])).toEqual([terms, root + 'en_GB/conditions', root + 'privacy', 'https://us.example.com/terms']);
  });
  it.each([true, false])('invalid completion is recovered only when direct verification succeeds: %s', async recover => {
    const request = vi.fn(async () => ({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://evil.org/terms' }, { type: 'url', url: terms }] } },
      { type: 'message', content: [{ type: 'output_text', text: '{malformed-private-payload' }] },
    ] }));
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page(recover ? `<p>${seller}</p>` : '<p>No company evidence.</p>'),
      companiesHouse: registry(), discover: () => discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request) });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.discovery).toMatchObject({ status: 'invalid_response', validation_errors: [{ kind: 'malformed_json' }, { kind: 'malformed_json' }] });
    expect(result.discovery?.recovered_by).toBe(recover ? 'deterministic_source_retrieval' : undefined);
    expect(result.discovered_sources?.map(s => s.url)).toEqual([terms]);
    expect(JSON.stringify(result)).not.toContain('malformed-private-payload');
    const directory = await mkdtemp(join(tmpdir(), 'v241-'));
    try {
      const output = join(directory, 'run');
      const summary = await runBenchmark([{ brand_name: 'Example', domain: 'example.com', target_market: 'GB' }], {
        output, resolve: async () => result, metadata: { benchmark_input_filename: 'mock.csv', benchmark_input_sha256: 'mock', git_commit_sha: 'mock', git_dirty: true,
          timestamp: 'mock', resolver_target_market: 'GB', resolver_version: 'V2.4.1', resolver_source_sha256: {}, openai_configuration: { model: 'mock', identifier: 'mock', allowed_domains: '[normalised input domain]', tool_choice: 'required', include_sources: true } },
      });
      expect(summary.ERROR).toBe(recover ? 0 : 1);
      expect(summary.PROPOSE).toBe(recover ? 1 : 0);
      if (!recover) expect(JSON.parse(await readFile(join(output, 'results.jsonl'), 'utf8')).error).toBe('discovery_invalid_response');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('conservative REVIEW display and retained protections', () => {
  it('multiple privacy affiliates are ambiguous, not a registry-strength choice', async () => {
    const html = '<h1>Privacy policy</h1><p>Alpha Limited, company number 00123456, is the data controller.</p><p>Beta Limited, company number 00999999, is the data controller.</p>';
    const result = await run(html, [claim('', root + 'privacy')], registry({ '00999999': 'BETA LIMITED' }));
    expect(result.overall).toMatchObject({ recommended_action: 'REVIEW', reason: 'ambiguous_legal_entity' });
    expect(result.selected_candidate).toBeNull();
  });
  it('transactional context wins REVIEW presentation over a stronger registry-matched privacy affiliate', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async url => page(url === terms
      ? '<p>Alpha Limited, company number 00123456.</p>' : '<h1>Privacy policy</h1><p>Beta Limited, company number 00999999, is the data controller.</p>', url),
      companiesHouse: registry({ '00123456': 'RENAMED LIMITED', '00999999': 'BETA LIMITED' }), discover: async () => discovery([claim('', root + 'privacy'), claim('')]) });
    expect(result.overall).toMatchObject({ recommended_action: 'REVIEW', company_number: '00123456' });
    expect(result.selected_candidate?.verification.legal_name_verified).toBe(false);
  });
  it('an applicant heading cannot be erased by a same-URL shopping snippet', async () => {
    const result = await run('<h1>Job applicant notice</h1><p>We are Alpha Limited, company number 00123456.</p>');
    expect(result.overall.recommended_action).not.toBe('PROPOSE');
  });
  it.each([
    ['<h1>Job applicant notice</h1><p>We are Alpha Limited, company number 00123456.</p>', root + 'applicant-notice'],
    ['<p>The mobile message service is operated by Alpha Limited, company number 00123456.</p>', terms],
    ['<p>Alpha Limited, company number 00123456, is the data controller.</p>', root + 'privacy'],
  ])('non-shopping sources/roles remain ineligible: %s', async (html, url) => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page(html, url), companiesHouse: registry(), discover: async () => discovery([claim('', url)]) });
    expect(result.overall.recommended_action).not.toBe('PROPOSE');
  });
});
