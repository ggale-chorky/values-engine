import { CompaniesHouseError } from './companies-house.js';
import type { CompaniesHouseLookup, CompanyProfile } from './companies-house.js';
import { extractCompanyCandidates, isShoppingRole } from './extract-company-candidates.js';
import type { CandidateOccurrence, CandidateRole, ExtractedCandidate } from './extract-company-candidates.js';
import { fetchFirstPartyPage } from './fetch-first-party-page.js';
import type { PageResult } from './fetch-first-party-page.js';

export interface Signal { code: string; weight: number; detail: string | number | boolean | null }
export interface EvidenceGroup {
  company_number: string;
  extracted_legal_name: string | null;
  role: CandidateRole;
  section_context: string[];
  considered: boolean;
  occurrences: CandidateOccurrence[];
}
export interface Proposal {
  brand_name: string;
  candidate_legal_entity_name: string | null;
  company_number: string | null;
  company_status: string | null;
  source_url: string;
  source_snippet: string | null;
  extracted_names: string[];
  inferred_role: CandidateRole;
  companies_house_match: CompanyProfile | null;
  evidence_groups: EvidenceGroup[];
  conflicting_evidence: { kind: 'legal_name_mismatch' | 'multiple_operating_entities'; company_number: string;
    occurrence: CandidateOccurrence; impacts_recommendation: boolean }[];
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
    source_url: source, source_snippet: null, extracted_names: [], inferred_role: 'unknown', companies_house_match: null,
    evidence_groups: [], conflicting_evidence: [], signals: [{ code, weight: 0, detail }],
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
  const incomplete = all.length > candidates.length || checked.some(item => item.failure && item.failure !== 'not_found');
  const relevant = (candidate: ExtractedCandidate) => candidate.occurrences.filter(occurrence =>
    occurrence.block.authority === 'primary' && isShoppingRole(occurrence.role));
  const operators = all.filter(candidate => relevant(candidate).length > 0);
  return checked.map(({ candidate, profile, failure }) => {
    const base = unresolved(brand, candidate.source_url, 'labelled_company_number', candidate.company_number);
    base.company_number = candidate.company_number;
    const selected = relevant(candidate);
    const considered = selected.length ? selected : candidate.occurrences.filter(occurrence => occurrence.block.authority === 'primary');
    base.source_snippet = (considered[0] ?? candidate.occurrences[0])!.source_snippet;
    base.extracted_names = [...new Set(candidate.occurrences.flatMap(item => item.possible_legal_name ? [item.possible_legal_name] : []))];
    base.inferred_role = (considered[0] ?? candidate.occurrences[0])!.role;
    for (const occurrence of candidate.occurrences) {
      const key = JSON.stringify([occurrence.possible_legal_name && normaliseLegalName(occurrence.possible_legal_name),
        occurrence.role, occurrence.block.heading_context, occurrence.block.authority]);
      let group = base.evidence_groups.find(item => JSON.stringify([item.extracted_legal_name && normaliseLegalName(item.extracted_legal_name),
        item.role, item.section_context, item.occurrences[0]!.block.authority]) === key);
      if (!group) {
        group = { company_number: candidate.company_number, extracted_legal_name: occurrence.possible_legal_name,
          role: occurrence.role, section_context: occurrence.block.heading_context, considered: considered.includes(occurrence), occurrences: [] };
        base.evidence_groups.push(group);
      }
      group.occurrences.push(occurrence);
    }
    if (!profile) {
      base.signals.push({ code: `companies_house_${failure}`, weight: 0, detail: null });
      return base;
    }
    base.candidate_legal_entity_name = profile.company_name;
    base.company_status = profile.company_status;
    base.companies_house_match = profile;
    const signals = base.signals;
    signals.push({ code: 'companies_house_number_match', weight: 0.8, detail: profile.company_number });
    const names = considered.flatMap(item => item.possible_legal_name ? [item.possible_legal_name] : []);
    const nameAgreement = names.length > 0 && names.every(name => normaliseLegalName(name) === normaliseLegalName(profile.company_name));
    const nameConflict = names.some(name => normaliseLegalName(name) !== normaliseLegalName(profile.company_name));
    for (const occurrence of candidate.occurrences) {
      if (occurrence.possible_legal_name && normaliseLegalName(occurrence.possible_legal_name) !== normaliseLegalName(profile.company_name)) {
        base.conflicting_evidence.push({ kind: 'legal_name_mismatch', company_number: candidate.company_number,
          occurrence, impacts_recommendation: considered.includes(occurrence) });
      }
    }
    signals.push({ code: nameConflict ? 'legal_name_conflict' : nameAgreement ? 'legal_name_agreement' : 'legal_name_unavailable',
      weight: nameConflict ? -0.4 : nameAgreement ? 0.15 : 0, detail: names.join(' | ') || null });
    const active = profile.company_status === 'active';
    signals.push({ code: active ? 'company_active' : 'company_not_active', weight: active ? 0.05 : -0.15, detail: profile.company_status });
    const roleResolved = selected.length > 0;
    signals.push({ code: roleResolved ? 'shopping_role_identified' : 'shopping_role_unresolved',
      weight: roleResolved ? 0 : -0.25, detail: base.inferred_role });
    const ambiguous = roleResolved && operators.length > 1;
    if (ambiguous) {
      signals.push({ code: 'multiple_companies_require_review', weight: -0.25, detail: operators.length });
      for (const other of operators) for (const occurrence of relevant(other)) {
        base.conflicting_evidence.push({ kind: 'multiple_operating_entities', company_number: other.company_number,
          occurrence, impacts_recommendation: true });
      }
    }
    if (candidate.occurrences.length > considered.length) signals.push({ code: 'unrelated_or_secondary_evidence_retained',
      weight: 0, detail: candidate.occurrences.length - considered.length });
    if (incomplete) signals.push({ code: 'incomplete_verification', weight: -0.25, detail: all.length });
    const score = Math.round(Math.max(0, Math.min(1, signals.reduce((sum, signal) => sum + signal.weight, 0))) * 100) / 100;
    base.confidence = { score, level: score >= 0.9 ? 'HIGH' : score >= 0.6 ? 'MEDIUM' : 'LOW', calibrated: false };
    base.recommended_action = nameAgreement && active && roleResolved && !ambiguous && !incomplete ? 'PROPOSE' : 'REVIEW';
    return base;
  });
}
