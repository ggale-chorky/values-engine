import { CompaniesHouseError } from './companies-house.js';
import type { CompaniesHouseLookup, CompanyProfile } from './companies-house.js';
import { evidenceContextMismatch, extractCompanyCandidates, isShoppingRole } from './extract-company-candidates.js';
import type { CandidateOccurrence, CandidateRole, ExtractedCandidate } from './extract-company-candidates.js';
import { contentDiagnostics, fetchFirstPartyPage } from './fetch-first-party-page.js';
import { inspectEmbeddedEvidence, mergeCandidates } from './extract-embedded-evidence.js';
import type { PageResult, RetrievalDiagnostics } from './fetch-first-party-page.js';

export type ResolutionReason = 'source_blocked' | 'source_unavailable' | 'insufficient_visible_text' | 'no_company_evidence'
  | 'context_mismatch' | 'retrieved_content_incomplete' | 'relationship_role_inadequate' | 'company_verification_failed' | 'conflicting_company_evidence'
  | 'incomplete_verification' | 'company_inactive' | 'legal_name_unavailable' | 'verified_operating_entity';

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
  retrieval_channel: import('./extract-company-candidates.js').RetrievalChannel;
  reason: ResolutionReason;
  retrieval_diagnostics: RetrievalDiagnostics | null;
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

export function unresolved(brand: string, source: string, code: string, detail: Signal['detail'] = null): Proposal {
  return { retrieval_channel: 'direct_http', reason: 'source_unavailable', retrieval_diagnostics: null,
    brand_name: brand, candidate_legal_entity_name: null, company_number: null, company_status: null,
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
  if (!page.ok) {
    const result = unresolved(brand, source, 'source_unavailable', page.reason);
    result.reason = page.reason === 'blocked' ? 'source_blocked' : 'source_unavailable';
    result.retrieval_diagnostics = page.diagnostics ?? null;
    return [result];
  }
  const embedded = page.content_type === 'text/html' ? inspectEmbeddedEvidence(page.content, page.final_url) : { candidates: [], incomplete: false };
  const all = mergeCandidates([...extractCompanyCandidates(page.content, page.final_url, page.content_type), ...embedded.candidates]);
  if (!all.length) {
    const result = unresolved(brand, page.final_url, 'no_company_number');
    const outcome = (page.diagnostics ?? contentDiagnostics(page.content, page.content_type)).outcome;
    result.reason = outcome === 'retrieved_content_incomplete' ? 'retrieved_content_incomplete'
      : outcome === 'empty_or_shell' ? 'insufficient_visible_text' : 'no_company_evidence';
    result.retrieval_diagnostics = page.diagnostics ?? null;
    return [result];
  }
  const proposals = await verifyCandidateEvidence(all, input, dependencies.companiesHouse, page.diagnostics ?? null);
  if (embedded.incomplete) for (const proposal of proposals) {
    proposal.signals.push({ code: 'embedded_inspection_incomplete', weight: 0, detail: 'JSON parse or inspection limit' });
    if (proposal.retrieval_channel === 'embedded_page_data' && proposal.recommended_action === 'PROPOSE') {
      proposal.recommended_action = 'REVIEW'; proposal.reason = 'incomplete_verification';
    }
  }
  return proposals;
}

/** Shared deterministic verification for direct, embedded and discovered evidence. */
export async function verifyCandidateEvidence(all: ExtractedCandidate[], input: { brand_name: string },
  companiesHouse: CompaniesHouseLookup, diagnostics: RetrievalDiagnostics | null = null): Promise<Proposal[]> {
  const brand = input.brand_name;
  // Explicit bound on verification calls across all evidence channels.
  const candidates = all.slice(0, 10);
  const checked: { candidate: ExtractedCandidate; profile: CompanyProfile | null; failure: string | null }[] = [];
  let halted: string | null = null;
  for (const candidate of candidates) {
    if (halted) { checked.push({ candidate, profile: null, failure: halted }); continue; }
    try {
      const profile = await companiesHouse.getCompanyProfile(candidate.company_number);
      if (profile.company_number !== candidate.company_number) throw new CompaniesHouseError('invalid_response');
      checked.push({ candidate, profile, failure: null });
    } catch (error) {
      const failure = error instanceof CompaniesHouseError ? error.code : 'network_error';
      checked.push({ candidate, profile: null, failure });
      if (['unauthorized', 'rate_limited', 'missing_api_key'].includes(failure)) halted = failure;
    }
  }
  const incomplete = all.length > candidates.length || checked.some(item => item.failure && item.failure !== 'not_found');
  for (const candidate of all) for (const occurrence of candidate.occurrences) {
    if (evidenceContextMismatch([occurrence.block.text, ...occurrence.block.heading_context].join('\n'), brand)) occurrence.context_mismatch = true;
  }
  const relevant = (candidate: ExtractedCandidate) => candidate.occurrences.filter(occurrence =>
    !occurrence.context_mismatch && occurrence.block.authority === 'primary' && isShoppingRole(occurrence.role));
  const operators = all.filter(candidate => relevant(candidate).length > 0);
  return checked.map(({ candidate, profile, failure }) => {
    const base = unresolved(brand, candidate.source_url, 'labelled_company_number', candidate.company_number);
    base.retrieval_diagnostics = diagnostics;
    base.company_number = candidate.company_number;
    const selected = relevant(candidate);
    const considered = selected.length ? selected : candidate.occurrences.filter(occurrence => !occurrence.context_mismatch && occurrence.block.authority === 'primary');
    const supporting = (considered[0] ?? candidate.occurrences[0])!;
    base.source_snippet = supporting.source_snippet;
    base.source_url = supporting.source_url;
    base.retrieval_channel = supporting.retrieval_channel;
    base.extracted_names = [...new Set(candidate.occurrences.flatMap(item => item.possible_legal_name ? [item.possible_legal_name] : []))];
    base.inferred_role = (considered[0] ?? candidate.occurrences[0])!.role;
    for (const occurrence of candidate.occurrences) {
      const key = JSON.stringify([occurrence.possible_legal_name && normaliseLegalName(occurrence.possible_legal_name),
        occurrence.role, occurrence.block.heading_context, occurrence.block.authority, occurrence.source_url, occurrence.extraction_channel, occurrence.retrieval_channel]);
      let group = base.evidence_groups.find(item => JSON.stringify([item.extracted_legal_name && normaliseLegalName(item.extracted_legal_name),
        item.role, item.section_context, item.occurrences[0]!.block.authority, item.occurrences[0]!.source_url, item.occurrences[0]!.extraction_channel, item.occurrences[0]!.retrieval_channel]) === key);
      if (!group) {
        group = { company_number: candidate.company_number, extracted_legal_name: occurrence.possible_legal_name,
          role: occurrence.role, section_context: occurrence.block.heading_context, considered: considered.includes(occurrence), occurrences: [] };
        base.evidence_groups.push(group);
      }
      group.occurrences.push(occurrence);
    }
    if (!profile) {
      base.reason = 'company_verification_failed';
      base.signals.push({ code: `companies_house_${failure}`, weight: 0, detail: null });
      return base;
    }
    base.candidate_legal_entity_name = profile.company_name;
    base.company_status = profile.company_status;
    base.companies_house_match = profile;
    const signals = base.signals;
    const contextMismatch = candidate.occurrences.every(occurrence => occurrence.context_mismatch);
    if (candidate.occurrences.some(occurrence => occurrence.context_mismatch)) signals.push({ code: 'context_mismatch', weight: 0, detail: 'Explicit evidence brand scope differs from requested brand' });
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
    base.reason = base.recommended_action === 'PROPOSE' ? 'verified_operating_entity'
      : contextMismatch ? 'context_mismatch' : nameConflict || ambiguous ? 'conflicting_company_evidence'
      : !roleResolved ? 'relationship_role_inadequate'
      : incomplete ? 'incomplete_verification' : !active ? 'company_inactive' : 'legal_name_unavailable';
    return base;
  });
}
