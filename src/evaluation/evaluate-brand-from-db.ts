import { z } from 'zod';
import type { ReadDatabase } from '../db/database.js';
import { brandRow, DataError, entityRow, evidenceRow, parseRows, relationshipRow } from '../db/rows.js';
import type { SelectedPolicy } from '../policies/service.js';
import { DEMO_RULE } from '../demo/catalog.js';
import { evaluateRule } from './evaluate-rule.js';
import { MIN_RELATIONSHIP_CONFIDENCE } from './evaluate-product.js';
import { isCalendarDate, isVerified, reportingYear } from './types.js';
import type { RuleEvaluation } from './types.js';

export const BRAND_EVALUATION_SCOPE = 'Evaluation applies to the verified UK commerce entity associated with the brand; it does not assert that this entity is the ultimate parent, manufacturer, brand owner, or employer unless separately evidenced.';
const commerceRoles = new Set(['seller', 'site_operator', 'operated_by']);
export interface BrandPolicyEvaluation {
  policy_id: string | null;
  policy_name: string | null;
  operator: string;
  brand: string;
  brand_id: string | null;
  relationship_type: string | string[] | null;
  relationship_ids: string[];
  legal_entity: string | null;
  legal_entity_id: string | null;
  company_number: string | null;
  relationship_verification_status: 'human_verified' | null;
  criterion: string;
  threshold: number | null;
  observed_value: number | null;
  reporting_period: string | null;
  evidence_source: RuleEvaluation['evidence_source'];
  evidence_id: string | null;
  final_status: RuleEvaluation['result'];
  reason: string;
  scope: string;
}

/** Read-only brand adapter; does not invoke resolution, persist results or change evidence. */
export async function evaluateBrandFromDb(db: ReadDatabase, brandName: string, asOf: string, policy?: SelectedPolicy): Promise<BrandPolicyEvaluation> {
  const name = brandName.trim();
  if (!name || !isCalendarDate(asOf)) throw new DataError('A brand name and valid evaluation date are required.');
  const rule = policy?.rule ?? DEMO_RULE;
  const output: BrandPolicyEvaluation = { policy_id: policy?.id ?? null, policy_name: policy?.name ?? null, operator: rule.operator, brand: name, brand_id: null, relationship_type: null, relationship_ids: [],
    legal_entity: null, legal_entity_id: null, company_number: null, relationship_verification_status: null,
    criterion: rule.criterion, threshold: rule.threshold_numeric, observed_value: null, reporting_period: null,
    evidence_source: null, evidence_id: null, final_status: 'UNKNOWN', reason: 'brand_not_found', scope: BRAND_EVALUATION_SCOPE };
  if (policy?.problem) return { ...output, reason: policy.problem };
  const brands = parseRows(brandRow, await db.read('brands', { canonical_name: name }), 'brands');
  if (!brands.length) return output;
  if (brands.length > 1) return { ...output, reason: 'ambiguous_brand' };
  const brand = brands[0]!;
  output.brand = brand.canonical_name; output.brand_id = brand.id;
  const relationships = parseRows(relationshipRow, await db.read('brand_entity_relationships', { brand_id: brand.id, verification_status: 'human_verified' }), 'relationships')
    .filter(link => link.brand_id === brand.id && link.verification_status === 'human_verified' && commerceRoles.has(link.relationship_type)
      && Number.isFinite(link.confidence) && link.confidence >= MIN_RELATIONSHIP_CONFIDENCE && link.confidence <= 1
      && (link.valid_from === null || (isCalendarDate(link.valid_from) && link.valid_from <= asOf))
      && (link.valid_to === null || (isCalendarDate(link.valid_to) && link.valid_to >= asOf))
      && (link.valid_from === null || link.valid_to === null || link.valid_to >= link.valid_from));
  const entities = [];
  for (const id of new Set(relationships.map(link => link.legal_entity_id))) {
    const found = parseRows(entityRow.extend({ jurisdiction: z.string() }), await db.read('legal_entities', { id, jurisdiction: 'GB' }), 'legal entities');
    if (found.length > 1) throw new DataError('Duplicate legal entity identity.');
    if (found[0]?.id === id && found[0].jurisdiction === 'GB') entities.push(found[0]);
  }
  if (!entities.length) return { ...output, reason: 'no_verified_commerce_entity' };
  if (entities.length > 1) return { ...output, reason: 'ambiguous_legal_entity' };
  const entity = entities[0]!;
  const links = relationships.filter(link => link.legal_entity_id === entity.id);
  const roles = [...new Set(links.map(link => link.relationship_type))].sort();
  Object.assign(output, { legal_entity: entity.canonical_name, legal_entity_id: entity.id, company_number: entity.company_number,
    relationship_type: roles.length === 1 ? roles[0]! : roles, relationship_ids: links.map(link => link.id).sort(), relationship_verification_status: 'human_verified' });
  const verified = parseRows(evidenceRow, await db.read('evidence', { legal_entity_id: entity.id, claim_type: rule.criterion }), 'evidence')
    .filter(item => item.legal_entity_id === entity.id && item.claim_type === rule.criterion && isVerified(item.verification_status));
  if (!verified.length || verified.some(item => reportingYear(item.reporting_period) === null)) return { ...output, reason: 'missing_evidence' };
  const latestYear = Math.max(...verified.map(item => reportingYear(item.reporting_period)!));
  const latest = verified.filter(item => reportingYear(item.reporting_period) === latestYear);
  if (latest.length > 1) return { ...output, reason: 'ambiguous_evidence' };
  // Select before validating, as in the existing evaluator: invalid latest evidence
  // must not cause a fallback to an older passing value.
  const evaluated = evaluateRule(rule, latest[0]!, { legal_entity_id: entity.id, relationship_verified: true });
  return { ...output, observed_value: evaluated.observed_value, reporting_period: evaluated.reporting_period,
    evidence_source: evaluated.evidence_source, evidence_id: evaluated.evidence_id, final_status: evaluated.result,
    reason: evaluated.result === 'UNKNOWN' ? 'missing_evidence' : evaluated.reason };
}
