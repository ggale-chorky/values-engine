import { CompaniesHouseError } from './companies-house.js';
import type { CompaniesHouseLookup, CompanyProfile } from './companies-house.js';
import { extractCompanyCandidates } from './extract-company-candidates.js';
import type { ExtractedCandidate } from './extract-company-candidates.js';
import { fetchFirstPartyPage } from './fetch-first-party-page.js';
import type { PageResult } from './fetch-first-party-page.js';

export interface Signal { code: string; weight: number; detail: string | number | boolean | null }
export interface Proposal {
  brand_name: string;
  candidate_legal_entity_name: string | null;
  company_number: string | null;
  company_status: string | null;
  source_url: string;
  source_snippet: string | null;
  extracted_names: string[];
  signals: Signal[];
  confidence: { score: number; level: 'HIGH' | 'MEDIUM' | 'LOW'; calibrated: false };
  recommended_action: 'PROPOSE' | 'REVIEW' | 'UNRESOLVED';
}

/** Formatting equivalence only; no fuzzy/brand-name-based identity inference. */
export function normaliseLegalName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .replace(/\bLTD\b/g, 'LIMITED').replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
}

function unresolved(brand: string, source: string, code: string, detail: Signal['detail'] = null): Proposal {
  return { brand_name: brand, candidate_legal_entity_name: null, company_number: null, company_status: null,
    source_url: source, source_snippet: null, extracted_names: [], signals: [{ code, weight: 0, detail }],
    confidence: { score: 0, level: 'LOW', calibrated: false }, recommended_action: 'UNRESOLVED' };
}

export async function resolveBrandLegalEntity(input: { brand_name: string; source_url: string }, dependencies: {
  companiesHouse: CompaniesHouseLookup;
  fetchPage?: (url: string) => Promise<PageResult>;
}): Promise<Proposal[]> {
  const { brand_name: brand, source_url: source } = input;
  const page = await (dependencies.fetchPage ?? fetchFirstPartyPage)(source);
  if (!page.ok) return [unresolved(brand, source, 'source_unavailable', page.reason)];
  const all = extractCompanyCandidates(page.content, page.final_url, page.content_type);
  if (!all.length) return [unresolved(brand, page.final_url, 'no_company_number')];
  // Explicit bound on API calls per page. Never search for a brand as a fallback.
  const candidates = all.slice(0, 10);
  const checked: { candidate: ExtractedCandidate; profile: CompanyProfile | null; failure: string | null }[] = [];
  let halted: string | null = null;
  for (const candidate of candidates) {
    if (halted) { checked.push({ candidate, profile: null, failure: halted }); continue; }
    try {
      const profile = await dependencies.companiesHouse.getCompanyProfile(candidate.company_number);
      if (profile.company_number !== candidate.company_number) throw new CompaniesHouseError('invalid_response');
      checked.push({ candidate, profile, failure: null });
    } catch (error) {
      const failure = error instanceof CompaniesHouseError ? error.code : 'network_error';
      checked.push({ candidate, profile: null, failure });
      if (['unauthorized', 'rate_limited', 'missing_api_key'].includes(failure)) halted = failure;
    }
  }
  const valid = checked.filter(item => item.profile !== null);
  const incomplete = all.length > candidates.length || checked.some(item => item.failure && item.failure !== 'not_found');
  const operators = valid.filter(({ candidate }) => candidate.occurrences.some(occurrence => occurrence.explicit_operator_or_seller));
  return checked.map(({ candidate, profile, failure }) => {
    const base = unresolved(brand, candidate.source_url, 'labelled_company_number', candidate.company_number);
    base.company_number = candidate.company_number;
    base.source_snippet = candidate.occurrences[0]!.source_snippet;
    base.extracted_names = [...new Set(candidate.occurrences.flatMap(item => item.possible_legal_name ? [item.possible_legal_name] : []))];
    if (!profile) {
      base.signals.push({ code: `companies_house_${failure}`, weight: 0, detail: null });
      return base;
    }
    base.candidate_legal_entity_name = profile.company_name;
    base.company_status = profile.company_status;
    const signals = base.signals;
    signals.push({ code: 'companies_house_number_match', weight: 0.8, detail: profile.company_number });
    const nameAgreement = base.extracted_names.length > 0
      && base.extracted_names.every(name => normaliseLegalName(name) === normaliseLegalName(profile.company_name));
    const nameConflict = base.extracted_names.some(name => normaliseLegalName(name) !== normaliseLegalName(profile.company_name));
    signals.push({ code: nameConflict ? 'legal_name_conflict' : nameAgreement ? 'legal_name_agreement' : 'legal_name_unavailable',
      weight: nameConflict ? -0.4 : nameAgreement ? 0.15 : 0, detail: base.extracted_names.join(' | ') || null });
    const active = profile.company_status === 'active';
    signals.push({ code: active ? 'company_active' : 'company_not_active', weight: active ? 0.05 : -0.15, detail: profile.company_status });
    const selectedOperator = operators.length === 1 && operators[0]!.candidate.company_number === candidate.company_number;
    const ambiguous = valid.length > 1 && !selectedOperator;
    if (valid.length > 1) signals.push({ code: selectedOperator ? 'unique_explicit_operator_or_seller' : 'multiple_companies_require_review',
      weight: ambiguous ? -0.25 : 0, detail: valid.length });
    if (incomplete) signals.push({ code: 'incomplete_verification', weight: -0.25, detail: all.length });
    const score = Math.round(Math.max(0, Math.min(1, signals.reduce((sum, signal) => sum + signal.weight, 0))) * 100) / 100;
    base.confidence = { score, level: score >= 0.9 ? 'HIGH' : score >= 0.6 ? 'MEDIUM' : 'LOW', calibrated: false };
    base.recommended_action = nameAgreement && active && !ambiguous && !incomplete ? 'PROPOSE' : 'REVIEW';
    return base;
  });
}
