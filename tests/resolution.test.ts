import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { CompaniesHouseError } from '../src/resolution/companies-house.js';
import { normaliseLegalName, resolveBrandLegalEntity } from '../src/resolution/resolve-brand-legal-entity.js';

const source = 'https://www.example.com/legal';
const input = { brand_name: 'Example', source_url: source };
const page = (content: string) => vi.fn().mockResolvedValue({ ok: true, source_url: source, final_url: source, content_type: 'text/html', content });
const official = (name = 'ALPHA LIMITED', number = '00123456', status = 'active') => ({ company_name: name, company_number: number, company_status: status });
const lookup = () => ({ getCompanyProfile: vi.fn().mockResolvedValue(official()) });

describe('deterministic resolver proposals', () => {
  it.each([
    ['charlotte-tilbury', 'Charlotte Tilbury', '08037372', 'CHARLOTTE TILBURY BEAUTY LIMITED'],
    ['synthetic-seller', 'Synthetic example', '00123456', 'ALPHA LIMITED'],
    ['vichy', 'Vichy', '00271555', "L'OREAL (U.K.) LIMITED"],
  ])('proposes known-answer %s using fixture page and mocked official profile', async (file, brand, number, name) => {
    const html = await readFile(new URL(`./fixtures/resolution/${file}.html`, import.meta.url), 'utf8');
    const getCompanyProfile = vi.fn().mockResolvedValue(official(name, number));
    const results = await resolveBrandLegalEntity({ ...input, brand_name: brand! }, { companiesHouse: { getCompanyProfile }, fetchPage: page(html) });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ brand_name: brand, company_number: number, candidate_legal_entity_name: name,
      company_status: 'active', confidence: { level: 'HIGH', score: 1, calibrated: false }, recommended_action: 'PROPOSE' });
    expect(getCompanyProfile).toHaveBeenCalledExactlyOnceWith(number);
    expect(results[0]!.signals.map(signal => signal.code)).toContain('legal_name_agreement');
  });

  it('normalises accents, punctuation and Ltd without fuzzy identity guessing', () => {
    expect(normaliseLegalName('Estée Lauder Cosmetics Ltd.')).toBe(normaliseLegalName('ESTEE LAUDER COSMETICS LIMITED'));
    expect(normaliseLegalName("L'Oreal (UK) Limited")).toBe(normaliseLegalName("L'OREAL (U.K.) LIMITED"));
    expect(normaliseLegalName('Alpha Holdings Limited')).not.toBe(normaliseLegalName('Alpha Limited'));
  });

  it('returns deterministic signals and scores', async () => {
    const dependencies = { companiesHouse: lookup(), fetchPage: page('<p>The seller is Alpha Limited, company number 00123456.</p>') };
    const first = await resolveBrandLegalEntity(input, dependencies);
    expect(await resolveBrandLegalEntity(input, dependencies)).toEqual(first);
    expect(first[0]?.signals.map(signal => [signal.code, signal.weight])).toEqual([
      ['labelled_company_number', 0], ['companies_house_number_match', 0.8], ['legal_name_agreement', 0.15], ['company_active', 0.05],
      ['shopping_role_identified', 0],
    ]);
  });

  it('requires review for conflicting nearby legal names', async () => {
    const [result] = await resolveBrandLegalEntity(input, { companiesHouse: lookup(), fetchPage: page('<p>The seller is Different Limited, company no. 00123456</p>') });
    expect(result).toMatchObject({ recommended_action: 'REVIEW', confidence: { score: 0.45, level: 'LOW' } });
    expect(result?.signals.map(signal => signal.code)).toContain('legal_name_conflict');
  });

  it('does not upgrade an inactive company or a missing name to PROPOSE', async () => {
    const inactive = await resolveBrandLegalEntity(input, { companiesHouse: { getCompanyProfile: vi.fn().mockResolvedValue(official('ALPHA LIMITED', '00123456', 'dissolved')) },
      fetchPage: page('Alpha Limited, company no. 00123456') });
    expect(inactive[0]?.recommended_action).toBe('REVIEW');
    const unnamed = await resolveBrandLegalEntity(input, { companiesHouse: lookup(), fetchPage: page('Company number 00123456') });
    expect(unnamed[0]).toMatchObject({ recommended_action: 'REVIEW', confidence: { score: 0.6 } });
  });

  it('requires REVIEW for multiple verified companies with no unique operator', async () => {
    const companiesHouse = { getCompanyProfile: vi.fn(async (number: string) => official(number === '00123456' ? 'ALPHA LIMITED' : 'BETA LIMITED', number)) };
    const results = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: page('<p>Alpha Limited, company number 00123456</p><p>Beta Limited, company number 00654321</p>') });
    expect(results.map(result => result.recommended_action)).toEqual(['REVIEW', 'REVIEW']);
    expect(results.every(result => result.signals.some(signal => signal.code === 'shopping_role_unresolved'))).toBe(true);
  });

  it('proposes only a uniquely labelled site operator in a multi-company page', async () => {
    const companiesHouse = { getCompanyProfile: vi.fn(async (number: string) => official(number === '00123456' ? 'ALPHA LIMITED' : 'BETA LIMITED', number)) };
    const results = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: page('<p>This site is operated by Alpha Limited, company number 00123456.</p><p>Beta Limited, company number 00654321.</p>') });
    expect(results.map(result => result.recommended_action)).toEqual(['PROPOSE', 'REVIEW']);
  });

  it('does not choose between two explicit operators, even if one name conflicts', async () => {
    const companiesHouse = { getCompanyProfile: vi.fn(async (number: string) => official(number === '00123456' ? 'ALPHA LIMITED' : 'BETA LIMITED', number)) };
    const results = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: page('<p>This site is operated by Alpha Limited, company number 00123456.</p><p>The seller is Other Limited, company number 00654321.</p>') });
    expect(results.map(result => result.recommended_action)).toEqual(['REVIEW', 'REVIEW']);
  });

  it('caps candidate lookups and marks the verification incomplete', async () => {
    const content = Array.from({ length: 11 }, (_, i) => `<p>Alpha Limited, company number ${String(i + 1).padStart(8, '0')}</p>`).join('');
    const companiesHouse = { getCompanyProfile: vi.fn(async (number: string) => official('ALPHA LIMITED', number)) };
    const results = await resolveBrandLegalEntity(input, { companiesHouse, fetchPage: page(content) });
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledTimes(10);
    expect(results.every(result => result.recommended_action === 'REVIEW'
      && result.signals.some(signal => signal.code === 'incomplete_verification' && signal.detail === 11))).toBe(true);
  });

  it.each(['No registration information. Call 08037372.', 'Company no. 123456789'])('does not search/guess when no valid number exists', async content => {
    const companiesHouse = lookup();
    expect(await resolveBrandLegalEntity(input, { companiesHouse, fetchPage: page(content) }))
      .toMatchObject([{ recommended_action: 'UNRESOLVED', company_number: null, signals: [{ code: 'no_company_number' }] }]);
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'rate_limited', 'unauthorized', 'network_error'] as const)('handles Companies House %s as UNRESOLVED', async code => {
    const results = await resolveBrandLegalEntity(input, { companiesHouse: { getCompanyProfile: vi.fn().mockRejectedValue(new CompaniesHouseError(code)) },
      fetchPage: page('Alpha Limited, company number 00123456') });
    expect(results[0]?.recommended_action).toBe('UNRESOLVED');
    expect(results[0]?.signals.map(signal => signal.code)).toContain(`companies_house_${code}`);
  });

  it('stops API calls after a 429 and never turns partial verification into PROPOSE', async () => {
    const companiesHouse = { getCompanyProfile: vi.fn().mockResolvedValueOnce(official()).mockRejectedValueOnce(new CompaniesHouseError('rate_limited', 429)) };
    const results = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: page('<p>Alpha Limited, company number 00123456</p><p>Beta Limited, company number 00654321</p><p>Gamma Limited, company number 00000003</p>') });
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledTimes(2);
    expect(results.map(result => result.recommended_action)).toEqual(['REVIEW', 'UNRESOLVED', 'UNRESOLVED']);
  });

  it('reports a blocked source without calling Companies House', async () => {
    const companiesHouse = lookup();
    const proposals = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: vi.fn().mockResolvedValue({ ok: false, status: 'source_unavailable', source_url: source, reason: 'blocked', http_status: 403 }) });
    expect(proposals[0]).toMatchObject({ recommended_action: 'UNRESOLVED', signals: [{ code: 'source_unavailable', detail: 'blocked' }] });
    expect(companiesHouse.getCompanyProfile).not.toHaveBeenCalled();
  });

  it('deduplicates direct lookups and treats conflicting occurrences conservatively', async () => {
    const companiesHouse = lookup();
    const results = await resolveBrandLegalEntity(input, { companiesHouse,
      fetchPage: page('<p>Alpha Limited, company number 00123456</p><p>Other Limited, company number 00123456</p>') });
    expect(companiesHouse.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(results[0]?.recommended_action).toBe('REVIEW');
  });
});
