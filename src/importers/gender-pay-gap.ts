import { parse } from 'csv-parse/sync';
import { z } from 'zod';

export const SOURCE_NAME = 'UK Gender Pay Gap Service';
export const CLAIM_TYPE = 'uk_median_gender_pay_gap';
export type CsvRow = Record<string, string>;

export function normalizeCompanyNumber(value: string | undefined): string | null {
  return value?.trim().toUpperCase() || null;
}

export function parseMedian(value: string | undefined): number | null {
  const text = value?.trim() ?? '';
  // Do not coerce blanks to zero or accept partial numbers, percentages or hex.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function reportingPeriod(year: number): string {
  if (!Number.isInteger(year) || year < 2017 || year > 9998) {
    throw new Error('Reporting year must be an integer between 2017 and 9998.');
  }
  return `${year}-${String(year + 1).slice(-2)}`;
}

export function parseCsv(csv: string): CsvRow[] {
  const required = ['EmployerName', 'EmployerId', 'CompanyNumber', 'DiffMedianHourlyPercent'];
  let headersSeen = false;
  try {
    const records: unknown = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 1_000_000,
      // Keep every cell as text, including leading zeros in identifiers.
      cast: false,
      columns: (headers: string[]) => {
        const trimmed = headers.map(header => header.trim());
        if (new Set(trimmed).size !== trimmed.length || required.some(header => !trimmed.includes(header))) {
          throw new Error('Invalid headers');
        }
        headersSeen = true;
        return trimmed;
      },
    });
    if (!headersSeen) throw new Error('Missing headers');
    return z.array(z.record(z.string(), z.string())).parse(records);
  } catch {
    throw new Error('Invalid gender-pay-gap CSV: check headers, quoting and row lengths.');
  }
}

export function transformRow(row: CsvRow, year: number, retrievedAt: string) {
  const companyNumber = normalizeCompanyNumber(row.CompanyNumber);
  if (!companyNumber) return { entity: null, evidence: null, reason: 'missing_company_number' } as const;
  const name = row.CurrentName?.trim() || row.EmployerName?.trim();
  if (!name) return { entity: null, evidence: null, reason: 'missing_name' } as const;
  const entity = { canonical_name: name, jurisdiction: 'GB', company_number: companyNumber };
  const median = parseMedian(row.DiffMedianHourlyPercent);
  if (median === null) return { entity, evidence: null, reason: 'invalid_median' } as const;
  const employerId = row.EmployerId?.trim() ?? '';
  if (!/^\d+$/.test(employerId)) return { entity, evidence: null, reason: 'invalid_employer_id' } as const;
  const evidence = {
    claim_type: CLAIM_TYPE,
    value_numeric: median,
    unit: 'percent',
    source_name: SOURCE_NAME,
    source_type: 'government',
    source_record_id: employerId,
    source_url: `https://gender-pay-gap.service.gov.uk/employers/${employerId}`,
    reporting_period: reportingPeriod(year),
    confidence: 1,
    verification_status: 'auto_verified',
    retrieved_at: retrievedAt,
    metadata: {
      EmployerName: row.EmployerName?.trim() || null,
      EmployerId: employerId,
      EmployerSize: row.EmployerSize?.trim() || null,
      DateSubmitted: row.DateSubmitted?.trim() || null,
      CompanyLinkToGPGInfo: row.CompanyLinkToGPGInfo?.trim() || null,
    },
  };
  return { entity, evidence, reason: null } as const;
}

export type EntityInput = NonNullable<ReturnType<typeof transformRow>['entity']>;
export type EvidenceInput = NonNullable<ReturnType<typeof transformRow>['evidence']>;

export function prepareImport(rows: CsvRow[], year: number, retrievedAt: string) {
  reportingPeriod(year);
  const entities = new Map<string, EntityInput>();
  const evidence = new Map<string, { company_number: string; record: EvidenceInput }>();
  const skippedByReason = { missing_company_number: 0, missing_name: 0, invalid_median: 0, invalid_employer_id: 0 };
  let rowsWithCompanyNumbers = 0;
  let validMedianEvidenceRows = 0;
  for (const row of rows) {
    if (normalizeCompanyNumber(row.CompanyNumber)) rowsWithCompanyNumbers++;
    const transformed = transformRow(row, year, retrievedAt);
    if (transformed.reason) skippedByReason[transformed.reason]++;
    if (transformed.entity) entities.set(transformed.entity.company_number, transformed.entity);
    if (transformed.evidence && transformed.entity) {
      validMedianEvidenceRows++;
      const id = transformed.evidence.source_record_id;
      const previous = evidence.get(id);
      if (previous && previous.company_number !== transformed.entity.company_number) {
        throw new Error('Conflicting company numbers for the same employer ID; import stopped before writes.');
      }
      evidence.set(id, { company_number: transformed.entity.company_number, record: transformed.evidence });
    }
  }
  return {
    entities: [...entities.values()],
    evidence: [...evidence.values()],
    statistics: {
      total_rows: rows.length,
      rows_with_company_numbers: rowsWithCompanyNumbers,
      valid_median_evidence_rows: validMedianEvidenceRows,
      skipped_rows: rows.length - validMedianEvidenceRows,
      skipped_by_reason: skippedByReason,
      unique_legal_entities: entities.size,
      unique_evidence_records: evidence.size,
      duplicate_evidence_rows: validMedianEvidenceRows - evidence.size,
    },
  };
}

export type ImportPlan = ReturnType<typeof prepareImport>;
