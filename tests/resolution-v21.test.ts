import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { discoverFirstPartyEvidence, firstPartyUrl, normaliseDiscoveryDomain } from '../src/resolution/discover-first-party-evidence.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import { resolveBrandLegalEntity } from '../src/resolution/resolve-brand-legal-entity.js';
import { extractCompanyCandidates } from '../src/resolution/extract-company-candidates.js';
import type { PageResult } from '../src/resolution/fetch-first-party-page.js';
import { CompaniesHouseError } from '../src/resolution/companies-house.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/resolution/${name}`, import.meta.url), 'utf8');
const source = 'https://www.vichy.co.uk/terms-of-use';
const input = { brand_name: 'Vichy', source_url: source, domain: 'vichy.co.uk' };
const blocked = async (): Promise<PageResult> => ({ ok: false, source_url: source, status: 'source_unavailable', http_status: 403, reason: 'blocked' });
const page = (content: string) => async (): Promise<PageResult> => ({ ok: true, source_url: source, final_url: source, content_type: 'text/html', content });
const company = () => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number, company_name: "L'OREAL (U.K.) LIMITED", company_status: 'active' })) });
const result = (candidate: DiscoveryCandidate): DiscoveryResult => ({ status: 'success', candidates: [candidate], sources: [{ type: 'url', url: source }] });
const vichy = async (): Promise<DiscoveryCandidate> => JSON.parse(await fixture('vichy-discovery.json')) as DiscoveryCandidate;

describe('canonical first-party domains', () => {
  it.each(['vichy.co.uk', 'www.vichy.co.uk', 'VICHY.CO.UK.', 'www.VICHY.co.uk.'])('normalises %s', domain => {
    expect(normaliseDiscoveryDomain(domain)).toBe('vichy.co.uk');
    expect(firstPartyUrl(`https://${domain}/terms-of-use`, 'WWW.VICHY.CO.UK.')).toBe('https://vichy.co.uk/terms-of-use');
  });
  it('allows genuine subdomains', () => expect(firstPartyUrl('https://legal.vichy.co.uk/terms', 'vichy.co.uk')).toBe('https://legal.vichy.co.uk/terms'));
  it.each(['vichy.co.uk.evil.example', 'fakevichy.co.uk', 'evilvichy.co.uk', 'vichy.co.uk@evil.example'])('rejects %s', host => {
    expect(firstPartyUrl(`https://${host}/terms`, 'vichy.co.uk')).toBeNull();
  });
});

describe('V2.1 known-answer regressions', () => {
  it('Vichy www URL plus model bare domain survives validation and deterministic verification', async () => {
    const companiesHouse = company();
    const candidate = await vichy();
    const resolved = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => result(candidate) });
    expect(resolved.discovery_rejections).toEqual([]);
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledExactlyOnceWith('00271555');
    expect(resolved.proposals[0]).toMatchObject({ source_url: source, company_number: '00271555', candidate_legal_entity_name: "L'OREAL (U.K.) LIMITED",
      inferred_role: 'site_operator', retrieval_channel: 'openai_web_search', recommended_action: 'PROPOSE' });
  });
  it('model source_domain is diagnostic only, even if missing or incorrect', async () => {
    for (const domain of [null, 'wrong.example']) {
      const resolved = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: company(), discover: async () => result({ ...await vichy(), source_domain: domain }) });
      expect(resolved.proposals[0]?.recommended_action).toBe('PROPOSE');
      expect(resolved.discovery?.candidates[0]?.source_domain).toBe(domain);
    }
  });
  it('Vichy cannot PROPOSE without Companies House verification', async () => {
    const candidate = await vichy();
    const resolved = await resolveWithDiscovery(input, { fetchPage: blocked,
      companiesHouse: { getCompanyProfile: vi.fn().mockRejectedValue(new CompaniesHouseError('not_found')) }, discover: async () => result(candidate) });
    expect(resolved.proposals[0]).toMatchObject({ recommended_action: 'REVIEW', companies_house_match: null });
  });
  it('model fields alone cannot produce a Vichy proposal', async () => {
    const companiesHouse = company();
    const candidate = { ...await vichy(), evidence_text: 'Welcome to our website.' };
    const resolved = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => result(candidate) });
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
    expect(resolved.proposals.every(item => item.recommended_action !== 'PROPOSE')).toBe(true);
  });
  it('Charlotte supply-products seller is proposed while verified Islestarr licensor remains visible', async () => {
    const discover = vi.fn();
    const resolved = await resolveWithDiscovery({ ...input, brand_name: 'Charlotte Tilbury' }, {
      fetchPage: page(await fixture('charlotte-embedded.html')), discover,
      companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number,
        company_name: company_number === '08037372' ? 'CHARLOTTE TILBURY BEAUTY LIMITED' : 'ISLESTARR HOLDINGS LIMITED', company_status: 'active' })) },
    });
    expect(discover).not.toHaveBeenCalled();
    expect(resolved.proposals[0]).toMatchObject({ company_number: '08037372', inferred_role: 'seller', recommended_action: 'PROPOSE', retrieval_channel: 'embedded_page_data' });
    expect(resolved.proposals[0]?.evidence_groups[0]?.section_context).toContain('Subscriptions Terms & Conditions of Use');
    expect(resolved.proposals[1]).toMatchObject({ inferred_role: 'licensor', recommended_action: 'REVIEW', companies_house_match: { company_name: 'ISLESTARR HOLDINGS LIMITED' } });
    expect(resolved.proposals[1]?.evidence_groups[0]?.section_context).toContain('App Terms of Use');
    expect(resolved.proposals[0]?.conflicting_evidence).toEqual([]);
  });
  it('Estée stays promoter/REVIEW and survives discovery failure intact', async () => {
    const deps = { fetchPage: page(await fixture('estee-lauder.html')), companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: 'ESTEE LAUDER COSMETICS LIMITED', company_status: 'active' })) } };
    const brand = { ...input, brand_name: 'Estée Lauder' };
    const direct = await resolveBrandLegalEntity(brand, deps);
    const resolved = await resolveWithDiscovery(brand, { ...deps, discover: async () => { throw { status: 500, type: 'server_error', message: 'secret' }; } });
    expect(resolved.proposals).toEqual(direct);
    expect(resolved.proposals[0]).toMatchObject({ company_number: '00659213', inferred_role: 'promoter', recommended_action: 'REVIEW' });
    expect(resolved.discovery?.error).toMatchObject({ http_status: 500, type: 'server_error', retryable: true });
    expect(JSON.stringify(resolved)).not.toContain('secret');
  });
  it('flags an explicit different brand scope without relying on legal-name similarity', async () => {
    const companiesHouse = company();
    const candidate = { ...await vichy(), evidence_text: 'Brand: Other Beauty. This site is operated by L\'Oreal (UK) Limited, company number 00271555.' };
    const resolved = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => result(candidate) });
    expect(resolved.discovery_rejections).toContainEqual({ index: 0, reason: 'context_mismatch' });
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
    expect(resolved.discovery?.candidates).toContainEqual(candidate);
  });
  it('does not infer seller from a heading containing Sale or a supplier acting for someone else', () => {
    for (const html of [
      '<h1>Sale</h1><p>Alpha Limited, company number 00123456.</p>',
      '<p>Alpha Limited, company number 00123456. Other Limited supplies products to you.</p>',
      '<p>Alpha Limited, company number 00123456, does not supply products to you.</p>',
    ]) expect(extractCompanyCandidates(html, source)[0]?.occurrences[0]?.role).not.toBe('seller');
  });
});

describe('bounded safe discovery retries', () => {
  const success = { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } },
    { type: 'message', content: [{ type: 'output_text', text: '{"candidates":[]}' }] },
  ] };
  it.each([429, 500, 502, 503])('retries %s only once, preserving safe failure metadata', async status => {
    const request = vi.fn().mockRejectedValue({ status, type: 'server_error', code: 'server_error', message: 'secret', headers: { authorization: 'secret' } });
    const pause = vi.fn(async () => {});
    const response = await discoverFirstPartyEvidence({ brand: 'Vichy', domain: 'vichy.co.uk' }, request, pause);
    expect(request).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledExactlyOnceWith(500);
    expect(response).toMatchObject({ status: 'api_error', attempts: 2, error: { http_status: status, type: 'server_error', code: 'server_error', retryable: true } });
    expect(JSON.stringify(response)).not.toContain('secret');
  });
  it('retries a network failure once and can recover', async () => {
    const request = vi.fn().mockRejectedValueOnce({ code: 'ECONNRESET' }).mockResolvedValueOnce(success);
    const response = await discoverFirstPartyEvidence({ brand: 'Vichy', domain: 'vichy.co.uk' }, request, async () => {});
    expect(request).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({ status: 'success', attempts: 2 });
  });
  it.each([400, 401, 403])('does not retry %s', async status => {
    const request = vi.fn().mockRejectedValue({ status, type: 'invalid_request_error', code: 'invalid_parameter' });
    const pause = vi.fn(async () => {});
    const response = await discoverFirstPartyEvidence({ brand: 'Vichy', domain: 'vichy.co.uk' }, request, pause);
    expect(request).toHaveBeenCalledOnce(); expect(pause).not.toHaveBeenCalled();
    expect(response).toMatchObject({ status: 'api_error', attempts: 1, error: { http_status: status, retryable: false } });
  });
});
