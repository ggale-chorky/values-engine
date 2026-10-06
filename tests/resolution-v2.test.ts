import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates } from '../src/resolution/extract-company-candidates.js';
import { extractEmbeddedEvidence } from '../src/resolution/extract-embedded-evidence.js';
import { contentDiagnostics, fetchFirstPartyPage } from '../src/resolution/fetch-first-party-page.js';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import { discoverFirstPartyEvidence } from '../src/resolution/discover-first-party-evidence.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import { CompaniesHouseError } from '../src/resolution/companies-house.js';

const source = 'https://www.example.com/terms';
const input = { brand_name: 'Example', source_url: source, domain: 'example.com' };
const seller = 'The seller is Alpha Limited, company number 00123456.';
const candidate = (evidence_text = seller, source_url: string | null = source): DiscoveryCandidate => ({ source_url,
  source_domain: 'www.example.com', evidence_text, possible_company_number: '00123456', possible_legal_name: 'Alpha Limited', possible_role: 'seller' });
const discovery = (candidates = [candidate()]): DiscoveryResult => ({ status: 'success', candidates, sources: [{ type: 'url', url: source }] });
const profile = () => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number, company_name: 'ALPHA LIMITED', company_status: 'active' })) });
const blocked = async () => fetchFirstPartyPage(source, async () => ({ status: 403, headers: {}, body: '' }));
const page = (body: string) => async () => fetchFirstPartyPage(source, async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }));

// Every HTTP, Companies House and OpenAI dependency is mocked; no real key is needed.
describe('V1.3 deterministic evidence', () => {
  it('retains promoter across intervening registration details in the live-style Estée block', async () => {
    const html = await readFile(new URL('./fixtures/resolution/estee-lauder.html', import.meta.url), 'utf8');
    const [item] = extractCompanyCandidates(html, source);
    expect(item).toMatchObject({ company_number: '00659213', occurrences: [{ possible_legal_name: 'Estée Lauder Cosmetics Limited', role: 'promoter' }] });
  });
  it('marks large HTML with disproportionately little visible text as heuristically incomplete', () => {
    const html = '<script>' + 'x'.repeat(814_000) + '</script><p>' + 'A'.repeat(1494) + '</p>';
    expect(contentDiagnostics(html, 'text/html')).toMatchObject({ outcome: 'retrieved_content_incomplete', content_heuristic: 'large_html_low_text_ratio', visible_text_character_count: 1494 });
  });
  it('binds the postfix promoter across address sentence segmentation within one block', () => {
    const html = '<p>Estée Lauder Cosmetics Limited, registered at a UK address. (company number 00659213) is the promoter of the Program.</p>';
    expect(extractCompanyCandidates(html, source)[0]?.occurrences[0]).toMatchObject({ possible_legal_name: 'Estée Lauder Cosmetics Limited', role: 'promoter' });
  });
  it('does not bind a block-wide predicate when another named company intervenes', () => {
    const html = '<p>Alpha Limited, registered in the UK, works with Beta Limited (company number 00123456) is the promoter of the Program.</p>';
    const occurrence = extractCompanyCandidates(html, source)[0]?.occurrences[0];
    expect(occurrence?.possible_legal_name).toBe('Beta Limited');
    expect(occurrence?.possible_legal_name).not.toBe('Alpha Limited');
  });
  it('extracts explicit JSON company fields without inventing a shopping role', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', legalName: 'Alpha Limited', companyNumber: '00123456' })}</script>`;
    expect(extractEmbeddedEvidence(html, source)[0]).toMatchObject({ company_number: '00123456', occurrences: [{ possible_legal_name: 'Alpha Limited', role: 'unknown', extraction_channel: 'structured_data' }] });
  });
  it.each(['application/ld+json', 'application/json'])('extracts prose from %s while preserving its JSON location', type => {
    const extracted = extractEmbeddedEvidence(`<script type="${type}">${JSON.stringify({ description: seller })}</script>`, source);
    expect(extracted[0]).toMatchObject({ company_number: '00123456', occurrences: [{ role: 'seller', retrieval_channel: 'embedded_page_data',
      extraction_channel: type === 'application/ld+json' ? 'structured_data' : 'embedded_page_state' }] });
    expect(extracted[0]?.occurrences[0]?.block.dom_path).toContain('["description"]');
  });
  it('does not execute scripts or join unrelated JSON values', () => {
    expect(extractEmbeddedEvidence(`<script>throw new Error('executed'); ${seller}</script>`, source)).toEqual([]);
    const extracted = extractEmbeddedEvidence(`<script type="application/json">${JSON.stringify({ a: 'The seller is Alpha Limited.', b: 'Company number 00123456' })}</script>`, source);
    expect(extracted[0]?.occurrences[0]).toMatchObject({ possible_legal_name: null, role: 'unknown' });
    expect(extractEmbeddedEvidence('<script type="application/json">{broken</script>', source)).toEqual([]);
  });
});

describe('discovery orchestration', () => {
  it('prefers direct success without invoking discovery', async () => {
    const discover = vi.fn();
    const result = await resolveWithDiscovery(input, { fetchPage: page(`<p>${seller}</p>`), companiesHouse: profile(), discover });
    expect(discover).not.toHaveBeenCalled();
    expect(result.proposals[0]).toMatchObject({ recommended_action: 'PROPOSE', retrieval_channel: 'direct_http' });
  });
  it('recovers Next.js page data before invoking discovery', async () => {
    const discover = vi.fn();
    const html = `<main>Loading</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { legal: `<p>${seller}</p>` } })}</script>`;
    const result = await resolveWithDiscovery(input, { fetchPage: page(html), companiesHouse: profile(), discover });
    expect(discover).not.toHaveBeenCalled();
    expect(result.proposals[0]).toMatchObject({ recommended_action: 'PROPOSE', retrieval_channel: 'embedded_page_data' });
  });
  it('keeps unrelated malformed JSON diagnostic without vetoing verified embedded evidence', async () => {
    const html = `<script type="application/json">${JSON.stringify({ description: seller })}</script><script type="application/json">{broken</script>`;
    const result = await resolveWithDiscovery(input, { fetchPage: page(html), companiesHouse: profile(), discover: vi.fn() });
    expect(result.proposals[0]).toMatchObject({ recommended_action: 'PROPOSE', reason: 'verified_operating_entity' });
    expect(result.proposals[0]?.signals.some(signal => signal.code === 'embedded_inspection_incomplete')).toBe(true);
  });
  it('blocked source invokes domain-restricted discovery and verifies its evidence', async () => {
    const discover = vi.fn(async () => discovery());
    const companiesHouse = profile();
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover });
    expect(discover).toHaveBeenCalledExactlyOnceWith({ brand: 'Example', domain: 'example.com' });
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledExactlyOnceWith('00123456');
    expect(result.proposals[0]).toMatchObject({ recommended_action: 'PROPOSE', retrieval_channel: 'openai_web_search', companies_house_match: { company_name: 'ALPHA LIMITED' } });
    expect(result.direct_proposals[0]?.reason).toBe('source_blocked');
    expect(result.discovery?.sources).toEqual(discovery().sources);
  });
  it.each(['', '<p>' + 'General customer help. '.repeat(12) + '</p>', '<script>' + 'x'.repeat(814_000) + '</script><p>' + 'A'.repeat(1494) + '</p>'])
    ('falls back for a shell, no evidence or incomplete content', async html => {
      const discover = vi.fn(async () => discovery());
      const result = await resolveWithDiscovery(input, { fetchPage: page(html), fetchDiscoveredPage: blocked, companiesHouse: profile(), discover });
      expect(discover).toHaveBeenCalledOnce();
      expect(result.proposals[0]?.recommended_action).toBe('PROPOSE');
    });
  it('requires REVIEW when Companies House cannot verify search evidence', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: { getCompanyProfile: vi.fn().mockRejectedValue(new CompaniesHouseError('not_found')) }, discover: async () => discovery() });
    expect(result.proposals[0]).toMatchObject({ recommended_action: 'REVIEW', companies_house_match: null });
  });
  it.each([null, 'https://evil.example/terms', 'https://example.com.evil.org/terms', 'https://example.com@evil.org/terms'])
    ('rejects an absent or wrong-domain source: %s', async url => {
      const companiesHouse = profile();
      const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => discovery([candidate(seller, url)]) });
      expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
      expect(result.discovery_rejections[0]?.reason).toBe('missing_or_wrong_domain');
      expect(result.proposals[0]?.recommended_action).toBe('UNRESOLVED');
    });
  it('rejects URLs invented in model output but absent from the API source list', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: profile(), discover: async () => ({ ...discovery(), sources: [] }) });
    expect(result.discovery_rejections[0]?.reason).toBe('source_not_in_search_sources');
    expect(result.proposals[0]?.recommended_action).toBe('UNRESOLVED');
  });
  it('does not trust model name, number and role fields without supporting text', async () => {
    const companiesHouse = profile();
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => discovery([candidate('Welcome to our shop.')]) });
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
    expect(result.proposals.at(-1)?.recommended_action).toBe('REVIEW');
  });
  it('conflicting discovered operating entities require REVIEW with conflicts retained', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: profile(), discover: async () => discovery([candidate(), candidate('The seller is Other Limited, company number 00123456.')]) });
    expect(result.proposals[0]?.recommended_action).toBe('REVIEW');
    expect(result.proposals[0]?.conflicting_evidence).toHaveLength(1);
  });
  it('multiple discovered company identifiers cannot produce a guessed operator', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: profile(), discover: async () => discovery([candidate(), candidate('The site is operated by Alpha Limited, company number 00876543.')]) });
    expect(result.proposals.map(proposal => proposal.recommended_action)).toEqual(['REVIEW', 'REVIEW']);
  });
  it('does not reinterpret a promoter as a shopping operator', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: profile(), discover: async () => discovery([candidate('Alpha Limited (company number 00123456) is the promoter of the Program.')]) });
    expect(result.proposals[0]).toMatchObject({ inferred_role: 'promoter', recommended_action: 'REVIEW' });
  });
  it('returns direct diagnostics safely on discovery errors', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: profile(), discover: async () => { throw new Error('secret'); } });
    expect(result.discovery?.status).toBe('api_error');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('OpenAI Responses adapter (mocked transport)', () => {
  const output = (answer: unknown = { candidates: [candidate()] }) => ({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: source }, { type: 'url', url: 'https://www.example.com/about' }] } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
  ] });
  it('uses current domain-filtered web_search and preserves the complete source list', async () => {
    const request = vi.fn(async () => output());
    const result = await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }], include: ['web_search_call.action.sources'], store: false, tool_choice: 'required' }));
    expect(result.status).toBe('success');
    expect(result.sources).toHaveLength(2);
    expect(result.candidates[0]?.possible_company_number).toBe('00123456');
  });
  it('fails closed without a completed search/source list or valid JSON', async () => {
    for (const raw of [
      { ...output(), status: 'incomplete' },
      { status: 'completed', output: [] },
      output({ candidates: [{ evidence_text: seller }] }),
      { status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search' } }] },
    ]) expect((await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, async () => raw)).status).toBe('invalid_response');
  });
  it('rejects invalid domains before any request and hides raw API errors', async () => {
    const request = vi.fn(async () => { throw new Error('secret API detail'); });
    expect((await discoverFirstPartyEvidence({ brand: 'Example', domain: 'https://example.com' }, request)).status).toBe('invalid_domain');
    expect(request).not.toHaveBeenCalled();
    expect(await discoverFirstPartyEvidence({ brand: 'Example', domain: 'example.com' }, request)).toEqual({ status: 'api_error', candidates: [], sources: [], attempts: 1, error: { http_status: null, type: 'api_error', code: null, retryable: false } });
  });
});
