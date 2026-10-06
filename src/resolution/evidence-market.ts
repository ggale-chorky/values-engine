import { legalNamePattern } from './legal-name.js';
import type { CandidateOccurrence } from './extract-company-candidates.js';
/** UK-first scope checks. Absence of foreign scope defaults to the caller's GB context. */
export type TargetMarket = 'GB';
export function marketContextMismatch(text: string, sourceUrl: string, target: TargetMarket = 'GB'): boolean {
  if (target !== 'GB') return true;
  try {
    const url = new URL(sourceUrl);
    if (/(?:^|\/)(?:us|en-us|ie|en-ie|sg|en-sg|au|en-au|ca|en-ca|fr|de)(?:\/|$)/i.test(url.pathname.replaceAll('_', '-'))
      || /^(?:us|en-us|ie|sg|au|ca|fr|de)\./i.test(url.hostname)
      || /\.(?:ie|sg|au|ca|fr|de)$/.test(url.hostname)) return true;
  } catch { return true; }
  const foreign = '(?:United States|USA|U\\.S\\.A\\.?|Delaware|Ireland|Irish|Singapore|Australia|Canada|France|Germany)';
  return new RegExp(`\\b(?:registered|incorporated|organized|organised|governed|residents? (?:of|in)|customers? (?:in|of)|market\\s*:|jurisdiction\\s*:)[^;!?\\n]{0,120}\\b${foreign}\\b`, 'i').test(text)
    || new RegExp(`\\b(?:terms|privacy|website|site|brand)[^;.!?\\n]{0,100}\\b(?:for|in)\\s+[^;.!?\\n]{0,60}${foreign}\\b`, 'i').test(text);
}

export function explicitlyUkRegistration(text: string): boolean {
  return /\b(?:UK|U\.K\.|United Kingdom|British|England(?:\s*(?:and|&)\s*Wales)?|Scotland|Northern Ireland)\s+(?:company|registration)\b/i.test(text)
    || /\b(?:registered|incorporated)\s+in\s+(?:the\s+)?(?:UK|United Kingdom|England(?:\s*(?:and|&)\s*Wales)?|Scotland|Northern Ireland)\b/i.test(text);
}

/** Scope registration clauses to this legal entity, never an adjacent company. */
export function occurrenceMarketMismatch(occurrence: CandidateOccurrence, target: TargetMarket = 'GB'): boolean {
  const text = occurrence.block.text;
  const names = [...text.matchAll(legalNamePattern())];
  const name = occurrence.possible_legal_name;
  const matching = name ? names.filter(item => item[0].includes(name)) : [];
  // Repeated/ambiguous names cannot safely be scoped: retain the conservative block check.
  let local = text;
  if (matching.length === 1) {
    const index = names.indexOf(matching[0]!);
    local = text.slice(index === 0 ? 0 : matching[0]!.index, names[index + 1]?.index);
  }
  return marketContextMismatch([local, ...occurrence.block.heading_context].join('\n'), occurrence.source_url, target);
}
