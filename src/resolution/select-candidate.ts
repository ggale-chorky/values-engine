import { sourcePriority } from './source-priority.js';
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
  // REVIEW presentation must not turn a registry-matched privacy affiliate into
  // an implied operator. Source context, not registry strength, breaks this tie.
  if (credible.length > 1 && !credible.some(p => p.verification.role_relevant)) {
    const score = (proposal: Proposal) => Math.max(-1, ...proposal.evidence_groups.flatMap(group => group.occurrences).map(o => {
      const source = sourcePriority(o.source_url, o.block.heading_context);
      if (source.exclusion) return -1;
      const context = `${new URL(o.source_url).pathname} ${o.block.heading_context.join(' ')}`;
      return source.exclusion || /privacy|cookie/i.test(context) || !/terms|conditions|legal[- /]notice/i.test(context) ? -1 : source.priority;
    }));
    const ordered = [...credible].sort((a, b) => score(b) - score(a));
    const best = ordered[0]!;
    const selected = score(best) >= 0 && score(best) > score(ordered[1]!) ? best : null;
    return { overall: { recommended_action: 'REVIEW', reason: selected?.reason ?? 'ambiguous_legal_entity', company_number: selected?.company_number ?? null },
      selected_candidate: selected, supporting_candidates: selected ? [selected] : credible,
      secondary_candidates: proposals.filter(p => selected ? p !== selected : !credible.includes(p)) };
  }
  const rank = (proposal: Proposal) => proposal.recommended_action === 'PROPOSE' ? 0
    : proposal.verification.registry_verified && proposal.verification.legal_name_verified ? 1 : 2;
  // Stable identity ordering is for diagnostics only; no competing verified operators are selected by it.
  const selected = [...credible].sort((a, b) => rank(a) - rank(b) || (a.company_number ?? '').localeCompare(b.company_number ?? ''))[0] ?? null;
  return { overall: { recommended_action: selected ? selected.recommended_action === 'PROPOSE' ? 'PROPOSE' : 'REVIEW' : 'UNRESOLVED',
    reason: selected?.reason ?? 'no_credible_candidate', company_number: selected?.company_number ?? null },
    selected_candidate: selected, supporting_candidates: selected ? [selected] : [],
    secondary_candidates: proposals.filter(proposal => proposal !== selected) };
}
