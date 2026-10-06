import { Parser } from 'htmlparser2';
import { normalizeCompanyNumber } from '../importers/gender-pay-gap.js';
import { COMPANY_NUMBER_PATTERN } from './companies-house.js';

export interface CandidateOccurrence {
  source_snippet: string;
  possible_legal_name: string | null;
  explicit_operator_or_seller: boolean;
}
export interface ExtractedCandidate {
  company_number: string;
  source_url: string;
  occurrences: CandidateOccurrence[];
}

export function pageText(content: string, type: 'text/html' | 'text/plain' = 'text/html'): string {
  if (type === 'text/plain') return content.replace(/\r/g, '').replace(/[^\S\n]+/g, ' ');
  const parts: string[] = [];
  let hiddenDepth = 0;
  const blocks = new Set(['p', 'div', 'section', 'article', 'li', 'br', 'h1', 'h2', 'h3', 'td', 'tr']);
  const parser = new Parser({
    onopentag(name, attributes) {
      if (hiddenDepth) hiddenDepth++;
      else if (['script', 'style', 'noscript', 'template'].includes(name) || 'hidden' in attributes || attributes['aria-hidden'] === 'true') hiddenDepth = 1;
      else if (blocks.has(name)) parts.push('\n');
    },
    ontext(text) { if (!hiddenDepth) parts.push(text); },
    onclosetag(name) { if (hiddenDepth) hiddenDepth--; else if (blocks.has(name)) parts.push('\n'); },
  }, { decodeEntities: true });
  parser.end(content);
  return parts.join('').replace(/\r/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n+/g, '\n');
}

export function extractCompanyCandidates(content: string, sourceUrl: string,
  type: 'text/html' | 'text/plain' = 'text/html'): ExtractedCandidate[] {
  const text = pageText(content, type);
  const label = /\b(?:company\s+(?:registration\s+)?(?:number|no\.?)|registered(?:\s+company)?\s+(?:number|no\.?)|registration\s+number|registered\s+in\s+(?:england(?:\s+and\s+wales)?|scotland|northern\s+ireland)\s+(?:under\s+)?(?:company\s+)?(?:number|no\.?))[\s:.,#()\[\]–—-]{0,24}(?:is\s+)?((?:[A-Z]{2}\s*)?\d{6,8})(?![\p{L}\p{N}])/giu;
  const candidates = new Map<string, ExtractedCandidate>();
  for (const match of text.matchAll(label)) {
    if (/(?:VAT|tax|charity|phone|telephone)\s*$/i.test(text.slice(Math.max(0, match.index - 30), match.index))) continue;
    const number = normalizeCompanyNumber(match[1]!.replace(/\s+/g, ''))!;
    if (!COMPANY_NUMBER_PATTERN.test(number)) continue;
    const before = text.slice(Math.max(0, match.index - 240), match.index);
    const namePattern = /\b[\p{Lu}\p{N}][\p{L}\p{M}\p{N}'’&().-]*(?:[ \t]+(?:[\p{Lu}\p{N}(][\p{L}\p{M}\p{N}'’&().-]*|and|of|the|&)){0,18}[ \t]+(?:LIMITED|Limited|LTD|Ltd|PLC|plc|LLP|llp)\b/gu;
    const names = [...before.matchAll(namePattern)];
    const name = names.at(-1);
    const possibleName = name?.[0].replace(/^(?:WE ARE|THE SELLER IS)\s+/, '') ?? null;
    const beforeName = name ? before.slice(0, name.index).slice(-100) : '';
    const explicit = /(?:(?:site|website|store|shop)\s+(?:is\s+)?(?:owned and )?operated\s+by|(?:products|goods)\s+are\s+sold\s+by|(?:seller|contracting entity)\s+(?:is|:))\s*$/i.test(beforeName);
    const occurrence = {
      source_snippet: text.slice(Math.max(0, match.index - 240), match.index + match[0].length + 100).replace(/\s+/g, ' ').trim(),
      possible_legal_name: possibleName,
      explicit_operator_or_seller: explicit,
    };
    const previous = candidates.get(number);
    if (previous) previous.occurrences.push(occurrence);
    else candidates.set(number, { company_number: number, source_url: sourceUrl, occurrences: [occurrence] });
  }
  return [...candidates.values()];
}
