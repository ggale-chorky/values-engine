import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates } from '../src/resolution/extract-company-candidates.js';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import { discoverFirstPartyEvidence } from '../src/resolution/discover-first-party-evidence.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import type { PageResult } from '../src/resolution/fetch-first-party-page.js';
import { sourcePriority } from '../src/resolution/source-priority.js';

const home = 'https://example.com/';
const terms = 'https://example.com/uk/terms-of-sale';
const input = { brand_name: 'Example', domain: 'example.com', source_url: home, target_market: 'GB' as const };
const seller = 'Goods supplied from the Website are supplied by Alpha Limited, company number 00123456.';
const site = 'This website is owned and operated by Alpha Limited, company number 00123456.';
const blocked = async (url: string): Promise<PageResult> => ({ ok: false, status: 'source_unavailable', reason: 'blocked', source_url: url, http_status: 403 });
const page = (html: string, url = terms): PageResult => ({ ok: true, source_url: url, final_url: url, content_type: 'text/html', content: html });
const registry = (name = 'ALPHA LIMITED') => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number, company_name: name, company_status: 'active' })) });
const claim = (evidence_text = '', source_url = terms): DiscoveryCandidate => ({ source_url, source_domain: 'example.com', evidence_text,
  possible_legal_name: null, possible_company_number: null, possible_role: 'unknown' });
const discovery = (candidates: DiscoveryCandidate[]): DiscoveryResult => ({ status: 'success', candidates, sources: candidates.map(c => ({ type: 'url', url: c.source_url! })) });
const run = (html: string, url = terms, companyName = 'ALPHA LIMITED') => resolveWithDiscovery({ ...input, source_url: url }, {
  fetchPage: async () => page(html, url), companiesHouse: registry(companyName), discover: async () => discovery([]),
});

describe('V2.4 semantic shopping objects (synthetic evidence patterns)', () => {
  it.each([
    [seller, 'seller'], [site, 'site_operator'],
    ["Alpha Limited (company number 00123456) operates this website's mobile message service.", 'unknown'],
    ['The application process on this website is operated by Alpha Limited, company number 00123456.', 'unknown'],
    ['Website operated by Alpha Limited, company number 00123456.', 'site_operator'],
    ['Alpha Limited (company number 00123456) operates this website.', 'site_operator'],
    ['This webshop is operated by Alpha Limited, company number 00123456.', 'site_operator'],
    ['We are Alpha Limited, company number 00123456.', 'unknown'],
    ['The mobile message service is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The loyalty programme is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The competition is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The application process is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The app is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The tool is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['The feature is operated by Alpha Limited, company number 00123456.', 'service_operator'],
    ['Alpha Limited (company number 00123456) is the promoter of the Program.', 'promoter'],
  ])('%s -> %s', (text, role) => expect(extractCompanyCandidates(`<p>${text}</p>`, terms)[0]?.occurrences[0]?.role).toBe(role));

  it('applicant-notice identity wording does not establish a shopping operator (ELEMIS failure pattern)', async () => {
    const result = await run('<h1>Job applicant privacy notice</h1><p>We are Alpha Limited, company number 00123456.</p>', 'https://example.com/applicant-notice');
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.proposals[0]?.verification.role_relevant).toBe(false);
    expect(result.proposals[0]?.evidence_groups[0]?.occurrences[0]?.source_exclusion).toBe('non_shopping_recruitment');
  });
  it('mobile-message operator does not establish a shopping operator (FaceGym failure pattern)', async () => {
    const result = await run('<p>The mobile message service is operated by Alpha Limited, company number 00123456.</p>');
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.selected_candidate?.inferred_role).toBe('service_operator');
  });
  it('fuses same-document seller and registration sections deterministically', async () => {
    const result = await run('<h1>Website terms</h1><p>Goods supplied from the Website are supplied by Alpha Limited.</p><h2>Registration details</h2><p>Alpha Limited, company number 00123456.</p>');
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.same_document_evidence_fusion).toBe(true);
  });
  it('registry/current-page name mismatch stays REVIEW, with no assumed alias', async () => {
    const result = await run(`<p>${site}</p>`, terms, 'BETA LIMITED');
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.proposals[0]?.reason).toBe('conflicting_company_evidence');
  });
});

describe('V2.4 URL-first discovery and retained secondary sources', () => {
  it('retrieves full documents and prefers their deterministic facts over model snippets', async () => {
    const fetchDiscoveredPage = vi.fn(async url => page(`<p>${seller}</p>`, url as string));
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage, companiesHouse: registry(),
      discover: async () => discovery([claim('The seller is Other Limited, company number 00123456.')]) });
    expect(fetchDiscoveredPage).toHaveBeenCalledExactlyOnceWith(terms);
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.retrieval_channel).toBe('direct_http');
    expect(result.selected_candidate?.evidence_groups[0]?.occurrences[0]).toMatchObject({ evidence_origin: 'discovered_url_direct', discovered_url: terms });
    expect(result.discovery?.candidates[0]?.evidence_text).toContain('Other Limited');
  });
  it('recovers embedded full-document evidence from a URL-only discovery candidate', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page(`<script type="application/json">${JSON.stringify({ content: seller })}</script>`),
      companiesHouse: registry(), discover: async () => discovery([claim()]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.retrieval_channel).toBe('embedded_page_data');
  });
  it('fuses complementary sections from the full discovered document, not the selected quote', async () => {
    const html = '<p>This website is owned and operated by Alpha Limited.</p><h2>Registration</h2><p>Alpha Limited, company number 00123456.</p>';
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page(html),
      companiesHouse: registry(), discover: async () => discovery([claim('Alpha Limited, company number 00123456.')]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate).toMatchObject({ inferred_role: 'site_operator', same_document_evidence_fusion: true });
    expect(result.selected_candidate?.evidence_groups.flatMap(group => group.occurrences).every(o => o.evidence_origin === 'discovered_url_direct')).toBe(true);
  });
  it('a discovered fetch exception is safe and uses fallback without exposing exception text', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => { throw new Error('private-transport-secret'); },
      companiesHouse: registry(), discover: async () => discovery([claim(site)]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.discovered_sources?.[0]?.outcome).toBe('network_error');
    expect(JSON.stringify(result)).not.toContain('private-transport-secret');
  });
  it('blocked discovered URL uses attributable search fallback and independent verification', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([claim(site)]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.evidence_groups[0]?.occurrences[0]?.evidence_origin).toBe('search_evidence_fallback');
    expect(result.discovered_sources?.[0]).toMatchObject({ outcome: 'blocked', evidence_origin: 'search_evidence_fallback' });
  });
  it('ordinary successful document with no evidence does not fall back to a contradictory snippet', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page('<p>' + 'General information. '.repeat(15) + '</p>'),
      companiesHouse: registry(), discover: async () => discovery([claim(site)]) });
    expect(result.overall.recommended_action).toBe('UNRESOLVED');
    expect(result.discovered_sources?.[0]?.evidence_origin).toBe('discovered_url_direct');
  });
  it('deduplicates retrieval while retaining multiple blocked-source snippets for fusion', async () => {
    const fetchDiscoveredPage = vi.fn(blocked);
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage, companiesHouse: registry(),
      discover: async () => discovery([claim('This website is operated by Alpha Limited.'), claim('Alpha Limited, company number 00123456.')]) });
    expect(fetchDiscoveredPage).toHaveBeenCalledOnce();
    expect(result.selected_candidate?.same_document_evidence_fusion).toBe(true);
  });
  it('rejects off-domain redirects rather than using their document or fallback', async () => {
    const companiesHouse = registry();
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage: async () => page(`<p>${site}</p>`, 'https://evil.org/terms'),
      companiesHouse, discover: async () => discovery([claim(site)]) });
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
    expect(result.overall.recommended_action).toBe('UNRESOLVED');
  });
  it('ranks UK legal sources first and retains foreign, career and co-controller evidence as secondary', async () => {
    const urls = ['https://us.example.com/terms', 'https://example.com/careers/applicant-notice', 'https://example.com/privacy', terms];
    const documents = [site.replaceAll('Alpha', 'Foreign').replaceAll('00123456', '00999999'), site.replaceAll('Alpha', 'Careers').replaceAll('00123456', '00888888'),
      'Beta Limited (company number 00777777) is the data controller. We are co-controllers of your data.', seller];
    const fetchDiscoveredPage = vi.fn(async (url: string) => page(`<p>${documents[urls.indexOf(url)]}</p>`, url));
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, fetchDiscoveredPage, companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_status: 'active', company_name: company_number === '00123456' ? 'ALPHA LIMITED' : company_number === '00777777' ? 'BETA LIMITED' : 'CAREERS LIMITED' })) },
      discover: async () => discovery(urls.map(url => claim('', url))) });
    expect(fetchDiscoveredPage.mock.calls[0]?.[0]).toBe(terms);
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00123456' });
    expect(result.secondary_candidates).toHaveLength(3);
    expect(result.secondary_candidates.flatMap(c => c.evidence_groups.flatMap(g => g.occurrences)).some(o => o.source_exclusion === 'foreign_market')).toBe(true);
  });
  it('source ranking does not resolve competing verified shopping entities by popularity', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(),
      discover: async () => discovery([claim(site), claim(site.replace('00123456', '00999999'), 'https://example.com/legal-notice')]) });
    expect(result.overall.reason).toBe('ambiguous_legal_entity');
    expect(result.overall.recommended_action).toBe('REVIEW');
  });
  it('prefers UK terms over root privacy and foreign subdomains', () => {
    expect(sourcePriority(terms).priority).toBeGreaterThan(sourcePriority('https://example.com/privacy').priority);
    expect(sourcePriority('https://us.example.com/terms').exclusion).toBe('foreign_market');
  });
});

const response = (text: string) => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: terms }] } },
  { type: 'message', content: [{ type: 'output_text', text }] },
] });
describe('V2.4 bounded structured-output repair (mocked OpenAI transport)', () => {
  it.each([
    ['{broken', 'malformed_json'], ['{}', 'missing_fields'], ['{"candidates":"secret-value"}', 'schema_mismatch'],
  ])('repairs %s once with safe %s diagnostics', async (invalid, kind) => {
    const request = vi.fn().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(JSON.stringify({ candidates: [claim()] })));
    const result = await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'success', attempts: 2, validation_errors: [{ kind, attempt: 1 }] });
    expect(JSON.stringify(result.validation_errors)).not.toContain('secret-value');
    for (const [params] of request.mock.calls) expect(params).toMatchObject({ tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }], tool_choice: 'required', include: ['web_search_call.action.sources'] });
  });
  it('a second invalid answer remains discovery_invalid_response / ERROR, without further retries', async () => {
    const request = vi.fn(async () => response('{bad'));
    const discoveryResult = await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(discoveryResult.status).toBe('invalid_response');
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discoveryResult });
    expect(result.discovery?.status).toBe('invalid_response');
    expect(result.attempts.at(-1)?.outcome).toBe('invalid_response');
  });
  it('a failed repair transport retains discovery_invalid_response and safe provider diagnostics', async () => {
    const request = vi.fn().mockResolvedValueOnce(response('{bad')).mockRejectedValue({ status: 503, message: 'private-secret' });
    const result = await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request, async () => {});
    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: 'invalid_response', error: { http_status: 503 }, validation_errors: [{ kind: 'malformed_json' }] });
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });
  it('transient retry plus parse repair remains bounded to three requests', async () => {
    const request = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue(response('{bad'));
    const result = await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request, async () => {});
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('invalid_response');
  });
});
