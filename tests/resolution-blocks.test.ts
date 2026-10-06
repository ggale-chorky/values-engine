import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates, pageBlocks } from '../src/resolution/extract-company-candidates.js';
import { resolveBrandLegalEntity } from '../src/resolution/resolve-brand-legal-entity.js';

const url = 'https://www.example.com/terms';
const run = (html: string, companyName = 'ALPHA LIMITED') => resolveBrandLegalEntity({ brand_name: 'Demo', source_url: url }, {
  fetchPage: async () => ({ ok: true, source_url: url, final_url: url, content_type: 'text/html', content: html }),
  companiesHouse: { getCompanyProfile: async company_number => ({ company_number, company_name: company_number === '00654321' ? 'BETA LIMITED' : companyName, company_status: 'active' }) },
});

describe('block and role regression coverage', () => {
  it('Charlotte proposes the registered seller while retaining unrelated Islestarr evidence', async () => {
    const html = await readFile(new URL('./fixtures/resolution/charlotte-tilbury.html', import.meta.url), 'utf8');
    const [proposal] = await run(html, 'CHARLOTTE TILBURY BEAUTY LIMITED');
    expect(proposal).toMatchObject({ company_number: '08037372', candidate_legal_entity_name: 'CHARLOTTE TILBURY BEAUTY LIMITED',
      inferred_role: 'seller', recommended_action: 'PROPOSE', confidence: { score: 1 } });
    expect(proposal?.source_snippet).not.toContain('Islestarr');
    expect(proposal?.evidence_groups.some(group => group.role === 'seller' && group.considered
      && group.occurrences[0]?.block.heading_context.includes('About us'))).toBe(true);
    expect(proposal?.conflicting_evidence.length).toBeGreaterThan(0);
    expect(proposal?.conflicting_evidence.every(conflict => !conflict.impacts_recommendation)).toBe(true);
  });

  it.each(['promoter', 'licensor', 'data controller'])('does not let a %s with the same number contaminate the seller', async role => {
    const [proposal] = await run(`<p>The seller is Alpha Limited, company number 00123456.</p>
      <p>The ${role} is Other Limited, company number 00123456.</p>`);
    expect(proposal).toMatchObject({ recommended_action: 'PROPOSE', inferred_role: 'seller', confidence: { score: 1 } });
    expect(proposal?.conflicting_evidence).toMatchObject([{ impacts_recommendation: false }]);
    expect(proposal?.evidence_groups).toHaveLength(2);
  });

  it.each(['promoter', 'licensor', 'data controller'])('does not treat another %s as a competing operating entity', async role => {
    const proposals = await run(`<p>The seller is Alpha Limited, company number 00123456.</p>
      <p>The ${role} is Beta Limited, company number 00654321.</p>`);
    expect(proposals.map(proposal => proposal.recommended_action)).toEqual(['PROPOSE', 'REVIEW']);
    expect(proposals[0]?.signals.some(signal => signal.code === 'multiple_companies_require_review')).toBe(false);
  });

  it('retains equally authoritative conflicting seller names and requires REVIEW', async () => {
    const [proposal] = await run('<p>The seller is Alpha Limited, company number 00123456.</p><p>This site is operated by Other Limited, company number 00123456.</p>');
    expect(proposal).toMatchObject({ recommended_action: 'REVIEW' });
    expect(proposal?.conflicting_evidence).toMatchObject([{ kind: 'legal_name_mismatch', impacts_recommendation: true }]);
  });

  it('requires REVIEW when two different current operating entities are explicit', async () => {
    const proposals = await run('<p>The seller is Alpha Limited, company number 00123456.</p><p>This site is operated by Beta Limited, company number 00654321.</p>');
    expect(proposals.map(proposal => proposal.recommended_action)).toEqual(['REVIEW', 'REVIEW']);
    expect(proposals.every(proposal => proposal.conflicting_evidence.some(conflict => conflict.kind === 'multiple_operating_entities'))).toBe(true);
  });

  it.each(['<p>Alpha Limited is registered under company number 00123456.</p>',
    '<p>The programme is offered by Alpha Limited, company number 00123456.</p>',
    '<footer>The seller is Alpha Limited, company number 00123456.</footer>'])('does not propose without primary shopping-role evidence', async html => {
    expect((await run(html))[0]?.recommended_action).toBe('REVIEW');
  });

  it('retains the Estée name/number match but does not relabel loyalty-only evidence as a seller', async () => {
    const html = await readFile(new URL('./fixtures/resolution/estee-lauder.html', import.meta.url), 'utf8');
    const [proposal] = await run(html, 'ESTEE LAUDER COSMETICS LIMITED');
    expect(proposal).toMatchObject({ company_number: '00659213', candidate_legal_entity_name: 'ESTEE LAUDER COSMETICS LIMITED',
      inferred_role: 'promoter', recommended_action: 'REVIEW' });
    expect(proposal?.signals.map(signal => signal.code)).toContain('legal_name_agreement');
    expect(proposal?.signals.map(signal => signal.code)).toContain('shopping_role_unresolved');
  });

  it('does not infer a current seller from a negated or former role', async () => {
    for (const wording of ['The former seller is', 'The seller is not']) {
      expect((await run(`<h1>Terms of Sale</h1><p>${wording} Alpha Limited, company number 00123456.</p>`))[0]?.recommended_action).toBe('REVIEW');
    }
  });

  it('does not carry names across paragraphs, cells or sentences', () => {
    for (const html of ['<p>Other Limited</p><p>Company number 00123456</p>',
      '<table><tr><td>Other Limited</td><td>Company number 00123456</td></tr></table>',
      '<p>Other Limited is our licensor. Company number 00123456.</p>']) {
      expect(extractCompanyCandidates(html, url)[0]?.occurrences[0]?.possible_legal_name).toBeNull();
    }
  });

  it('scopes headings to their section and excludes navigation', () => {
    const html = '<nav>The seller is Other Limited, company number 00654321.</nav>'
      + '<section><h2>Terms of Sale</h2><h3>About us</h3><p>Alpha Limited is a company registered under company number 00123456.</p></section>'
      + '<section><h2>Other information</h2><p>Beta Limited, company number 00654321.</p></section>';
    const candidates = extractCompanyCandidates(html, url);
    expect(candidates[0]?.occurrences[0]).toMatchObject({ role: 'seller', role_basis: 'section_context' });
    expect(candidates[1]?.occurrences[0]).toMatchObject({ role: 'unknown', block: { heading_context: ['Other information'] } });
  });

  it.each([
    ['The seller is', 'seller'], ['This site is operated by', 'site_operator'], ['The brand is operated by', 'brand_operator'],
    ['The promoter is', 'promoter'], ['The licensor is', 'licensor'], ['The data controller is', 'data_controller'],
  ] as const)('extracts name and %s role in a list item', (prefix, role) => {
    const [candidate] = extractCompanyCandidates(`<ul><li>${prefix} <strong>Alpha Limited</strong>, company registration number 00123456.</li></ul>`, url);
    expect(candidate?.occurrences[0]).toMatchObject({ possible_legal_name: 'Alpha Limited', role,
      block: { dom_path: '/ul[1]/li[1]/text()[0]' } });
  });

  it('keeps source order and distinct grouped section evidence', async () => {
    const html = '<h1>Terms of Sale</h1><h2>About us</h2><p>Alpha Limited is registered with company number 00123456.</p>'
      + '<h2>Seller</h2><p>The seller is Alpha Limited, company number 00123456.</p>';
    const blocks = pageBlocks(html);
    expect(blocks.map(block => block.dom_order)).toEqual([0, 1, 2, 3, 4]);
    const [proposal] = await run(html);
    expect(proposal?.evidence_groups).toHaveLength(2);
    expect(proposal?.recommended_action).toBe('PROPOSE');
  });

  it('Vichy blocking remains source_unavailable without any API call', async () => {
    const getCompanyProfile = vi.fn();
    const result = await resolveBrandLegalEntity({ brand_name: 'Vichy', source_url: 'https://www.vichy.co.uk/terms-of-use' }, {
      fetchPage: async source_url => ({ ok: false, status: 'source_unavailable', source_url, reason: 'blocked', http_status: 403 }),
      companiesHouse: { getCompanyProfile },
    });
    expect(result[0]).toMatchObject({ recommended_action: 'UNRESOLVED', signals: [{ code: 'source_unavailable' }] });
    expect(getCompanyProfile).not.toHaveBeenCalled();
  });
});
