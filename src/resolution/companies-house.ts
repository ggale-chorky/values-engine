import { z } from 'zod';
import { normalizeCompanyNumber } from '../importers/gender-pay-gap.js';

export const COMPANIES_HOUSE_BASE_URL = 'https://api.company-information.service.gov.uk';
export const RESOLVER_USER_AGENT = 'ValuesEngine-DevelopmentResolver/1.0 (read-only legal-page research)';
// V1 accepts common eight-character UK identifiers, without guessing/padding.
export const COMPANY_NUMBER_PATTERN = /^(?:\d{8}|(?:SC|NI|OC|RC|SO|NC|FC|BR|LP|SL|NL|IP|SP|IC|OE)\d{6})$/;
const companyNumberSchema = z.string().transform(value => normalizeCompanyNumber(value) ?? '')
  .refine(value => COMPANY_NUMBER_PATTERN.test(value));
export const companyProfileSchema = z.object({ company_number: companyNumberSchema,
  company_name: z.string().trim().min(1), company_status: z.string().trim().min(1) });
export const companySearchSchema = z.object({ items: z.array(z.object({ company_number: companyNumberSchema,
  title: z.string().trim().min(1), company_status: z.string().optional() })), total_results: z.number().int().nonnegative() });
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export type CompaniesHouseErrorCode = 'missing_api_key' | 'invalid_company_number' | 'invalid_query' | 'unauthorized'
  | 'not_found' | 'rate_limited' | 'timeout' | 'network_error' | 'invalid_response' | 'http_error';

export class CompaniesHouseError extends Error {
  constructor(public readonly code: CompaniesHouseErrorCode, public readonly status: number | null = null,
    public readonly retry_after_seconds: number | null = null) {
    super(`Companies House: ${code}.`);
  }
}

export interface CompaniesHouseLookup { getCompanyProfile(companyNumber: string): Promise<CompanyProfile> }

/** No IO at construction/import; key comes only from the runtime environment. */
export class CompaniesHouseClient implements CompaniesHouseLookup {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const key = process.env.COMPANIES_HOUSE_API_KEY?.trim();
    if (!key) throw new CompaniesHouseError('missing_api_key');
    const signal = AbortSignal.timeout(10_000);
    try {
      const response = await this.fetchImpl(`${COMPANIES_HOUSE_BASE_URL}${path}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
          Accept: 'application/json', 'User-Agent': RESOLVER_USER_AGENT },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new CompaniesHouseError('unauthorized', 401);
        if (response.status === 404) throw new CompaniesHouseError('not_found', 404);
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
          throw new CompaniesHouseError('rate_limited', 429, seconds !== null && Number.isSafeInteger(seconds) ? seconds : null);
        }
        throw new CompaniesHouseError('http_error', response.status);
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
        await response.body?.cancel();
        throw new CompaniesHouseError('invalid_response');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { await reader.cancel(); throw new CompaniesHouseError('invalid_response'); }
        chunks.push(value);
      }
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new CompaniesHouseError('invalid_response'); }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new CompaniesHouseError('invalid_response');
      return parsed.data;
    } catch (error) {
      if (error instanceof CompaniesHouseError) throw error;
      throw new CompaniesHouseError(signal.aborted ? 'timeout' : 'network_error');
    }
  }

  async getCompanyProfile(companyNumber: string): Promise<CompanyProfile> {
    const number = normalizeCompanyNumber(companyNumber) ?? '';
    if (!COMPANY_NUMBER_PATTERN.test(number)) throw new CompaniesHouseError('invalid_company_number');
    const profile = await this.get(`/company/${encodeURIComponent(number)}`, companyProfileSchema);
    if (profile.company_number !== number) throw new CompaniesHouseError('invalid_response');
    return profile;
  }

  async searchCompanies(query: string, limit = 10) {
    if (!query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CompaniesHouseError('invalid_query');
    }
    const params = new URLSearchParams({ q: query.trim(), items_per_page: String(limit) });
    return this.get(`/search/companies?${params}`, companySearchSchema);
  }
}
