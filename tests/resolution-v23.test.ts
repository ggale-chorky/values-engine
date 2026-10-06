import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates, extractNamedEvidence } from '../src/resolution/extract-company-candidates.js';
import { inspectEmbeddedEvidence } from '../src/resolution/extract-embedded-evidence.js';
import { fuseDocumentEvidence } from '../src/resolution/fuse-document-evidence.js';
import { resolveWithDiscovery } from '../src/resolution/resolve-with-discovery.js';
import type { DiscoveryCandidate, DiscoveryResult } from '../src/resolution/discover-first-party-evidence.js';
import type { PageResult } from '../src/resolution/fetch-first-party-page.js';
import { CompaniesHouseError } from '../src/resolution/companies-house.js';

const read = (file: string) => readFile(new URL(`./fixtures/resolution/${file}`, import.meta.url), 'utf8');
const terms = 'https://www.esteelauder.co.uk/customer_service/terms.tmpl';
const loyalty = 'https://www.esteelauder.co.uk/terms-conditions-loyalty';
const input = { brand_name: 'Estée Lauder', source_url: loyalty, domain: 'esteelauder.co.uk', target_market: 'GB' as const };
const seller = 'By placing an order with Estee Lauder Cosmetics Limited for products which are sold on the Site, you accept these terms.';
const identity = 'Estee Lauder Cosmetics Limited is registered in England and Wales with company registration number 659213.';
const claim = (evidence_text: string, source_url = terms): DiscoveryCandidate => ({ evidence_text, source_url, source_domain: 'esteelauder.co.uk',
  possible_legal_name: 'Estee Lauder Cosmetics Limited', possible_company_number: '00659213', possible_role: 'seller' });
const discovery = (candidates: DiscoveryCandidate[]): DiscoveryResult => ({ status: 'success', candidates, sources: candidates.map(candidate => ({ type: 'url', url: candidate.source_url! })) });
const blocked = async (): Promise<PageResult> => ({ ok: false, status: 'source_unavailable', reason: 'blocked', source_url: loyalty, http_status: 403 });
const page = (html: string, url = loyalty) => async (): Promise<PageResult> => ({ ok: true, source_url: url, final_url: url, content_type: 'text/html', content: html });
const registry = () => ({ getCompanyProfile: vi.fn(async (company_number: string) => ({ company_number, company_name: 'ESTEE LAUDER COSMETICS LIMITED', company_status: 'active' })) });

describe('same-document complementary evidence', () => {
  it('fuses the live-style Estée terms snippets, preserving originals and loyalty evidence', async () => {
    const fixture = JSON.parse(await read('estee-same-document.json')) as { seller_evidence: string; registration_evidence: string; source_url: string };
    const companiesHouse = registry();
    const result = await resolveWithDiscovery(input, { fetchPage: page(await read('estee-lauder.html')), fetchDiscoveredPage: blocked, companiesHouse,
      discover: async () => discovery([claim(fixture.seller_evidence), claim(fixture.registration_evidence)]) });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00659213' });
    expect(result.selected_candidate).toMatchObject({ inferred_role: 'seller', same_document_evidence_fusion: true,
      companies_house_match: { company_name: 'ESTEE LAUDER COSMETICS LIMITED' } });
    const occurrences = result.selected_candidate!.evidence_groups.flatMap(group => group.occurrences);
    expect(occurrences).toContainEqual(expect.objectContaining({ source_snippet: fixture.registration_evidence, raw_identifier: '659213', canonical_identifier: '00659213' }));
    expect(occurrences).toContainEqual(expect.objectContaining({ source_snippet: fixture.seller_evidence, raw_identifier: null, canonical_identifier: null,
      same_document_evidence_fusion: expect.objectContaining({ canonical_identifier: '00659213' }) }));
    expect(occurrences.some(occurrence => occurrence.role === 'promoter')).toBe(true);
    expect(result.selected_candidate?.signals.some(signal => signal.code === 'same_document_evidence_fusion')).toBe(true);
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledExactlyOnceWith('00659213');
  });
  it('still requires independent registry verification after fusion', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked,
      companiesHouse: { getCompanyProfile: vi.fn().mockRejectedValue(new CompaniesHouseError('not_found')) },
      discover: async () => discovery([claim(seller), claim(identity)]) });
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.selected_candidate?.verification.registry_verified).toBe(false);
  });
  it.each([
    [claim(seller, 'https://www.esteelauder.co.uk/privacy'), claim(identity)],
    [claim(seller.replace('Estee Lauder Cosmetics Limited', 'Estee Lauder Holdings Limited')), claim(identity)],
    [claim('Market: Singapore. ' + seller), claim(identity)],
    [claim('Brand: Other Beauty. ' + seller), claim(identity)],
    [claim('Estee Lauder Cosmetics Limited welcomes you to its website.'), claim(identity)],
  ])('does not fuse incompatible documents, identities, scope or model-only roles', async (role, registration) => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([role, registration]) });
    expect(result.overall.recommended_action).not.toBe('PROPOSE');
    expect(result.proposals.some(proposal => proposal.same_document_evidence_fusion)).toBe(false);
  });
  it('does not fuse when the same name has two different identifiers in the document', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(),
      discover: async () => discovery([claim(seller), claim(identity), claim(identity.replace('659213', '123456'))]) });
    expect(result.overall.recommended_action).toBe('REVIEW');
    expect(result.proposals.some(proposal => proposal.same_document_evidence_fusion)).toBe(false);
    expect(result.proposals.filter(proposal => proposal.company_number).every(proposal => proposal.verification.blocking_conflict)).toBe(true);
  });
  it('does not fuse when a document attaches conflicting legal names to the same number', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([
      claim(seller), claim(identity), claim(identity.replace('Estee Lauder Cosmetics Limited', 'Other Holdings Limited')),
    ]) });
    expect(result.overall.recommended_action).not.toBe('PROPOSE');
    expect(result.proposals.some(proposal => proposal.same_document_evidence_fusion)).toBe(false);
  });
  it.each([
    'ESTÉE LAUDER COSMETICS LTD', 'Estée Lauder Cosmetics Limited', 'Estee   Lauder Cosmetics Limited',
  ])('uses only deterministic legal-name equivalence: %s', async name => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked, companiesHouse: registry(), discover: async () => discovery([
      claim(seller.replace('Estee Lauder Cosmetics Limited', name)), claim(identity),
    ]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
  });
  it('keeps distinct query-document URLs separate', () => {
    const named = extractNamedEvidence(seller, terms + '?document=sale', 'text/plain');
    const candidates = extractCompanyCandidates(identity, terms + '?document=privacy', 'text/plain');
    const fused = fuseDocumentEvidence(candidates, named, input);
    expect(fused[0]?.occurrences.some(occurrence => occurrence.same_document_evidence_fusion)).toBe(false);
  });
  it('fuses separate visible DOM blocks without inventing a combined sentence', async () => {
    const result = await resolveWithDiscovery({ ...input, source_url: terms }, { fetchPage: page(`<p>${seller}</p><p>${identity}</p>`, terms), companiesHouse: registry(), discover: vi.fn() });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    expect(result.selected_candidate?.same_document_evidence_fusion).toBe(true);
  });
  it('can link direct role evidence with discovered identity evidence from that exact document', async () => {
    const result = await resolveWithDiscovery({ ...input, source_url: terms }, { fetchPage: page(`<p>${seller}</p>`, terms), fetchDiscoveredPage: blocked,
      companiesHouse: registry(), discover: async () => discovery([claim(identity)]) });
    expect(result.overall.recommended_action).toBe('PROPOSE');
    const occurrences = result.selected_candidate!.evidence_groups.flatMap(group => group.occurrences);
    expect(occurrences.some(occurrence => occurrence.retrieval_channel === 'direct_http' && occurrence.role === 'seller')).toBe(true);
    expect(occurrences.some(occurrence => occurrence.retrieval_channel === 'openai_web_search' && occurrence.raw_identifier === '659213')).toBe(true);
  });
  it('normalises smart apostrophes conservatively for fusion', () => {
    const named = extractNamedEvidence("The seller is L’Oreal (UK) Limited.", terms, 'text/plain');
    const identifiers = extractCompanyCandidates("L'Oreal (U.K.) Limited, company number 00271555.", terms, 'text/plain');
    const fused = fuseDocumentEvidence(identifiers, named, input);
    expect(fused[0]?.occurrences.some(occurrence => occurrence.same_document_evidence_fusion)).toBe(true);
  });
  it('fusion cannot bypass inactive registry status', async () => {
    const result = await resolveWithDiscovery(input, { fetchPage: blocked,
      companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: 'ESTEE LAUDER COSMETICS LIMITED', company_status: 'dissolved' })) },
      discover: async () => discovery([claim(seller), claim(identity)]) });
    expect(result.selected_candidate).toMatchObject({ same_document_evidence_fusion: true, verification: { registry_active: false } });
    expect(result.overall.recommended_action).toBe('REVIEW');
  });
});

describe('real-path role parity and known answers', () => {
  const text = 'Charlotte Tilbury Beauty Limited ... (“we” or “us”) supply specific products ... to you';
  it('extracts the exact live-style role without requiring an identifier in that fragment', () => {
    const html = `<script type="application/json">${JSON.stringify({ content: text })}</script>`;
    const occurrences = [extractNamedEvidence(`<p>${text}</p>`, terms)[0], extractNamedEvidence(text, terms, 'text/plain')[0], inspectEmbeddedEvidence(html, terms).named_evidence[0]];
    for (const occurrence of occurrences) expect(occurrence).toMatchObject({ role: 'seller', role_basis: 'explicit', raw_identifier: null, source_snippet: text });
  });
  it('Charlotte embedded split fragments now produce overall PROPOSE', async () => {
    const result = await resolveWithDiscovery({ ...input, source_url: terms, brand_name: 'Charlotte Tilbury' }, { fetchPage: page(await read('charlotte-live-style-embedded.html'), terms),
      companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: 'CHARLOTTE TILBURY BEAUTY LIMITED', company_status: 'active' })) }, discover: vi.fn() });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '08037372' });
    expect(result.selected_candidate).toMatchObject({ inferred_role: 'seller', retrieval_channel: 'embedded_page_data', same_document_evidence_fusion: true });
  });
  it('Vichy keeps its already complete site-operator result', async () => {
    const candidate = JSON.parse(await read('vichy-discovery.json')) as DiscoveryCandidate;
    const result = await resolveWithDiscovery({ ...input, brand_name: 'Vichy', domain: 'vichy.co.uk', source_url: candidate.source_url! }, {
      fetchPage: blocked, companiesHouse: { getCompanyProfile: vi.fn(async company_number => ({ company_number, company_name: "L'OREAL (U.K.) LIMITED", company_status: 'active' })) },
      discover: async () => discovery([candidate]),
    });
    expect(result.overall).toMatchObject({ recommended_action: 'PROPOSE', company_number: '00271555' });
  });
});
