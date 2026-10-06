import { describe, expect, it, vi } from 'vitest';
import { extractCompanyCandidates } from '../src/resolution/extract-company-candidates.js';
import { fetchFirstPartyPage } from '../src/resolution/fetch-first-party-page.js';
import { resolveBrandLegalEntity } from '../src/resolution/resolve-brand-legal-entity.js';

const url = 'https://www.example.com/legal';
const response = (body: string) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
const resolve = async (body: string, status = 200) => {
  const getCompanyProfile = vi.fn();
  const proposals = await resolveBrandLegalEntity({ brand_name: 'Example', source_url: url }, {
    fetchPage: source => fetchFirstPartyPage(source, async () => ({ ...response(body), status })),
    companiesHouse: { getCompanyProfile },
  });
  expect(getCompanyProfile).not.toHaveBeenCalled();
  return proposals[0];
};

describe('explicit grammatical roles', () => {
  it.each([
    ['Alpha Limited (company number 00123456) is the promoter of the Program.', 'promoter'],
    ['Alpha Limited is the promoter of the Program, company number 00123456.', 'promoter'],
    ['Alpha Limited (company number 00123456) is the seller of these goods.', 'seller'],
    ['Alpha Limited (company number 00123456) operates the site.', 'site_operator'],
    ['Alpha Limited operates the site, company number 00123456.', 'site_operator'],
    ['The site is operated by Alpha Limited, company number 00123456.', 'site_operator'],
    ['The seller is Alpha Limited, company number 00123456.', 'seller'],
    ['The promoter is Alpha Limited, company number 00123456.', 'promoter'],
    ['We are Alpha Limited, company number 00123456.', 'site_operator'],
  ])('%s infers %s in the supporting sentence', (text, role) => {
    expect(extractCompanyCandidates(`<p>${text}</p>`, url)[0]?.occurrences[0]).toMatchObject({
      possible_legal_name: 'Alpha Limited', role, role_basis: 'explicit', source_snippet: text,
    });
  });

  it('does not transfer predicates from another sentence, block or named company', () => {
    for (const html of [
      '<p>Alpha Limited (company number 00123456). Beta Limited is the seller.</p>',
      '<p>Alpha Limited (company number 00123456)</p><p>is the seller.</p>',
      '<p>Alpha Limited (company number 00123456), while Beta Limited is the seller.</p>',
    ]) expect(extractCompanyCandidates(html, url)[0]?.occurrences[0]?.role).toBe('unknown');
  });
});

describe('retrieval diagnostics and resolution reasons', () => {
  it('distinguishes a normal HTML page with no evidence from a shell', async () => {
    const body = '<title>Contact us</title><main><p>' + 'Contact our customer support team for information about delivery and returns. '.repeat(3) + '</p></main>';
    expect(await resolve(body)).toMatchObject({ recommended_action: 'UNRESOLVED', reason: 'no_company_evidence',
      retrieval_diagnostics: { outcome: 'success', html_title: 'Contact us', contains_company_number_pattern: false } });
  });

  it('identifies little visible content without counting head, script, style or navigation', async () => {
    const body = '<head><title>Example</title><style>' + 'css'.repeat(100) + '</style></head>'
      + '<nav>Company number 00123456</nav><script>' + 'javascript'.repeat(100) + '</script><main>Loading</main>';
    expect(await resolve(body)).toMatchObject({ recommended_action: 'UNRESOLVED', reason: 'insufficient_visible_text',
      retrieval_diagnostics: { outcome: 'empty_or_shell', visible_text_character_count: 7, html_title: 'Example', contains_company_number_pattern: false } });
  });

  it('reports blocked HTTP responses separately', async () => {
    expect(await resolve('', 403)).toMatchObject({ recommended_action: 'UNRESOLVED', reason: 'source_blocked',
      retrieval_diagnostics: { outcome: 'blocked', http_status: 403, response_byte_count: 0 } });
  });

  it('retains HTTP status for a challenge served with 200', async () => {
    expect(await resolve('<title>Just a moment...</title>')).toMatchObject({ reason: 'source_blocked',
      retrieval_diagnostics: { outcome: 'blocked', http_status: 200, html_title: 'Just a moment...' } });
  });

  it('reports final redirect metadata, byte counts and text counts without leaking query or headers', async () => {
    const body = '<title>Terms &amp; conditions</title><p>Company number 00123456</p>';
    const request = vi.fn().mockResolvedValueOnce({ status: 302, headers: { location: '/terms?token=private' }, body: '' })
      .mockResolvedValueOnce({ ...response(body), headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'private-cookie' } });
    const result = await fetchFirstPartyPage(url + '?token=private#private', request);
    expect(result.diagnostics).toEqual({ requested_url: url, final_url: 'https://www.example.com/terms', http_status: 200,
      content_type: 'text/html', response_byte_count: Buffer.byteLength(body), visible_text_character_count: 23,
      html_title: 'Terms & conditions', contains_company_number_pattern: true, outcome: 'success' });
    expect(JSON.stringify(result.diagnostics)).not.toContain('private');
    expect(JSON.stringify(result.diagnostics)).not.toContain('<p>');
  });

  it('reports unsupported content and network errors without raw error details', async () => {
    const unsupported = await fetchFirstPartyPage(url, async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '' }));
    expect(unsupported.diagnostics).toMatchObject({ outcome: 'unsupported_content', http_status: 200, content_type: 'application/pdf' });
    const failure = await fetchFirstPartyPage(url, async () => { throw new Error('secret detail'); });
    expect(failure.diagnostics).toMatchObject({ outcome: 'network_error', http_status: null });
    expect(JSON.stringify(failure)).not.toContain('secret detail');
  });
});
