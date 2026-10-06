import type { CandidateOccurrence } from './extract-company-candidates.js';
import { marketContextMismatch } from './evidence-market.js';

/** Heuristic ordering of sources, never a substitute for registry/role verification. */
export function sourcePriority(url: string, headings: string[] = []): { priority: number; exclusion?: string } {
  try {
    const parsed = new URL(url);
    const scope = `${decodeURIComponent(parsed.pathname)} ${headings.join(' ')}`;
    if (/\b(careers?|jobs?|applicant|recruitment|recruiting)\b/i.test(scope)) return { priority: -100, exclusion: 'non_shopping_recruitment' };
    if (/\b(competition|contest|giveaway|promotion|promotional|loyalty)\b/i.test(scope)) return { priority: -90, exclusion: 'non_shopping_programme' };
    if (marketContextMismatch('', url)) return { priority: -80, exclusion: 'foreign_market' };
    let priority = 0;
    if (/(?:^|\/)(?:uk|gb|en-gb)(?:\/|$)/i.test(parsed.pathname) || /^(?:uk|gb)\./i.test(parsed.hostname) || /\.uk$/i.test(parsed.hostname)) priority += 30;
    if (parsed.hostname.replace(/^www\./, '').split('.').length <= (parsed.hostname.endsWith('.co.uk') ? 3 : 2)) priority += 10;
    if (/terms|conditions|legal[- /]notice/i.test(scope)) priority += 20;
    if (/privacy|cookies?/i.test(scope)) priority -= 10;
    return { priority };
  } catch { return { priority: -100, exclusion: 'invalid_source_url' }; }
}

export function annotateSource(occurrence: CandidateOccurrence): void {
  const ranking = sourcePriority(occurrence.source_url, occurrence.block.heading_context);
  occurrence.source_priority = ranking.priority;
  if (ranking.exclusion) occurrence.source_exclusion = ranking.exclusion;
}
