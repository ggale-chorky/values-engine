import { isVerified, reportingYear } from './types.js';
import type { Evidence, EvaluationReason, PolicyRule, ResolvedEntity, RuleEvaluation } from './types.js';

export function unknownResult(rule: PolicyRule, reason: EvaluationReason, legalEntityId: string | null = null): RuleEvaluation {
  return {
    criterion: rule.criterion, result: 'UNKNOWN', reason,
    threshold: typeof rule.threshold_numeric === 'number' && Number.isFinite(rule.threshold_numeric) ? rule.threshold_numeric : null,
    observed_value: null, evidence_id: null, evidence_source: null,
    reporting_period: null, legal_entity_id: legalEntityId,
  };
}

export function ruleProblem(rule: PolicyRule): 'unsupported_rule' | 'invalid_rule' | null {
  if (rule.criterion !== 'uk_median_gender_pay_gap' || rule.operator !== '<='
    || (rule.action !== undefined && rule.action !== 'REQUIRE')
    || (rule.unknown_handling !== undefined && rule.unknown_handling !== 'UNKNOWN')) return 'unsupported_rule';
  if (typeof rule.threshold_numeric !== 'number' || !Number.isFinite(rule.threshold_numeric)) return 'invalid_rule';
  return null;
}

/** Compare one claim only after the caller has resolved a verified entity link. */
export function evaluateRule(rule: PolicyRule, evidence: Evidence | null, entity: ResolvedEntity | null): RuleEvaluation {
  const problem = ruleProblem(rule);
  if (problem) return unknownResult(rule, problem);
  if (!entity?.relationship_verified || !entity.legal_entity_id.trim()) return unknownResult(rule, 'unresolved_legal_entity');
  const base = unknownResult(rule, 'missing_evidence', entity.legal_entity_id);
  if (!evidence || evidence.claim_type !== rule.criterion || evidence.legal_entity_id !== entity.legal_entity_id) return base;
  const explanation: RuleEvaluation = {
    ...base,
    evidence_id: evidence.id,
    evidence_source: { name: evidence.source_name, url: evidence.source_url },
    reporting_period: evidence.reporting_period,
    observed_value: typeof evidence.value_numeric === 'number' && Number.isFinite(evidence.value_numeric) ? evidence.value_numeric : null,
  };
  if (!isVerified(evidence.verification_status)) return { ...explanation, reason: 'unverified_evidence' };
  if (explanation.observed_value === null || evidence.unit !== 'percent'
    || reportingYear(evidence.reporting_period) === null
    || !evidence.id.trim() || !evidence.source_name.trim() || !evidence.source_url.trim()
    || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1
    || evidence.product_id != null || evidence.brand_id != null
    || evidence.value_text != null || evidence.value_boolean != null) {
    return { ...explanation, reason: 'invalid_evidence' };
  }
  const passes = explanation.observed_value <= rule.threshold_numeric!;
  return { ...explanation, result: passes ? 'PASS' : 'FAIL', reason: passes ? 'threshold_met' : 'threshold_exceeded' };
}
