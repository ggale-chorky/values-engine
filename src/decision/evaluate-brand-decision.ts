import type { ReadDatabase } from '../db/database.js';
import { DataError } from '../db/rows.js';
import { evaluateBrandFromDb } from '../evaluation/evaluate-brand-from-db.js';
import { selectPolicy } from '../policies/service.js';

const unknownExplanations = {
  missing_evidence: 'No valid verified median UK gender-pay-gap evidence is available for the selected commerce entity.',
  no_verified_commerce_entity: 'No eligible human-verified UK commerce entity is available for this brand.',
  ambiguous_legal_entity: 'Multiple eligible human-verified UK commerce entities are associated with this brand; no entity was selected.',
  unsupported_rule: 'The selected policy contains an unsupported criterion, operator, action or unknown-handling setting.',
  invalid_rule: 'The selected policy does not contain exactly one complete, valid numeric rule.',
  inactive_policy: 'The selected policy is inactive.',
  brand_not_found: 'No brand matching the supplied name was found.',
  ambiguous_brand: 'Multiple brands match the supplied name; no brand was selected.',
  ambiguous_evidence: 'Multiple verified evidence records exist for the latest reporting period; no record was selected.',
} as const;
export type DecisionReason = 'threshold_met' | 'threshold_exceeded' | keyof typeof unknownExplanations;
export interface BrandDecision {
  decision: 'PASS' | 'FAIL' | 'UNKNOWN';
  reason: DecisionReason;
  policy: { id: string | null; name: string | null };
  rule: { criterion: string | null; operator: string | null; threshold: number | null };
  subject: { brand: string };
  entity: { legal_name: string | null; company_number: string | null; relationship_type: string | string[] | null; verification_status: string | null };
  evidence: { observed_value: number | null; unit: 'percent' | null; reporting_period: string | null; source_name: string | null; source_url: string | null; evidence_id: string | null };
  scope: string;
  explanation: string;
}

function explanation(result: Omit<BrandDecision, 'explanation'>): string {
  if (result.decision === 'UNKNOWN') {
    if (result.reason in unknownExplanations) return unknownExplanations[result.reason as keyof typeof unknownExplanations];
    throw new DataError('Unexpected UNKNOWN decision reason.');
  }
  const ending = result.decision === 'PASS' ? 'passes' : 'exceeds';
  return `Your policy allows a median UK gender pay gap of up to ${result.rule.threshold}%. ${result.entity.legal_name} reports ${result.evidence.observed_value}% for ${result.evidence.reporting_period}, so this ${ending} your rule.`;
}

/** Presentation adapter only: policy interpretation and every decision stay in the existing evaluation path. */
export async function evaluateBrandDecision(input: { brand: string; policy: string }, dependencies: {
  db: ReadDatabase;
  asOf?: string;
}): Promise<BrandDecision> {
  if (!input.brand.trim() || !input.policy.trim()) throw new DataError('Brand and policy are required.');
  const policy = await selectPolicy(dependencies.db, input.policy);
  const evaluated = await evaluateBrandFromDb(dependencies.db, input.brand,
    dependencies.asOf ?? new Date().toISOString().slice(0, 10), policy);
  const reason = evaluated.reason;
  if (reason !== 'threshold_met' && reason !== 'threshold_exceeded' && !Object.hasOwn(unknownExplanations, reason)) {
    throw new DataError('Unexpected evaluation reason.');
  }
  const result: Omit<BrandDecision, 'explanation'> = {
    decision: evaluated.final_status, reason: reason as DecisionReason,
    policy: { id: evaluated.policy_id, name: evaluated.policy_name },
    rule: { criterion: evaluated.criterion || null, operator: evaluated.operator || null, threshold: evaluated.threshold },
    subject: { brand: evaluated.brand },
    entity: { legal_name: evaluated.legal_entity, company_number: evaluated.company_number,
      relationship_type: evaluated.relationship_type, verification_status: evaluated.relationship_verification_status },
    evidence: { observed_value: evaluated.observed_value,
      // PASS/FAIL guarantees the existing evaluator validated unit=percent. UNKNOWN
      // does not expose a validated unit, so do not invent one or re-read evidence.
      unit: evaluated.final_status === 'UNKNOWN' ? null : 'percent', reporting_period: evaluated.reporting_period,
      source_name: evaluated.evidence_source?.name ?? null, source_url: evaluated.evidence_source?.url ?? null,
      evidence_id: evaluated.evidence_id },
    scope: evaluated.scope,
  };
  return { ...result, explanation: explanation(result) };
}
