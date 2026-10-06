import { parseDocument } from 'htmlparser2';
import { normalizeCompanyNumber } from '../importers/gender-pay-gap.js';
import { COMPANY_NUMBER_PATTERN } from './companies-house.js';

export type CandidateRole = 'site_operator' | 'seller' | 'brand_operator' | 'promoter' | 'licensor' | 'data_controller' | 'unknown';
export type ExtractionChannel = 'visible_dom' | 'structured_data' | 'embedded_page_state' | 'discovery_text';
export type RetrievalChannel = 'direct_http' | 'embedded_page_data' | 'openai_web_search';
export interface TextBlock {
  text: string;
  heading_context: string[];
  dom_path: string;
  dom_order: number;
  authority: 'primary' | 'secondary';
}
export interface CandidateOccurrence {
  context_mismatch?: boolean;
  source_url: string;
  extraction_channel: ExtractionChannel;
  retrieval_channel: RetrievalChannel;
  source_snippet: string;
  possible_legal_name: string | null;
  role: CandidateRole;
  role_basis: 'explicit' | 'section_context' | 'unknown';
  block: TextBlock;
  explicit_operator_or_seller: boolean;
}
export interface ExtractedCandidate { company_number: string; source_url: string; occurrences: CandidateOccurrence[] }
export const isShoppingRole = (role: CandidateRole) => ['site_operator', 'seller', 'brand_operator'].includes(role);

/** Only explicit brand labels/scopes count; legal company names need not match a brand. */
export function evidenceContextMismatch(text: string, brand: string): boolean {
  const normalise = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const labels = [...text.matchAll(/\b(?:brand|brand name)\s*:\s*([^\n.;]{1,80})|\bterms for [“"]([^”"\n]{1,80})[”"]/gi)];
  return labels.some(match => normalise((match[1] ?? match[2])!.trim()) !== normalise(brand));
}

type Node = ReturnType<typeof parseDocument>['children'][number];
const boundaries = new Set(['p', 'li', 'td', 'th', 'dt', 'dd', 'address', 'div', 'section', 'article', 'main', 'body', 'header', 'footer', 'table', 'tr', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Keep block boundaries and scoped headings; never borrow a name from a sibling block. */
export function pageBlocks(content: string, type: 'text/html' | 'text/plain' = 'text/html'): TextBlock[] {
  if (type === 'text/plain') return content.split(/\n\s*\n/).map((text, index) => ({ text: compact(text),
    heading_context: [], dom_path: `text[${index}]`, dom_order: index, authority: 'primary' as const })).filter(block => block.text);
  const blocks: TextBlock[] = [];
  function walk(nodes: Node[], path: string, headings: { level: number; text: string }[], secondary: boolean) {
    let context = [...headings];
    let text = '';
    let segment = 0;
    const flush = () => {
      if (compact(text)) blocks.push({ text: compact(text), heading_context: context.map(heading => heading.text), dom_path: `${path}/text()[${segment++}]`,
        dom_order: blocks.length, authority: secondary || context.some(heading => /\b(privacy|competition|promotion|giveaway|licens|copyright)/i.test(heading.text)) ? 'secondary' : 'primary' });
      text = '';
    };
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.type === 'text') { text += node.data; continue; }
      if (!('name' in node) || !('children' in node)) continue;
      const name = node.name;
      const attrs = node.attribs;
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      if (['head', 'title', 'script', 'style', 'noscript', 'template', 'nav', 'menu'].includes(name) || 'hidden' in attrs
        || attrs['aria-hidden'] === 'true' || ['navigation', 'menu'].includes(attrs.role ?? '')) { flush(); continue; }
      const childPath = `${path}/${name}[${count}]`;
      if (name === 'br') { text += ' '; continue; }
      const low = secondary || name === 'footer' || attrs.role === 'contentinfo';
      if (boundaries.has(name) || low !== secondary) {
        flush();
        const start = blocks.length;
        walk(node.children, childPath, context, low);
        if (/^h[1-6]$/.test(name)) {
          const heading = compact(blocks.slice(start).map(block => block.text).join(' '));
          const level = Number(name[1]);
          context = context.filter(item => item.level < level);
          if (heading) context.push({ level, text: heading });
        }
      } else {
        const hasBoundary = (children: Node[]): boolean => children.some(child => 'name' in child && 'children' in child
          && (boundaries.has(child.name) || hasBoundary(child.children)));
        if (hasBoundary(node.children)) { flush(); walk(node.children, childPath, context, low); continue; }
        // Inline tags are transparent, while any nested semantic blocks still split.
        const inline = (children: Node[]): string => children.map(child => {
          if (child.type === 'text') return child.data;
          if ('name' in child && 'children' in child) {
            if (['head', 'title', 'script', 'style', 'template', 'noscript', 'nav'].includes(child.name)
              || 'hidden' in child.attribs || child.attribs['aria-hidden'] === 'true') return ' ';
            return inline(child.children);
          }
          return '';
        }).join('');
        text += inline(node.children);
      }
    }
    flush();
  }
  walk(parseDocument(content).children, '', [], false);
  return blocks;
}
export function pageText(content: string, type: 'text/html' | 'text/plain' = 'text/html'): string {
  return pageBlocks(content, type).map(block => block.text).join('\n');
}

function roleFor(beforeName: string, afterName: string, block: TextBlock): { role: CandidateRole; role_basis: CandidateOccurrence['role_basis'] } {
  if (/\b(former|previous|formerly|no longer|not)\b/i.test(beforeName + afterName)) return { role: 'unknown', role_basis: 'unknown' };
  // Explicit defined roles take precedence over general "we/us" operator wording.
  const licensor = afterName.match(/\(\s*[“"'](?:the\s+)?Licensor[”"'][^)]*\)/i);
  const noOtherSubject = (text: string) => !/\b(limited|ltd|plc|llp|they|third.party|another|other company|suppliers|retailers|while|whereas)\b/i.test(text.replace(/\([^)]*\)/g, ' '));
  if (licensor && noOtherSubject(afterName.slice(0, licensor.index))) return { role: 'licensor', role_basis: 'explicit' };
  const supply = afterName.match(/\b(?:supply|supplies|sell|sells)\b[^.!?;]{0,400}\b(?:products|goods)\b[^.!?;]{0,400}\bto\s+you\b/i);
  if (supply && noOtherSubject(afterName.slice(0, supply.index))
    && !/[.!?]\s+(?!we\b)/i.test(afterName.slice(0, supply.index).replace(/\([^)]*\)/g, ' '))) {
    return { role: 'seller', role_basis: 'explicit' };
  }
  const patterns: [CandidateRole, RegExp][] = [
    ['seller', /(?:seller\s+(?:is|:)|(?:products|goods)\s+are\s+sold\s+by)\s*$/i],
    ['site_operator', /(?:operated\s+by|site operator\s+(?:is|:))\s*$/i],
    ['brand_operator', /(?:brand\s+is\s+operated\s+by|brand operator\s+(?:is|:))\s*$/i],
    ['promoter', /(?:promoter\s+(?:is|:)|(?:programme|program)\s+is\s+offered\s+(?:at the sole discretion of|by))\s*$/i],
    ['licensor', /licensor\s+(?:is|:)\s*$/i],
    ['data_controller', /data controller\s+(?:is|:)\s*$/i],
  ];
  // Specific brand operation takes precedence over generic "operated by".
  if (/brand\s+is\s+operated\s+by\s*$/i.test(beforeName)) return { role: 'brand_operator', role_basis: 'explicit' };
  for (const [role, pattern] of patterns) if (pattern.test(beforeName)) return { role, role_basis: 'explicit' };
  if (/we\s+are\s*$/i.test(beforeName)) return { role: 'site_operator', role_basis: 'explicit' };
  // Parenthetical registry/address details may intervene before the predicate.
  const predicate = afterName.replace(/\([^)]*\)/g, ' ').replace(/^\s*,?\s*registered\b[^;]*?,\s*(?=(?:is|acts as|operates)\b)/i, ' ');
  if (/^\s*,?\s*operates\s+(?:the|this)\s+(?:web)?site\b/i.test(predicate)) return { role: 'site_operator', role_basis: 'explicit' };
  const post = predicate.match(/^\s*,?\s*(?:is|acts as)\s+(?:the\s+)?(seller|site operator|brand operator|promoter|licensor|data controller)\b/i);
  if (post) return { role: post[1]!.toLowerCase().replaceAll(' ', '_') as CandidateRole, role_basis: 'explicit' };
  // Registry/address clauses can be long. Inspect the entire company-bound block,
  // but do not transfer a predicate past another company or a new sentence/subject.
  const distant = afterName.match(/\b(?:is|acts as)\s+(?:the\s+)?(seller|site operator|brand operator|promoter|licensor|data controller)\b/i);
  if (distant) {
    const intervening = afterName.slice(0, distant.index);
    if (/\b(company\s+(?:number|no)|registered|registration)\b/i.test(intervening)
      && !/\b(limited|ltd|plc|llp|while|whereas|but|they|he|she)\b|[.!?]\s+[A-Z]/i.test(intervening.replace(/\([^)]*\)/g, ' '))) {
      return { role: distant[1]!.toLowerCase().replaceAll(' ', '_') as CandidateRole, role_basis: 'explicit' };
    }
  }
  // Registration identifies a company, not its role; only sale-specific section context can supply that role.
  if (block.authority === 'primary' && block.heading_context.some(heading => /terms (?:(?:and|&) conditions )?of sale|sales terms|who you (?:buy|purchase) from/i.test(heading))
    && /(?:is\s+(?:a\s+)?company\s+registered|registered|company\s+(?:registration\s+)?(?:number|no\.?))/i.test(afterName)) {
    return { role: 'seller', role_basis: 'section_context' };
  }
  return { role: 'unknown', role_basis: 'unknown' };
}

export function extractCompanyCandidates(content: string, sourceUrl: string,
  type: 'text/html' | 'text/plain' = 'text/html'): ExtractedCandidate[] {
  const candidates = new Map<string, ExtractedCandidate>();
  for (const block of pageBlocks(content, type)) {
    // Intl segmentation preserves abbreviations such as U.K. and Ltd. better than splitting on every dot.
    const masked = block.text.replace(/\bno\.(?=\s*[(#:]*\s*(?:[A-Z]{2}\s*)?\d)/gi, value => value.slice(0, -1) + '_');
    const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(masked)]
      .map(item => block.text.slice(item.index, item.index + item.segment.length));
    for (const sentence of sentences) {
      const label = /\b(?:company\s+(?:registration\s+)?(?:number|no\.?)|registered(?:\s+company)?\s+(?:number|no\.?)|registration\s+number|registered\s+in\s+(?:england(?:\s+and\s+wales)?|scotland|northern\s+ireland)\s+(?:under\s+)?(?:company\s+)?(?:number|no\.?))[\s:.,#()\[\]–—-]{0,24}(?:is\s+)?((?:[A-Z]{2}\s*)?\d{6,8})(?![\p{L}\p{N}])/giu;
      let previousEnd = 0;
      for (const match of sentence.matchAll(label)) {
        const before = sentence.slice(previousEnd, match.index);
        previousEnd = match.index + match[0].length;
        if (/(?:VAT|tax|charity|phone|telephone)\s*$/i.test(before)) continue;
        const number = normalizeCompanyNumber(match[1]!.replace(/\s+/g, ''))!;
        if (!COMPANY_NUMBER_PATTERN.test(number)) continue;
        const namePattern = /\b[\p{Lu}][\p{L}\p{M}\p{N}'’&().-]*(?:\s+(?:[\p{Lu}(][\p{L}\p{M}\p{N}'’&().-]*|and|of|the|&)){0,18}\s+(?:LIMITED|Limited|LTD|Ltd|PLC|plc|LLP|llp)\b/gu;
        const names = [...before.matchAll(namePattern)];
        const blockNames = [...block.text.matchAll(namePattern)];
        const blockNumbers = [...block.text.matchAll(label)];
        const blockNumber = blockNumbers[0];
        const postfix = blockNumber ? block.text.slice(blockNumber.index + blockNumber[0].length).replace(/^\s*\)\s*/, '') : '';
        const boundPostfix = blockNames.length === 1 && blockNumbers.length === 1
          && /^\s*,?\s*(?:is\s+(?:the\s+)?(?:promoter|seller|site operator|brand operator|licensor|data controller)|operates\s+(?:the|this)\s+(?:web)?site)\b/i.test(postfix);
        const localName = names.at(-1);
        const name = localName ?? (boundPostfix && blockNames[0]!.index < blockNumber!.index ? blockNames[0] : undefined);
        const possibleName = name?.[0].replace(/^(?:(?:THE )?(?:SELLER|SITE OPERATOR|BRAND OPERATOR|PROMOTER|LICENSOR|DATA CONTROLLER) IS|WE ARE|COPYRIGHT)\s+/i, '') ?? null;
        const nameContext = localName ? before : block.text;
        const beforeName = name ? nameContext.slice(0, name.index + name[0].length - possibleName!.length) : '';
        const afterName = name ? localName
          ? sentence.slice(match.index - before.length + name.index + name[0].length)
          : block.text.slice(name.index + name[0].length) : '';
        let inferred = possibleName ? roleFor(beforeName, afterName, block) : { role: 'unknown' as const, role_basis: 'unknown' as const };
        if (possibleName && inferred.role === 'unknown' && boundPostfix
          && !/\b(former|previous|formerly|no longer|not)\b/i.test(block.text)) inferred = roleFor('', postfix, block);
        // A single named company/identifier in a block can have registry details
        // spanning sentence segmentation. Never borrow from another named entity.
        if (possibleName && inferred.role === 'unknown' && [...block.text.matchAll(namePattern)].length === 1
          && [...block.text.matchAll(label)].length === 1) {
          const offset = block.text.indexOf(possibleName);
          inferred = roleFor(block.text.slice(0, offset), block.text.slice(offset + possibleName.length), block);
        }
        const occurrence: CandidateOccurrence = { source_url: sourceUrl, extraction_channel: 'visible_dom', retrieval_channel: 'direct_http',
          source_snippet: boundPostfix ? block.text : sentence.trim(), possible_legal_name: possibleName,
          ...inferred, block, explicit_operator_or_seller: isShoppingRole(inferred.role) && inferred.role_basis === 'explicit' };
        const previous = candidates.get(number);
        if (previous) previous.occurrences.push(occurrence);
        else candidates.set(number, { company_number: number, source_url: sourceUrl, occurrences: [occurrence] });
      }
    }
  }
  return [...candidates.values()];
}
