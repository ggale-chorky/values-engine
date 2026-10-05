import { describe, expect, it, vi } from 'vitest';
import { normalizeCompanyNumber, parseCsv, parseMedian, prepareImport, transformRow } from '../src/importers/gender-pay-gap.js';
import { parseArgs, runImport } from '../src/scripts/import-gender-pay-gap.js';

const retrievedAt = '2026-10-05T12:00:00.000Z';
const row = {
  EmployerName: 'Original Ltd', CurrentName: 'Current Ltd', CompanyNumber: ' 00123456 ',
  EmployerId: '123', DiffMedianHourlyPercent: '-2.5', EmployerSize: '250 to 499',
  DateSubmitted: '2026/03/01 12:00:00', CompanyLinkToGPGInfo: 'https://example.test/report',
  ResponsiblePerson: 'Not imported',
};
const csv = 'EmployerName,EmployerId,CompanyNumber,DiffMedianHourlyPercent\r\n"Example, Ltd",123,00123456,-2.5\r\n';

describe('gender-pay-gap transformation', () => {
  it.each([
    [' 00123456 ', '00123456'], [' sc001234 ', 'SC001234'], ['ni000012', 'NI000012'],
    ['oc000123', 'OC000123'], ['  ', null], [undefined, null],
  ])('normalises %s without numeric coercion', (input, expected) => {
    expect(normalizeCompanyNumber(input)).toBe(expected);
  });

  it.each([
    ['-12.5', -12.5], ['0', 0], [' +10.25 ', 10.25], ['.5', 0.5], ['1e1', 10],
    ['', null], [' ', null], ['N/A', null], ['10%', null], ['12abc', null],
    ['Infinity', null], ['NaN', null], ['0x10', null], ['1e999', null], [undefined, null],
  ])('parses median %s strictly', (input, expected) => {
    expect(parseMedian(input)).toBe(expected);
  });

  it('creates factual evidence and only selected supporting metadata', () => {
    expect(transformRow(row, 2025, retrievedAt)).toEqual({
      entity: { canonical_name: 'Current Ltd', jurisdiction: 'GB', company_number: '00123456' },
      evidence: {
        claim_type: 'uk_median_gender_pay_gap', value_numeric: -2.5, unit: 'percent',
        source_name: 'UK Gender Pay Gap Service', source_type: 'government', source_record_id: '123',
        source_url: 'https://gender-pay-gap.service.gov.uk/employers/123', reporting_period: '2025-26',
        confidence: 1, verification_status: 'auto_verified', retrieved_at: retrievedAt,
        metadata: { EmployerName: 'Original Ltd', EmployerId: '123', EmployerSize: '250 to 499',
          DateSubmitted: '2026/03/01 12:00:00', CompanyLinkToGPGInfo: 'https://example.test/report' },
      },
      reason: null,
    });
  });

  it('falls back to EmployerName and excludes missing company numbers', () => {
    expect(transformRow({ ...row, CurrentName: ' ' }, 2025, retrievedAt).entity?.canonical_name).toBe('Original Ltd');
    expect(transformRow({ ...row, CompanyNumber: '' }, 2025, retrievedAt))
      .toEqual({ entity: null, evidence: null, reason: 'missing_company_number' });
    expect(transformRow({ ...row, CurrentName: '', EmployerName: '' }, 2025, retrievedAt).reason).toBe('missing_name');
  });

  it.each(['', 'invalid'])('retains the legal entity without median evidence for %s', value => {
    const result = transformRow({ ...row, DiffMedianHourlyPercent: value }, 2025, retrievedAt);
    expect(result.entity?.company_number).toBe('00123456');
    expect(result.evidence).toBeNull();
    expect(result.reason).toBe('invalid_median');
  });

  it('does not invent a missing or invalid employer ID', () => {
    for (const id of ['', '../invalid']) {
      expect(transformRow({ ...row, EmployerId: id }, 2025, retrievedAt).reason).toBe('invalid_employer_id');
    }
  });

  it('parses BOMs, quoted commas and multiline fields while preserving zeroes', () => {
    const parsed = parseCsv('\uFEFF' + csv.replace('Example, Ltd', 'Example,\nLtd'));
    expect(parsed[0]?.CompanyNumber).toBe('00123456');
    expect(parsed[0]?.EmployerName).toBe('Example,\nLtd');
  });

  it.each(['', '<html>unavailable</html>', csv + 'wrong,column,count', csv.replace('CompanyNumber', 'EmployerId')])
    ('rejects malformed or unexpected CSV', input => expect(() => parseCsv(input)).toThrow('Invalid gender-pay-gap CSV'));

  it('counts skipped rows and deduplicates bulk upsert keys with last valid row winning', () => {
    const plan = prepareImport([row, { ...row, DiffMedianHourlyPercent: '5' },
      { ...row, CompanyNumber: '' }, { ...row, CompanyNumber: 'SC000001', DiffMedianHourlyPercent: '' }], 2025, retrievedAt);
    expect(plan.statistics).toMatchObject({ total_rows: 4, rows_with_company_numbers: 3,
      valid_median_evidence_rows: 2, skipped_rows: 2, unique_legal_entities: 2,
      unique_evidence_records: 1, duplicate_evidence_rows: 1 });
    expect(plan.evidence[0]?.record.value_numeric).toBe(5);
  });

  it('rejects conflicting company identities for one employer before any writes', () => {
    expect(() => prepareImport([row, { ...row, CompanyNumber: '99999999' }], 2025, retrievedAt)).toThrow('Conflicting company numbers');
  });
});

describe('import command', () => {
  it('defaults to 2025 and validates flags', () => {
    expect(parseArgs([])).toEqual({ year: 2025, dryRun: false });
    expect(parseArgs(['--year=2025', '--dry-run'])).toEqual({ year: 2025, dryRun: true });
    for (const args of [['--year=bad'], ['--year=2016'], ['--other'], ['--year=2025', '--year=2024']]) {
      expect(() => parseArgs(args)).toThrow();
    }
  });

  it('downloads and transforms in dry-run without invoking the database writer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(csv));
    const write = vi.fn();
    const log = vi.fn();
    await runImport(['--year=2025', '--dry-run'], { fetch: fetchMock, write, log, now: () => new Date(retrievedAt) });
    expect(fetchMock).toHaveBeenCalledWith('https://gender-pay-gap.service.gov.uk/viewing/download-data/2025', expect.any(Object));
    expect(write).not.toHaveBeenCalled();
    const report = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(report).toMatchObject({ mode: 'dry-run', total_rows: 1, valid_median_evidence_rows: 1 });
    expect(report.samples[0].legal_entity_lookup.company_number).toBe('00123456');
    expect(report.samples[0].evidence.legal_entity_id).toBeNull();
  });

  it('does not write when downloading fails', async () => {
    const write = vi.fn();
    await expect(runImport([], { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })), write }))
      .rejects.toThrow('HTTP 503');
    expect(write).not.toHaveBeenCalled();
  });
});
