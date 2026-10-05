import { z } from 'zod';
import type { Row } from './database.js';

export class DataError extends Error {}
const id = z.string().min(1);
export const productRow = z.object({ id, canonical_name: z.string(), brand_id: id.nullable() });
export const brandRow = z.object({ id, canonical_name: z.string() });
export const entityRow = z.object({ id, canonical_name: z.string(), company_number: z.string().nullable() });
export const relationshipRow = z.object({ id, brand_id: id, legal_entity_id: id, relationship_type: z.string(),
  confidence: z.number(), verification_status: z.string(), valid_from: z.string().nullable(), valid_to: z.string().nullable() });
export const evidenceRow = z.object({ id, legal_entity_id: id.nullable(), product_id: id.nullable(), brand_id: id.nullable(),
  claim_type: z.string(), value_numeric: z.unknown(), value_text: z.string().nullable(), value_boolean: z.boolean().nullable(),
  unit: z.string().nullable(), source_name: z.string(), source_url: z.string(), reporting_period: z.string().nullable(),
  confidence: z.number(), verification_status: z.string() });
export const policyRow = z.object({ id, name: z.string(), is_active: z.boolean(), user_id: id.nullable() });
export const ruleRow = z.object({ id, policy_id: id, criterion: z.string(), operator: z.string(), threshold_numeric: z.number().nullable(),
  threshold_text: z.string().nullable(), action: z.string(), unknown_handling: z.string() });

export function parseRows<T>(schema: z.ZodType<T>, rows: Row[], label: string): T[] {
  const result = z.array(schema).safeParse(rows);
  if (!result.success) throw new DataError(`Invalid database rows for ${label}.`);
  return result.data;
}

export function oneOrNone(rows: Row[], label: string): Row | null {
  if (rows.length > 1) throw new DataError(`Ambiguous ${label}; resolve duplicates before continuing.`);
  return rows[0] ?? null;
}

export function requiredOne(rows: Row[], label: string): Row {
  const row = oneOrNone(rows, label);
  if (!row) throw new DataError(`Missing ${label}.`);
  return row;
}

export function assertSupportedRule(rule: z.infer<typeof ruleRow>): void {
  if (rule.criterion !== 'uk_median_gender_pay_gap' || rule.operator !== '<=' || rule.threshold_numeric !== 10
    || rule.threshold_text !== null || rule.action !== 'REQUIRE' || rule.unknown_handling !== 'UNKNOWN') {
    throw new DataError('Expected exactly one numeric REQUIRE rule: uk_median_gender_pay_gap <= 10, with UNKNOWN handling.');
  }
}
