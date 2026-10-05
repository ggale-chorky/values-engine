import { evaluateRule, ruleProblem, unknownResult } from './evaluate-rule.js';
import { isCalendarDate, isVerified, reportingYear } from './types.js';
import type { BrandEntityRelationship, Evidence, PolicyRule, RuleEvaluation } from './types.js';

export const MIN_RELATIONSHIP_CONFIDENCE = 0.9;

export interface ProductEvaluationInput {
  product: { id: string; brand_id: string | null };
  brands: readonly { id: string; canonical_name: string }[];
  legal_entities: readonly { id: string; canonical_name: string; company_number: string | null }[];
  relationships: readonly BrandEntityRelationship[];
  evidence: readonly Evidence[];
  rule: PolicyRule;
  // Explicit date keeps results independent of the machine clock.
  as_of: string;
}

function usable(relationship: BrandEntityRelationship, asOf: string): boolean {
  const { valid_from: from, valid_to: to } = relationship;
  return isVerified(relationship.verification_status)
    && Number.isFinite(relationship.confidence)
    && relationship.confidence >= MIN_RELATIONSHIP_CONFIDENCE && relationship.confidence <= 1
    && (from === null || (isCalendarDate(from) && from <= asOf))
    && (to === null || (isCalendarDate(to) && to >= asOf))
    && (from === null || to === null || from <= to);
}

/** Evaluate the MVP's single required rule over a supplied, complete local snapshot. */
export function evaluateProduct(input: ProductEvaluationInput): RuleEvaluation & { product_id: string; brand_id: string | null } {
  const { product, rule, as_of: asOf } = input;
  const wrap = (result: RuleEvaluation) => ({ ...result, product_id: product.id, brand_id: product.brand_id });
  const problem = ruleProblem(rule);
  if (problem) return wrap(unknownResult(rule, problem));
  if (!isCalendarDate(asOf)) return wrap(unknownResult(rule, 'invalid_evaluation_date'));
  if (!product.brand_id || !input.brands.some(brand => brand.id === product.brand_id)) {
    return wrap(unknownResult(rule, 'missing_brand'));
  }
  const relationships = input.relationships.filter(link => link.brand_id === product.brand_id && usable(link, asOf));
  if (relationships.length === 0) return wrap(unknownResult(rule, 'unresolved_legal_entity'));
  // Even two records naming the same entity require explicit reconciliation.
  if (relationships.length > 1) return wrap(unknownResult(rule, 'ambiguous_legal_entity'));
  const entityId = relationships[0]!.legal_entity_id;
  if (!input.legal_entities.some(entity => entity.id === entityId)) {
    return wrap(unknownResult(rule, 'missing_legal_entity', entityId));
  }
  const relevant = input.evidence.filter(item => item.legal_entity_id === entityId && item.claim_type === rule.criterion);
  if (relevant.length === 0) return wrap(unknownResult(rule, 'missing_evidence', entityId));
  const verified = relevant.filter(item => isVerified(item.verification_status));
  if (verified.length === 0) return wrap(unknownResult(rule, 'unverified_evidence', entityId));
  // A malformed period cannot be safely ranked against other verified evidence.
  if (verified.some(item => reportingYear(item.reporting_period) === null)) {
    return wrap(unknownResult(rule, 'invalid_evidence', entityId));
  }
  const latestYear = Math.max(...verified.map(item => reportingYear(item.reporting_period)!));
  const latest = verified.filter(item => reportingYear(item.reporting_period) === latestYear);
  if (latest.length > 1) return wrap(unknownResult(rule, 'ambiguous_evidence', entityId));
  // Validate after selecting the period: never fall back from an invalid latest value.
  return wrap(evaluateRule(rule, latest[0]!, { legal_entity_id: entityId, relationship_verified: true }));
}
