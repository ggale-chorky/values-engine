import { fuseDocumentEvidence } from './fuse-document-evidence.js';
import { marketContextMismatch } from './evidence-market.js';
import type { TargetMarket } from './evidence-market.js';
import { selectCandidate } from './select-candidate.js';
import type { OverallSelection } from './select-candidate.js';
import type { CompaniesHouseLookup } from './companies-house.js';
import { discoverFirstPartyEvidence, discoveryError, firstPartyUrl, normaliseDiscoveryDomain } from './discover-first-party-evidence.js';
import type { DiscoveryResult, EvidenceDiscovery } from './discover-first-party-evidence.js';
import { evidenceContextMismatch, extractCompanyCandidates, extractNamedEvidence } from './extract-company-candidates.js';
import type { CandidateOccurrence, ExtractedCandidate } from './extract-company-candidates.js';
import { sourcePriority } from './source-priority.js';
import { contentDiagnostics, fetchFirstPartyPage } from './fetch-first-party-page.js';
import { inspectEmbeddedEvidence, mergeCandidates } from './extract-embedded-evidence.js';
import type { PageResult } from './fetch-first-party-page.js';
import { resolveBrandLegalEntity, unresolved, verifyCandidateEvidence } from './resolve-brand-legal-entity.js';
import type { Proposal } from './resolve-brand-legal-entity.js';

export interface ResolverResult extends OverallSelection {
  discovered_sources?: { url: string; outcome: string; evidence_origin: 'discovered_url_direct' | 'search_evidence_fallback'; diagnostics: PageResult['diagnostics'] | null }[];
  named_role_evidence: CandidateOccurrence[];
  proposals: Proposal[];
  direct_proposals: Proposal[];
  discovery: DiscoveryResult | null;
  discovery_rejections: { index: number; reason: 'missing_or_wrong_domain' | 'source_not_in_search_sources' | 'no_deterministic_identifier' | 'context_mismatch' | 'market_context_mismatch' }[];
  attempts: { channel: 'direct_http' | 'embedded_page_data' | 'openai_web_search'; outcome: string }[];
}

/** Discovery proposes evidence; only the shared deterministic verifier decides recommendations. */
export async function resolveWithDiscovery(input: { brand_name: string; source_url: string; domain: string; target_market?: TargetMarket }, dependencies: {
  companiesHouse: CompaniesHouseLookup;
  fetchPage?: (url: string) => Promise<PageResult>;
  fetchDiscoveredPage?: (url: string) => Promise<PageResult>;
  discover?: EvidenceDiscovery;
}): Promise<ResolverResult> {
  // Cache registry results within this resolution, including failures, across channels.
  const profiles = new Map<string, ReturnType<CompaniesHouseLookup['getCompanyProfile']>>();
  const companiesHouse: CompaniesHouseLookup = { getCompanyProfile: number => {
    if (!profiles.has(number)) profiles.set(number, dependencies.companiesHouse.getCompanyProfile(number));
    return profiles.get(number)!;
  } };
  const direct = await resolveBrandLegalEntity(input, { ...dependencies, companiesHouse });
  const result: ResolverResult = { named_role_evidence: direct.flatMap(proposal => proposal.unlinked_named_evidence), ...selectCandidate(direct), proposals: direct, direct_proposals: direct, discovery: null, discovery_rejections: [],
    attempts: [{ channel: 'direct_http', outcome: direct[0]?.retrieval_diagnostics?.outcome ?? direct[0]!.reason }] };
  if (direct.some(item => item.evidence_groups.some(group => group.occurrences.some(occurrence => occurrence.retrieval_channel === 'embedded_page_data')))) {
    result.attempts.push({ channel: 'embedded_page_data', outcome: 'evidence_found' });
  }
  const fallbackReasons = new Set(['source_blocked', 'source_unavailable', 'insufficient_visible_text', 'retrieved_content_incomplete', 'no_company_evidence', 'relationship_role_inadequate', 'context_mismatch', 'market_context_mismatch', 'company_verification_failed', 'legal_name_unavailable']);
  if (direct.some(item => item.recommended_action === 'PROPOSE') || !direct.some(item => fallbackReasons.has(item.reason))) return result;
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
  const pages = new Map<string, PageResult>();
  const extractedPages = new Set<string>();
  result.discovered_sources = [];
  const ordered = discovery.candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => sourcePriority(b.candidate.source_url ?? '').priority - sourcePriority(a.candidate.source_url ?? '').priority);
  for (const { candidate, index } of ordered) {
    const url = firstPartyUrl(candidate.source_url, domain);
    if (!url) {
      result.discovery_rejections.push({ index, reason: 'missing_or_wrong_domain' }); continue;
    }
    if (!discovery.sources.some(source => firstPartyUrl(source.url, domain) === url)) {
      result.discovery_rejections.push({ index, reason: 'source_not_in_search_sources' }); continue;
    }
    let page = pages.get(url);
    if (!page) {
      try { page = await (dependencies.fetchDiscoveredPage ?? dependencies.fetchPage ?? fetchFirstPartyPage)(url); }
      catch { page = { ok: false, source_url: url, status: 'source_unavailable', reason: 'network_error', http_status: null }; }
      pages.set(url, page);
    }
    const finalUrl = page.ok ? firstPartyUrl(page.final_url, domain) : null;
    const outcome = page.ok ? (page.diagnostics ?? contentDiagnostics(page.content, page.content_type)).outcome : page.reason;
    if (page.ok && !finalUrl) {
      result.discovery_rejections.push({ index, reason: 'missing_or_wrong_domain' }); continue;
    }
    const embedded = page.ok && page.content_type === 'text/html'
      ? inspectEmbeddedEvidence(page.content, finalUrl!) : { candidates: [], named_evidence: [], incomplete: false };
    const pageCandidates = page.ok ? [...extractCompanyCandidates(page.content, finalUrl!, page.content_type), ...embedded.candidates] : [];
    // A retrieved document supersedes snippets. Sparse shells allow fallback only
    // when no deterministic identifiers were recoverable from visible/embedded data.
    const useDocument = page.ok && (outcome === 'success' || pageCandidates.length > 0);
    const origin = useDocument ? 'discovered_url_direct' as const : 'search_evidence_fallback' as const;
    if (!result.discovered_sources.some(source => source.url === url)) result.discovered_sources.push({ url, outcome, evidence_origin: origin, diagnostics: page.diagnostics ?? null });
    if (useDocument && page.ok) {
      if (extractedPages.has(url)) continue;
      extractedPages.add(url);
      const pageNamed = [...extractNamedEvidence(page.content, finalUrl!, page.content_type), ...embedded.named_evidence];
      for (const occurrence of [...pageCandidates.flatMap(item => item.occurrences), ...pageNamed]) {
        occurrence.evidence_origin = origin; occurrence.discovered_url = url;
      }
      found.push(...pageCandidates);
      result.named_role_evidence.push(...pageNamed);
      // No model-text fallback after an ordinary successful full-page retrieval.
      continue;
    }
    if (evidenceContextMismatch(candidate.evidence_text, input.brand_name)) {
      result.discovery_rejections.push({ index, reason: 'context_mismatch' }); continue;
    }
    if (marketContextMismatch(candidate.evidence_text, candidate.source_url!, input.target_market ?? 'GB')) {
      result.discovery_rejections.push({ index, reason: 'market_context_mismatch' }); continue;
    }
    // Treat quote/claim text as untrusted plain text. Never turn model-supplied
    // name/number/role fields into a synthetic sentence or a verified relationship.
    const extracted = extractCompanyCandidates(candidate.evidence_text, candidate.source_url!, 'text/plain');
    const named = extractNamedEvidence(candidate.evidence_text, candidate.source_url!, 'text/plain');
    for (const occurrence of named) { occurrence.evidence_origin = origin; occurrence.discovered_url = url; occurrence.retrieval_channel = 'openai_web_search'; occurrence.extraction_channel = 'discovery_text'; }
    result.named_role_evidence.push(...named);
    if (!extracted.length) {
      if (!named.some(occurrence => ['seller', 'site_operator', 'brand_operator'].includes(occurrence.role))) result.discovery_rejections.push({ index, reason: 'no_deterministic_identifier' });
      const proposal = unresolved(input.brand_name, url, 'discovery_identifier_unverified');
      proposal.recommended_action = 'REVIEW';
      proposal.reason = 'company_verification_failed';
      proposal.retrieval_channel = 'openai_web_search';
      proposal.source_snippet = candidate.evidence_text;
      proposal.verification.source_validated = true;
      proposal.verification.market_context_match = true;
      proposal.verification.brand_context_match = true;
      unverified.push(proposal);
    }
    for (const item of extracted) for (const occurrence of item.occurrences) {
      occurrence.evidence_origin = origin; occurrence.discovered_url = url;
      occurrence.retrieval_channel = 'openai_web_search';
      occurrence.extraction_channel = 'discovery_text';
    }
    found.push(...extracted);
  }
  result.attempts.push({ channel: 'openai_web_search', outcome: found.length ? 'evidence_found' : 'no_usable_evidence' });
  // Preserve relevant conflicts across pages/channels instead of selecting the best-looking result.
  const prior: ExtractedCandidate[] = direct.flatMap(proposal => proposal.company_number ? [{ company_number: proposal.company_number,
    source_url: proposal.source_url, occurrences: proposal.evidence_groups.flatMap(group => group.occurrences) }] : []);
  const fused = fuseDocumentEvidence(mergeCandidates([...prior, ...found]), result.named_role_evidence, input);
  if (!fused.length) { result.proposals = unverified.length ? [...direct, ...unverified] : direct; return { ...result, ...selectCandidate(result.proposals) }; }
  const verified = await verifyCandidateEvidence(fused, input, companiesHouse, direct[0]?.retrieval_diagnostics ?? null);
  for (const proposal of verified) {
    proposal.signals.push({ code: 'discovery_evidence_requires_verification', weight: 0, detail: 'Discovered URLs and fallback snippets require deterministic role and registry verification' });
    if (proposal.recommended_action === 'UNRESOLVED') proposal.recommended_action = 'REVIEW';
  }
  result.proposals = [...verified, ...unverified];
  return { ...result, ...selectCandidate(result.proposals) };
}
