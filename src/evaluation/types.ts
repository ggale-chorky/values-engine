export interface PolicyRule {
  criterion: string;
  operator: string;
  threshold_numeric: number | null;
  action?: string;
  unknown_handling?: string;
}

export interface Evidence {
  id: string;
  legal_entity_id: string | null;
  product_id?: string | null;
  brand_id?: string | null;
  claim_type: string;
  // Validate at runtime; never coerce null, blanks or numeric strings to numbers.
  value_numeric: unknown;
  value_text?: string | null;
  value_boolean?: boolean | null;
  unit: string | null;
  source_name: string;
  source_url: string;
  reporting_period: string | null;
  confidence: number;
  verification_status: string;
}

export interface BrandEntityRelationship {
  id: string;
  brand_id: string;
  legal_entity_id: string;
  relationship_type: string;
  confidence: number;
  verification_status: string;
  valid_from: string | null;
  valid_to: string | null;
}

export type EvaluationReason =
  | 'threshold_met' | 'threshold_exceeded' | 'unsupported_rule' | 'invalid_rule'
  | 'missing_brand' | 'missing_legal_entity' | 'unresolved_legal_entity' | 'ambiguous_legal_entity'
  | 'invalid_evaluation_date' | 'missing_evidence' | 'unverified_evidence'
  | 'invalid_evidence' | 'ambiguous_evidence';

export interface RuleEvaluation {
  criterion: string;
  result: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: EvaluationReason;
  threshold: number | null;
  observed_value: number | null;
  evidence_id: string | null;
  evidence_source: { name: string; url: string } | null;
  reporting_period: string | null;
  legal_entity_id: string | null;
}

export interface ResolvedEntity {
  legal_entity_id: string;
  relationship_verified: boolean;
}

export function isVerified(status: string): boolean {
  return status === 'human_verified' || status === 'auto_verified';
}

export function reportingYear(period: string | null): number | null {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  const year = Number(period.slice(0, 4));
  return year >= 2017 && Number(period.slice(5)) === (year + 1) % 100 ? year : null;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
