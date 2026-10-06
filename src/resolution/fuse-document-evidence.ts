import { sourcePriority } from './source-priority.js';
import { firstPartyUrl } from './discover-first-party-evidence.js';
import { evidenceContextMismatch, isShoppingRole } from './extract-company-candidates.js';
import type { CandidateOccurrence, ExtractedCandidate } from './extract-company-candidates.js';
import { normaliseLegalName } from './legal-name.js';
import { occurrenceMarketMismatch } from './evidence-market.js';
import type { TargetMarket } from './evidence-market.js';

/** Matching uses the complete canonical URL (including path/query), never just its domain. */
export function fuseDocumentEvidence(candidates: ExtractedCandidate[], namedEvidence: CandidateOccurrence[],
  context: { brand_name: string; source_url: string; domain?: string; target_market?: TargetMarket }): ExtractedCandidate[] {
  let domain: string;
  try { domain = context.domain ?? new URL(context.source_url).hostname; } catch { return candidates; }
  const document = (occurrence: CandidateOccurrence) => firstPartyUrl(occurrence.source_url, domain);
  const inScope = (occurrence: CandidateOccurrence) => document(occurrence) !== null && occurrence.block.authority === 'primary'
    && !sourcePriority(occurrence.source_url, occurrence.block.heading_context).exclusion
    && !evidenceContextMismatch([occurrence.block.text, ...occurrence.block.heading_context].join('\n'), context.brand_name)
    && !occurrenceMarketMismatch(occurrence, context.target_market ?? 'GB');
  const output = candidates.map(candidate => ({ ...candidate, occurrences: candidate.occurrences.map(occurrence => ({ ...occurrence })) }));
  const identifiers = output.flatMap(candidate => candidate.occurrences).filter(occurrence => occurrence.canonical_identifier && occurrence.possible_legal_name && inScope(occurrence));
  for (const role of namedEvidence) {
    if (!role.possible_legal_name || !isShoppingRole(role.role) || role.role_basis !== 'explicit' || !inScope(role)) continue;
    const doc = document(role)!;
    const name = normaliseLegalName(role.possible_legal_name);
    const sameDocument = identifiers.filter(occurrence => document(occurrence) === doc);
    const matching = sameDocument.filter(occurrence => normaliseLegalName(occurrence.possible_legal_name!) === name);
    if (!matching.length) continue;
    const numbers = new Set(matching.map(occurrence => occurrence.canonical_identifier));
    const contradictoryNames = sameDocument.some(occurrence => numbers.has(occurrence.canonical_identifier)
      && normaliseLegalName(occurrence.possible_legal_name!) !== name
      && !['promoter', 'licensor', 'data_controller'].includes(occurrence.role));
    if (numbers.size !== 1 || contradictoryNames) {
      for (const occurrence of matching) occurrence.fusion_conflict = true;
      continue;
    }
    const number = matching[0]!.canonical_identifier!;
    const candidate = output.find(item => item.company_number === number)!;
    // An already complete occurrence needs no fusion and keeps its original provenance.
    if (candidate.occurrences.some(occurrence => document(occurrence) === doc && occurrence.role === role.role
      && normaliseLegalName(occurrence.possible_legal_name ?? '') === name && occurrence.block.text === role.block.text)) continue;
    const fused: CandidateOccurrence = { ...role, same_document_evidence_fusion: {
      canonical_source_url: doc, matched_legal_name: name, canonical_identifier: number,
    } };
    if (!candidate.occurrences.some(occurrence => occurrence.same_document_evidence_fusion
      && document(occurrence) === doc && occurrence.source_snippet === role.source_snippet && occurrence.role === role.role)) candidate.occurrences.push(fused);
  }
  return output;
}
