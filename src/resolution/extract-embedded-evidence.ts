import { parseDocument } from 'htmlparser2';
import { extractCompanyCandidates } from './extract-company-candidates.js';
import type { ExtractedCandidate, ExtractionChannel } from './extract-company-candidates.js';

/** Parse data, never JavaScript. Each JSON string remains a separate semantic unit. */
export function inspectEmbeddedEvidence(html: string, sourceUrl: string): { candidates: ExtractedCandidate[]; incomplete: boolean } {
  let incomplete = false;
  const candidates: ExtractedCandidate[] = [];
  type Node = ReturnType<typeof parseDocument>['children'][number];
  let visited = 0;
  function values(value: unknown, path: string, channel: ExtractionChannel, depth = 0, sections: string[] = []): void {
    if (++visited > 10_000 || depth > 32) { incomplete = true; return; }
    if (typeof value === 'string') {
      if (value.length > 100_000) { incomplete = true; return; }
      const found = extractCompanyCandidates(value, sourceUrl, /<\/?[a-z][^>]*>/i.test(value) ? 'text/html' : 'text/plain');
      for (const candidate of found) for (const occurrence of candidate.occurrences) {
        occurrence.extraction_channel = channel;
        occurrence.retrieval_channel = 'embedded_page_data';
        occurrence.block.heading_context = [...sections, ...occurrence.block.heading_context];
        occurrence.block.dom_path = `${path}/${occurrence.block.dom_path}`;
      }
      candidates.push(...found);
    } else if (Array.isArray(value)) value.forEach((item, index) => values(item, `${path}[${index}]`, channel, depth + 1, sections));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const section = [record.title, record.heading, record.sectionName, record.section_name, record.name]
        .find(item => typeof item === 'string' && item.length <= 200 && /\bterms\b|\bconditions\b/i.test(item));
      const context = typeof section === 'string' ? [...sections, section] : sections;
      const name = record.legalName ?? record.name;
      const number = record.companyNumber ?? record.company_number ?? record.registrationNumber;
      // These explicit fields share one object; never infer a role from a generic publisher/name key.
      if (typeof name === 'string' && typeof number === 'string' && name.length < 300 && number.length < 30) {
        const fields = extractCompanyCandidates(`${name}, company number ${number}`, sourceUrl, 'text/plain');
        for (const item of fields) for (const occurrence of item.occurrences) {
          occurrence.role = 'unknown'; occurrence.role_basis = 'unknown'; occurrence.explicit_operator_or_seller = false;
          occurrence.extraction_channel = channel; occurrence.retrieval_channel = 'embedded_page_data';
          occurrence.source_snippet = JSON.stringify({ legalName: name, companyNumber: number });
          occurrence.block.text = occurrence.source_snippet; occurrence.block.dom_path = path;
          occurrence.block.heading_context = context;
        }
        candidates.push(...fields);
      }
      for (const [key, item] of Object.entries(value)) values(item, `${path}[${JSON.stringify(key)}]`, channel, depth + 1,
        /\bterms\b|\bconditions\b/i.test(key) && key.length <= 200 ? [...context, key] : context);
    }
  }
  let scriptIndex = 0;
  function visit(nodes: Node[]) {
    for (const node of nodes) if ('name' in node && 'children' in node) {
      if (node.name === 'script') {
        scriptIndex++;
        const type = node.attribs.type?.split(';')[0]?.trim().toLowerCase();
        if (!['application/ld+json', 'application/json', 'text/json'].includes(type ?? '') && node.attribs.id !== '__NEXT_DATA__') continue;
        const raw = node.children.map(child => child.type === 'text' ? child.data : '').join('');
        if (raw.length > 2_000_000) { incomplete = true; continue; }
        try { values(JSON.parse(raw), `script[${scriptIndex}]`, type === 'application/ld+json' ? 'structured_data' : 'embedded_page_state'); }
        catch { incomplete = true; /* Malformed JSON is not evidence. */ }
      } else visit(node.children);
    }
  }
  visit(parseDocument(html).children);
  return { candidates, incomplete };
}

export function extractEmbeddedEvidence(html: string, sourceUrl: string): ExtractedCandidate[] {
  return inspectEmbeddedEvidence(html, sourceUrl).candidates;
}

export function mergeCandidates(candidates: ExtractedCandidate[]): ExtractedCandidate[] {
  const merged = new Map<string, ExtractedCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.company_number);
    if (existing) existing.occurrences.push(...candidate.occurrences);
    else merged.set(candidate.company_number, { ...candidate, occurrences: [...candidate.occurrences] });
  }
  return [...merged.values()];
}
