import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates } from '../src/resolution/extract-company-candidates.js';
import { extractEmbeddedEvidence } from '../src/resolution/extract-embedded-evidence.js';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import { selectCandidate } from '../src/resolution/select-candidate.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import type { PageResult } from '../src/resolution/fetch-first-party-page.js';
import { marketContextMismatch } from '../src/resolution/evidence-market.js';

const url = 'https://www.example.com/uk/terms';
const input = { brand_name: 'Example', domain: 'example.com', source_url: url, target_market: 'GB' as const };
const blocked = async (): Promise<PageResult> => ({ ok: false, source_url: url, status: 'source_unavailable', reason: 'blocked', http_status: 403 });
const page = (content: string) => async (): Promise<PageResult> => ({ ok: true, source_url: url, final_url: url, content_type: 'text/html', content });
const claim = (evidence_text: string, source_url = url): DiscoveryCandidate => ({ evidence_text, source_url, source_domain: 'example.com',
  possible_legal_name: null, possible_company_number: null, possible_role: 'unknown' });
const discovery = (candidates: DiscoveryCandidate[]): DiscoveryResult => ({ status: 'success', candidates,
  sources: candidates.map(candidate => ({ type: 'url', url: candidate.source_url! })) });
const alpha = 'The seller is Alpha Limited, company number 00123456.';
const registry = () => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number,
  company_name: company_number === '00123456' ? 'ALPHA LIMITED' : 'BETA LIMITED', company_status: 'active' })) });
const read = (name: string) => readFile(new URL(`./fixtures/resolution/${name}`, import.meta.url), 'utf8');

describe('safe UK identifiers', () => {
  it.each(['1', '659213', '00659213'])('pads only explicitly UK-labelled numeric identifier %s', number => {
    const candidate = extractCompanyCandidates(`The seller is Alpha Limited, UK company registration number ${number}.`, url)[0];
    expect(candidate?.company_number).toBe(number.padStart(8, '0'));
    expect(candidate?.occurrences[0]).toMatchObject({ raw_identifier: number, canonical_identifier: number.padStart(8, '0') });
  });
  it('recognises an England and Wales registration qualifier', () => {
    expect(extractCompanyCandidates('Alpha Limited is registered in England and Wales under company number 659213.', url)[0]?.company_number).toBe('00659213');
  });
  it.each(['659213', 'Call 659213', 'Company number 659213', 'US company registration number 659213'])('does not pad %s', text => {
    expect(extractCompanyCandidates(text, url)).toEqual([]);
  });
  it.each(['SC123456', 'NI123456', 'OC123456', 'RC123456'])('preserves prefixed identifier %s', number => {
    expect(extractCompanyCandidates(`Alpha Limited, company number ${number}.`, url)[0]?.occurrences[0]).toMatchObject({ raw_identifier: number, canonical_identifier: number });
  });
});

describe('candidate-specific verification and selection', () => {
  it('one fully verified candidate plus five unusable candidates still produces PROPOSE', async () => {
    const candidates = [claim('No identifier supplied.'), claim('The seller is Beta Limited, company number 00999999.', 'https://www.example.com/us/terms'),
      claim('The promoter is Beta Limited, company number 00222222.'), claim('The licensor is Beta Limited, company number 00333333.'),
      claim('Incomplete Limited, company number 00444444.'), claim(alpha)];
    const companiesHouse = { getCompanyProfile: vi.fn(async (company_number: string) => {
      if (company_number === '00444444') throw new Error('registry unavailable');
      return { company_number, company_name: company_number === '00123456' ? 'ALPHA LIMITED' : 'BETA LIMITED', company_status: 'active' };
    }) };
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse, discover: async () => discovery(candidates) });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00123456' });
    expect(result.selected_candidate?.verification).toEqual({ source_validated: true, identifier_extracted_deterministically: true,
      registry_verified: true, registry_active: true, legal_name_verified: true, role_relevant: true, market_context_match: true,
      brand_context_match: true, blocking_conflict: false });
    expect(result.discovery?.candidates).toHaveLength(6);
    expect(result.secondary_candidates.length).toBeGreaterThan(0);
    expect(result.proposals.some(proposal => proposal.signals.some(signal => signal.code === 'unverified_discovery_candidate'))).toBe(false);
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalledWith('00999999');
    result.selected_candidate!.confidence.score = 0;
    expect(selectCandidate(result.proposals).overall.recommended_action).toBe('PROPOSE');
  });
  it('two verified relevant entities require REVIEW regardless of discovery ordering', async () => {
    const candidates = [claim(alpha), claim('The seller is Beta Limited, company number 00654321.')];
    for (const order of [candidates, [...candidates].reverse()]) {
      const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery(order) });
      expect(result.overall).toEqual({ recommended_action: 'REVIEW', reason: 'ambiguous_legal_entity', company_number: null });
      expect(result.selected_candidate).toBeNull();
      expect(result.supporting_candidates).toHaveLength(2);
    }
  });
  it('a registry failure remains a review candidate without vetoing another verified operator', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: { getCompanyProfile: vi.fn(async number => {
      if (number !== '00123456') throw new Error('unavailable');
      return { company_number: number, company_name: 'ALPHA LIMITED', company_status: 'active' };
    }) }, discover: async () => discovery([claim(alpha), claim('The seller is Beta Limited, company number 00654321.')]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.secondary_candidates[0]?.verification.registry_verified).toBe(false);
  });
  it('retains REVIEW for a candidate-specific legal-name conflict', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([claim(alpha), claim('The seller is Other Limited, company number 00123456.')]) });
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.selected_candidate?.verification.blocking_conflict).toBe(true);
  });
  it('no credible identity gives overall UNRESOLVED', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([claim('Welcome.')]) });
    expect(result.overall.recommended_action).toBe('UNRESOLVED');
  });
});

describe('target market and brand context', () => {
  it.each([
    ['The seller is Beta Limited, incorporated in Delaware, company number 00654321.', url],
    ['The seller is Beta Limited, registered in Ireland, company number 00654321.', url],
    ['The seller is Beta Limited, company number 00654321.', 'https://www.example.com/us/terms'],
    ['Privacy policy for Other Beauty Singapore. Company number 00654321.', url],
  ])('excludes foreign scope from text and/or URL', async (text, source) => {
    expect(marketContextMismatch(text, source)).toBe(true);
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([claim(alpha), claim(text, source)]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.discovery_rejections[0]?.reason).toMatch(/market_context_mismatch|context_mismatch/);
    expect(result.discovery?.candidates).toHaveLength(2);
  });
  it('keeps another-brand privacy scope as diagnostics rather than shopping evidence', async () => {
    const text = "Privacy policy for La Roche-Posay Singapore. This site is operated by Beta Limited, company number 00654321.";
    const result = await resolveWithDiscovery({ ...input, brand_name: 'Vichy' }, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([claim(alpha), claim(text)]) });
    expect(result.discovery_rejections).toContainEqual({ index: 1, reason: 'context_mismatch' });
    expect(result.overall.recommended_action).toBe('PROPOSE');
  });
});

describe('known answers and channel parity', () => {
  it('Charlotte embedded seller wins and Islestarr licensor remains secondary', async () => {
    const result = await resolveWithDiscovery({ ...input, brand_name: 'Charlotte Tilbury' }, { fetchPage: page(await read('charlotte-embedded.html')), discover: vi.fn(),
      companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: company_number === '08037372' ? 'CHARLOTTE TILBURY BEAUTY LIMITED' : 'ISLESTARR HOLDINGS LIMITED', company_status: 'active' })) } });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '08037372' });
    expect(result.selected_candidate?.inferred_role).toBe('seller');
    expect(result.secondary_candidates[0]?.inferred_role).toBe('licensor');
  });
  it('Vichy blocked direct request recovers a fully verified discovery candidate', async () => {
    const candidate = JSON.parse(await read('vichy-discovery.json')) as DiscoveryCandidate;
    const result = await resolveWithDiscovery({ ...input, brand_name: 'Vichy', domain: 'vichy.co.uk', source_url: candidate.source_url! }, {
      fetchPage: blocked, discover: async () => discovery([candidate]),
      companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: "L'OREAL (U.K.) LIMITED", company_status: 'active' })) },
    });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00271555' });
  });
  it('Estée UK transactional discovery supersedes loyalty evidence with canonical identifier', async () => {
    const companiesHouse = { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: 'ESTEE LAUDER COSMETICS LIMITED', company_status: 'active' })) };
    const text = 'This site is operated by Estée Lauder Cosmetics Limited, registered in England and Wales under company number 659213.';
    const result = await resolveWithDiscovery({ ...input, brand_name: 'Estée Lauder' }, { fetchPage: page(await read('estee-lauder.html')), fetchDiscoveredPage: blocked, companiesHouse, discover: async () => discovery([claim(text)]) });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00659213' });
    expect(result.selected_candidate).toMatchObject({ inferred_role: 'site_operator', retrieval_channel: 'openai_web_search' });
    expect(result.selected_candidate?.evidence_groups.some(group => group.role === 'promoter' && !group.considered)).toBe(true);
    expect(result.selected_candidate?.evidence_groups.flatMap(group => group.occurrences)).toContainEqual(expect.objectContaining({ raw_identifier: '659213', canonical_identifier: '00659213' }));
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledExactlyOnceWith('00659213');
  });
  it('uses identical seller parsing for DOM, JSON page state and discovery text', () => {
    const text = 'Charlotte Tilbury Beauty Limited, registered in England and Wales (company number 08037372) (“we” or “us”) supply specific products available for subscription listed on our website to you.';
    const dom = extractCompanyCandidates(`<p>${text}</p>`, url);
    const embedded = extractEmbeddedEvidence(`<script type="application/json">${JSON.stringify({ content: text })}</script>`, url);
    const search = extractCompanyCandidates(text, url, 'text/plain');
    for (const candidates of [dom, embedded, search]) expect(candidates[0]?.occurrences[0]).toMatchObject({ role: 'seller', possible_legal_name: 'Charlotte Tilbury Beauty Limited', canonical_identifier: '08037372' });
  });
});
