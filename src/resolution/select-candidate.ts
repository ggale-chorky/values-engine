import type { Proposal } from './resolve-brand-legal-entity.js';

export interface OverallSelection {
  overall: { recommended_action: 'PROPOSE' | 'REVIEW' | 'UNRESOLVED'; reason: string; company_number: string | null };
  selected_candidate: Proposal | null;
  supporting_candidates: Proposal[];
  secondary_candidates: Proposal[];
}

/** No numeric confidence or channel preference determines the selected legal entity. */
export function selectCandidate(proposals: Proposal[]): OverallSelection {
  const credible = proposals.filter(proposal => proposal.verification.source_validated
    && proposal.verification.market_context_match && proposal.verification.brand_context_match
    && proposal.verification.identifier_extracted_deterministically);
  const relevant = credible.filter(proposal => proposal.verification.registry_verified && proposal.verification.registry_active
    && proposal.verification.legal_name_verified && proposal.verification.role_relevant);
  if (new Set(relevant.map(proposal => proposal.company_number)).size > 1) return {
    overall: { recommended_action: 'REVIEW', reason: 'ambiguous_legal_entity', company_number: null }, selected_candidate: null,
    supporting_candidates: relevant, secondary_candidates: proposals.filter(proposal => !relevant.includes(proposal)),
  };
  const rank = (proposal: Proposal) => proposal.recommended_action === 'PROPOSE' ? 0
    : proposal.verification.registry_verified && proposal.verification.legal_name_verified ? 1 : 2;
  // Stable identity ordering is for diagnostics only; no competing verified operators are selected by it.
  const selected = [...credible].sort((a, b) => rank(a) - rank(b) || (a.company_number ?? '').localeCompare(b.company_number ?? ''))[0] ?? null;
  return { overall: { recommended_action: selected ? selected.recommended_action === 'PROPOSE' ? 'PROPOSE' : 'REVIEW' : 'UNRESOLVED',
    reason: selected?.reason ?? 'no_credible_candidate', company_number: selected?.company_number ?? null },
    selected_candidate: selected, supporting_candidates: selected ? [selected] : [],
    secondary_candidates: proposals.filter(proposal => proposal !== selected) };
}
