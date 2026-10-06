import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractCompanyCandidates, pageText } from '../src/resolution/extract-company-candidates.js';

const url = 'https://www.example.com/terms';
export const knownAnswers = [
  ['charlotte-tilbury', '08037372', 'CHARLOTTE TILBURY BEAUTY LIMITED'],
  ['estee-lauder', '00659213', 'ESTEE LAUDER COSMETICS LIMITED'],
  ['vichy', '00271555', "L'OREAL (U.K.) LIMITED"],
] as const;

describe('labelled company extraction', () => {
  it.each(knownAnswers)('extracts %s fixture with source and nearby name', async (fixture, number) => {
    const html = await readFile(new URL(`./fixtures/resolution/${fixture}.html`, import.meta.url), 'utf8');
    const candidates = extractCompanyCandidates(html, url);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ company_number: number, source_url: url });
    expect(candidates[0]!.occurrences[0]!.possible_legal_name).not.toBeNull();
    expect(candidates[0]!.occurrences[0]!.source_snippet).toContain(number);
  });

  it.each(['Company number: 00123456', 'Company no. (00123456)', 'Registered number - 00123456',
    'Registered in England and Wales under number 00123456', 'company registration number #00123456'])
    ('preserves zeros for %s', text => expect(extractCompanyCandidates(text, url, 'text/plain')[0]?.company_number).toBe('00123456'));

  it.each(['SC012345', 'NI000123', 'OC012345', 'RC000641', 'sc 012345'])('recognises prefix %s', raw => {
    expect(extractCompanyCandidates(`Company no.: ${raw}`, url)[0]?.company_number).toBe(raw.toUpperCase().replace(' ', ''));
  });

  it.each(['Company number: 1234567', 'Company number: 123456789', 'Company number: SC12345',
    'Company number: SC1234567', 'Company number: XX123456', 'Company number: 08037372X',
    'Phone 08037372, date 20251006, VAT 12345678', 'VAT registration number 12345678', 'Charity registered number 12345678'])
    ('rejects malformed or unrelated number %s', text => expect(extractCompanyCandidates(text, url)).toEqual([]));

  it('does not extract scripts, hidden nodes, comments or HTML attributes', () => {
    const html = `<script>Company number 08037372</script><style>Company number 08037372</style>
      <!-- Company number 08037372 --><span hidden>Company number 08037372</span>
      <a href="https://example.com/company-number-08037372">Contact</a>`;
    expect(extractCompanyCandidates(html, url)).toEqual([]);
  });

  it('decodes entities and retains inline text without executing HTML', () => {
    expect(pageText('<p>Est&eacute;e <b>Lauder</b> &amp; Co.</p>')).toContain('Estée Lauder & Co.');
  });

  it('deduplicates repeated numbers but retains their occurrences', () => {
    const candidates = extractCompanyCandidates('<p>Alpha Limited, company number 00123456.</p><p>Company number 00123456</p><p>Beta Limited, company no. SC123456</p>', url);
    expect(candidates.map(item => item.company_number)).toEqual(['00123456', 'SC123456']);
    expect(candidates[0]!.occurrences).toHaveLength(2);
  });
});
