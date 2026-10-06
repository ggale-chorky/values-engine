import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompaniesHouseClient } from '../src/resolution/companies-house.js';

const profile = { company_number: '08037372', company_name: 'CHARLOTTE TILBURY BEAUTY LIMITED', company_status: 'active' };
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Companies House read-only client', () => {
  it('uses the official endpoint and Basic key/blank-password authentication', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(profile));
    expect(await new CompaniesHouseClient(request).getCompanyProfile(' 08037372 ')).toEqual(profile);
    expect(request).toHaveBeenCalledWith('https://api.company-information.service.gov.uk/company/08037372', expect.objectContaining({
      method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('fixture-key-only:').toString('base64')}` }),
    }));
  });

  it('normalises prefixed numbers and validates profile identity', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ ...profile, company_number: 'SC000123' }));
    await new CompaniesHouseClient(request).getCompanyProfile(' sc000123 ');
    expect(request.mock.calls[0]?.[0]).toBe('https://api.company-information.service.gov.uk/company/SC000123');
    const mismatch = new CompaniesHouseClient(vi.fn<typeof fetch>().mockResolvedValue(json(profile)));
    await expect(mismatch.getCompanyProfile('SC000123')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([[401, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited'], [500, 'http_error']] as const)
    ('handles HTTP %s without retrying or exposing bodies', async (status, code) => {
      vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
      const request = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'sensitive response' }, status, { 'retry-after': '60' }));
      await expect(new CompaniesHouseClient(request).getCompanyProfile('08037372')).rejects.toMatchObject({ code, status });
      expect(request).toHaveBeenCalledTimes(1);
    });

  it('exposes bounded retry guidance for 429 but does not wait/retry', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    const client = new CompaniesHouseClient(vi.fn<typeof fetch>().mockResolvedValue(json({}, 429, { 'retry-after': '120' })));
    await expect(client.getCompanyProfile('08037372')).rejects.toMatchObject({ code: 'rate_limited', retry_after_seconds: 120 });
  });

  it('reports missing configuration and invalid arguments before making requests', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', '');
    const request = vi.fn<typeof fetch>();
    const client = new CompaniesHouseClient(request);
    await expect(client.getCompanyProfile('08037372')).rejects.toMatchObject({ code: 'missing_api_key' });
    await expect(client.getCompanyProfile('../secret')).rejects.toMatchObject({ code: 'invalid_company_number' });
    await expect(client.searchCompanies('')).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(client.searchCompanies('Acme', 101)).rejects.toMatchObject({ code: 'invalid_query' });
    expect(request).not.toHaveBeenCalled();
  });

  it('redacts network errors', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    const client = new CompaniesHouseClient(vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-key-only')));
    await expect(client.getCompanyProfile('08037372')).rejects.toMatchObject({ code: 'network_error', message: 'Companies House: network_error.' });
  });

  it('reports timeouts explicitly without retrying', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('aborted'));
    await expect(new CompaniesHouseClient(request).getCompanyProfile('08037372')).rejects.toMatchObject({ code: 'timeout' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { ...profile, company_name: '' }, { ...profile, company_status: 1 }])('validates profile responses with Zod', async body => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    await expect(new CompaniesHouseClient(vi.fn<typeof fetch>().mockResolvedValue(json(body))).getCompanyProfile('08037372'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('encodes search queries and validates search response', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture-key-only');
    const body = { items: [{ title: profile.company_name, company_number: profile.company_number }], total_results: 1 };
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    expect(await new CompaniesHouseClient(request).searchCompanies('A & B', 5)).toEqual(body);
    expect(request.mock.calls[0]?.[0]).toBe('https://api.company-information.service.gov.uk/search/companies?q=A+%26+B&items_per_page=5');
    await expect(new CompaniesHouseClient(vi.fn<typeof fetch>().mockResolvedValue(json({ items: 'bad' }))).searchCompanies('Acme'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
