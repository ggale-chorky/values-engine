import type { CompaniesHouseLookup } from './companies-house.js';
import { discoverFirstPartyEvidence, discoveryError, firstPartyUrl, normaliseDiscoveryDomain } from './discover-first-party-evidence.js';
import type { DiscoveryResult, EvidenceDiscovery } from './discover-first-party-evidence.js';
import { evidenceContextMismatch, extractCompanyCandidates } from './extract-company-candidates.js';
import type { ExtractedCandidate } from './extract-company-candidates.js';
import { mergeCandidates } from './extract-embedded-evidence.js';
import type { PageResult } from './fetch-first-party-page.js';
import { resolveBrandLegalEntity, unresolved, verifyCandidateEvidence } from './resolve-brand-legal-entity.js';
import type { Proposal } from './resolve-brand-legal-entity.js';

export interface ResolverResult {
  proposals: Proposal[];
  direct_proposals: Proposal[];
  discovery: DiscoveryResult | null;
  discovery_rejections: { index: number; reason: 'missing_or_wrong_domain' | 'source_not_in_search_sources' | 'no_deterministic_identifier' | 'context_mismatch' }[];
  attempts: { channel: 'direct_http' | 'embedded_page_data' | 'openai_web_search'; outcome: string }[];
}

/** Discovery proposes evidence; only the shared deterministic verifier decides recommendations. */
export async function resolveWithDiscovery(input: { brand_name: string; source_url: string; domain: string }, dependencies: {
  companiesHouse: CompaniesHouseLookup;
  fetchPage?: (url: string) => Promise<PageResult>;
  discover?: EvidenceDiscovery;
}): Promise<ResolverResult> {
  const direct = await resolveBrandLegalEntity(input, dependencies);
  const result: ResolverResult = { proposals: direct, direct_proposals: direct, discovery: null, discovery_rejections: [],
    attempts: [{ channel: 'direct_http', outcome: direct[0]?.retrieval_diagnostics?.outcome ?? direct[0]!.reason }] };
  if (direct.some(item => item.evidence_groups.some(group => group.occurrences.some(occurrence => occurrence.retrieval_channel === 'embedded_page_data')))) {
    result.attempts.push({ channel: 'embedded_page_data', outcome: 'evidence_found' });
  }
  const fallbackReasons = new Set(['source_blocked', 'source_unavailable', 'insufficient_visible_text', 'retrieved_content_incomplete', 'no_company_evidence', 'relationship_role_inadequate']);
  if (direct.some(item => item.recommended_action === 'PROPOSE') || !direct.every(item => fallbackReasons.has(item.reason))) return result;
  const domain = normaliseDiscoveryDomain(input.domain);
  if (!domain || !firstPartyUrl(input.source_url, domain)) {
    result.attempts.push({ channel: 'openai_web_search', outcome: 'invalid_domain' });
    return result;
  }
  let discovery: DiscoveryResult;
  try { discovery = await (dependencies.discover ?? discoverFirstPartyEvidence)({ brand: input.brand_name, domain }); }
  catch (error) { discovery = { status: 'api_error', candidates: [], sources: [], error: discoveryError(error) }; }
  result.discovery = discovery;
  if (discovery.status !== 'success') {
    result.attempts.push({ channel: 'openai_web_search', outcome: discovery.status });
    return result;
  }
  const found: ExtractedCandidate[] = [];
  const unverified: Proposal[] = [];
  discovery.candidates.forEach((candidate, index) => {
    const url = firstPartyUrl(candidate.source_url, domain);
    if (!url) {
      result.discovery_rejections.push({ index, reason: 'missing_or_wrong_domain' }); return;
    }
    if (!discovery.sources.some(source => firstPartyUrl(source.url, domain) === url)) {
      result.discovery_rejections.push({ index, reason: 'source_not_in_search_sources' }); return;
    }
    if (evidenceContextMismatch(candidate.evidence_text, input.brand_name)) {
      result.discovery_rejections.push({ index, reason: 'context_mismatch' }); return;
    }
    // Treat quote/claim text as untrusted plain text. Never turn model-supplied
    // name/number/role fields into a synthetic sentence or a verified relationship.
    const extracted = extractCompanyCandidates(candidate.evidence_text, candidate.source_url!, 'text/plain');
    if (!extracted.length) {
      result.discovery_rejections.push({ index, reason: 'no_deterministic_identifier' });
      const proposal = unresolved(input.brand_name, url, 'discovery_identifier_unverified');
      proposal.recommended_action = 'REVIEW';
      proposal.reason = 'company_verification_failed';
      proposal.retrieval_channel = 'openai_web_search';
      proposal.source_snippet = candidate.evidence_text;
      unverified.push(proposal);
    }
    for (const item of extracted) for (const occurrence of item.occurrences) {
      occurrence.retrieval_channel = 'openai_web_search';
      occurrence.extraction_channel = 'discovery_text';
    }
    found.push(...extracted);
  });
  result.attempts.push({ channel: 'openai_web_search', outcome: found.length ? 'evidence_found' : 'no_usable_evidence' });
  if (!found.length) { result.proposals = unverified.length ? [...direct, ...unverified] : direct; return result; }
  // Preserve relevant conflicts across pages/channels instead of selecting the best-looking result.
  const prior: ExtractedCandidate[] = direct.flatMap(proposal => proposal.company_number ? [{ company_number: proposal.company_number,
    source_url: proposal.source_url, occurrences: proposal.evidence_groups.flatMap(group => group.occurrences) }] : []);
  const verified = await verifyCandidateEvidence(mergeCandidates([...prior, ...found]), input, dependencies.companiesHouse, direct[0]?.retrieval_diagnostics ?? null);
  for (const proposal of verified) {
    proposal.signals.push({ code: 'discovery_evidence_requires_verification', weight: 0, detail: 'OpenAI source text is discovery evidence, not ownership truth' });
    if (proposal.recommended_action === 'UNRESOLVED') proposal.recommended_action = 'REVIEW';
  }
  // Unverified additional evidence means this discovery result is not complete.
  if (unverified.length) for (const proposal of verified) {
    proposal.recommended_action = 'REVIEW'; proposal.reason = 'incomplete_verification';
    proposal.signals.push({ code: 'unverified_discovery_candidate', weight: 0, detail: unverified.length });
  }
  result.proposals = [...verified, ...unverified];
  return result;
}
